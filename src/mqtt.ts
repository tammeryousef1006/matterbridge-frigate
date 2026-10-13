/**
 * Minimal MQTT 3.1.1 client (subscribe only, QoS 0), enough to follow Frigate's topics without a dependency.
 * Plain TCP or TLS (mqtts), user/password, keep-alive pings, reconnect with a growing pause (2 s .. 60 s).
 */
import * as net from 'node:net';
import * as tls from 'node:tls';

export interface MqttOptions {
  host: string;
  port?: number;
  tls?: boolean;
  username?: string;
  password?: string;
  clientId?: string;
  keepAliveSeconds?: number;
}

type Log = (level: 'info' | 'warn' | 'debug', message: string) => void;

const CONNACK_ERRORS: Record<number, string> = {
  1: 'unacceptable protocol version',
  2: 'client id rejected',
  3: 'broker unavailable',
  4: 'wrong user name or password',
  5: 'not authorized',
};

function utf8(text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  return Buffer.concat([length, data]);
}

function remainingLength(n: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
}

const packet = (type: number, flags: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([(type << 4) | flags]), remainingLength(body.length), body]);

export class MqttClient {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private ping?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private attempts = 0;
  private stopped = false;
  private packetId = 1;
  private lastHeard = 0;
  connected = false;
  /** Last connection problem, for the plugin page. */
  lastError?: string;

  constructor(
    private readonly options: MqttOptions,
    private readonly topics: string[],
    private readonly onMessage: (topic: string, payload: Buffer) => void,
    private readonly log: Log,
    private readonly onState?: (connected: boolean) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    if (this.socket) {
      try {
        this.socket.write(Buffer.from([0xe0, 0x00])); // DISCONNECT
      } catch {
        // already closed
      }
      this.socket.destroy();
    }
    this.socket = undefined;
    this.setConnected(false);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.onState?.(value);
  }

  private get port(): number {
    return this.options.port ?? (this.options.tls ? 8883 : 1883);
  }

  private connect(): void {
    const port = this.port;
    const keepAlive = this.options.keepAliveSeconds ?? 30;
    const socket = this.options.tls ? tls.connect({ host: this.options.host, port, rejectUnauthorized: false, servername: net.isIP(this.options.host) ? undefined : this.options.host }) : net.connect({ host: this.options.host, port });
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(new Error(`no answer from ${this.options.host}:${port} within 8 s`)), 8000);
    socket.once(this.options.tls ? 'secureConnect' : 'connect', () => {
      let flags = 0x02; // clean session
      const payload = [utf8(this.options.clientId ?? `matterbridge-frigate-${Math.random().toString(16).slice(2, 10)}`)];
      if (this.options.username) {
        flags |= 0x80;
        payload.push(utf8(this.options.username));
        if (this.options.password) {
          flags |= 0x40;
          payload.push(utf8(this.options.password));
        }
      }
      const keep = Buffer.alloc(2);
      keep.writeUInt16BE(keepAlive);
      socket.write(packet(1, 0, Buffer.concat([utf8('MQTT'), Buffer.from([4, flags]), keep, ...payload])));
    });
    socket.on('data', (data) => {
      clearTimeout(timer);
      this.lastHeard = Date.now();
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
      this.parse();
    });
    socket.on('error', (error) => {
      this.lastError = error.message;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      clearInterval(this.ping);
      if (this.socket !== socket) return;
      this.socket = undefined;
      const was = this.connected;
      this.setConnected(false);
      if (this.stopped) return;
      const wait = Math.min(60, 2 * 2 ** Math.min(this.attempts, 5));
      this.attempts++;
      this.log(was ? 'warn' : 'debug', `MQTT ${this.options.host}:${port} ${was ? 'connection lost' : 'not connected'}${this.lastError ? ` (${this.lastError})` : ''}; trying again in ${wait} s`);
      this.retry = setTimeout(() => this.connect(), wait * 1000);
    });
    clearInterval(this.ping);
    this.ping = setInterval(() => {
      if (!this.connected) return;
      // no answer to two pings: the broker is gone without closing the connection
      if (Date.now() - this.lastHeard > keepAlive * 2000) {
        this.lastError = 'broker stopped answering';
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([0xc0, 0x00])); // PINGREQ
    }, (keepAlive * 1000) / 2);
  }

  private parse(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      let multiplier = 1;
      let length = 0;
      let i = 1;
      let byte: number;
      do {
        if (i >= this.buffer.length) return;
        byte = this.buffer[i++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
      } while (byte & 0x80 && i < 5);
      if (this.buffer.length < i + length) return;
      const type = this.buffer[0] >> 4;
      const flags = this.buffer[0] & 0x0f;
      const body = this.buffer.subarray(i, i + length);
      this.buffer = this.buffer.subarray(i + length);
      this.handle(type, flags, body);
    }
  }

  private handle(type: number, flags: number, body: Buffer): void {
    if (type === 2) {
      // CONNACK
      const code = body[1];
      if (code !== 0) {
        this.lastError = `broker refused the connection: ${CONNACK_ERRORS[code] ?? `code ${code}`}`;
        this.log('warn', `MQTT: ${this.lastError}`);
        this.socket?.destroy();
        return;
      }
      this.attempts = 0;
      this.lastError = undefined;
      this.setConnected(true);
      this.log('info', `MQTT connected to ${this.options.host}:${this.port}, subscribing to ${this.topics.join(', ')}`);
      const id = Buffer.alloc(2);
      id.writeUInt16BE(this.packetId++ & 0xffff || 1);
      this.socket?.write(packet(8, 2, Buffer.concat([id, ...this.topics.map((t) => Buffer.concat([utf8(t), Buffer.from([0])]))])));
    } else if (type === 3) {
      // PUBLISH
      const qos = (flags >> 1) & 3;
      const topicLength = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + topicLength).toString('utf8');
      let offset = 2 + topicLength;
      if (qos > 0) {
        const id = body.subarray(offset, offset + 2);
        offset += 2;
        // acknowledge QoS 1 (PUBACK); QoS 2 is not used by this subscription (granted QoS 0)
        if (qos === 1) this.socket?.write(packet(4, 0, Buffer.from(id)));
      }
      try {
        this.onMessage(topic, Buffer.from(body.subarray(offset)));
      } catch (error) {
        this.log('warn', `MQTT message on ${topic} not handled: ${String(error)}`);
      }
    } else if (type === 9) {
      // SUBACK
      if ([...body.subarray(2)].some((code) => code === 0x80)) this.log('warn', 'MQTT: the broker refused a subscription (check the user rights)');
    }
  }
}
