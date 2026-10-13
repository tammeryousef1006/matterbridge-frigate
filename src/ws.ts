/**
 * Minimal WebSocket client (RFC 6455, text messages) for Frigate's /ws, without a dependency and the same on
 * Node and Bun: HTTP(S) upgrade with our own headers (the login cookie on port 8971), masked client frames,
 * ping/pong, fragmented messages.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';

export class WebSocketClient {
  private socket?: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  onMessage?: (text: string) => void;
  onClose?: (reason: string) => void;
  private closed = false;

  /** Connects and resolves once the upgrade is accepted. */
  static connect(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<WebSocketClient> {
    const target = new URL(url);
    const secure = target.protocol === 'wss:' || target.protocol === 'https:';
    const key = crypto.randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const request = (secure ? https : http).request({
        host: target.hostname,
        port: Number(target.port) || (secure ? 443 : 80),
        path: target.pathname + target.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...headers },
        // Frigate's port 8971 has a self-signed certificate unless one was installed
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });
      request.on('timeout', () => request.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      request.on('error', reject);
      request.on('response', (res) => {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}${res.statusCode === 401 ? ' (login needed or expired)' : ''}`));
      });
      request.on('upgrade', (res, socket, head) => {
        const expected = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        if (res.headers['sec-websocket-accept'] !== expected) {
          socket.destroy();
          reject(new Error('the server did not accept the WebSocket'));
          return;
        }
        const client = new WebSocketClient();
        client.attach(socket, head);
        resolve(client);
      });
      request.end();
    });
  }

  private attach(socket: Duplex, head: Buffer): void {
    this.socket = socket;
    socket.on('data', (data: Buffer) => this.onData(data));
    socket.on('close', () => this.finish('connection closed'));
    socket.on('error', (error: Error) => this.finish(error.message));
    if (head.length) this.onData(head);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }

  send(text: string): void {
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  close(): void {
    if (this.closed) return;
    this.write(0x8, Buffer.alloc(0));
    this.closed = true;
    setTimeout(() => this.socket?.destroy(), 200);
  }

  private write(opcode: number, payload: Buffer): void {
    if (!this.socket || this.closed) return;
    const mask = crypto.randomBytes(4);
    const n = payload.length;
    const header = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(n));
      return b;
    })()]);
    const masked = Buffer.alloc(n);
    for (let i = 0; i < n; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private onData(data: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : undefined;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      if (opcode === 0x8) {
        this.close();
        this.finish('closed by the server');
        return;
      }
      if (opcode === 0x9) {
        this.write(0xa, payload); // pong
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.fragments.push(payload);
        if (!fin) continue;
        payload = Buffer.concat(this.fragments);
        this.fragments = [];
        try {
          this.onMessage?.(payload.toString('utf8'));
        } catch {
          // a bad message must not stop the connection
        }
      }
    }
  }
}
