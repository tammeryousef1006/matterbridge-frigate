/**
 * Frigate's detections, from MQTT (when the MQTT settings are filled) or else from Frigate's own WebSocket (/ws),
 * which carries the same messages. Both end up in one place: per camera, which tracked objects are active, and
 * whether Frigate sees motion.
 *
 * Topics used (MQTT: <prefix>/<topic>; WebSocket: {"topic": "<topic>", "payload": ...}):
 * - events               {"type": "new"|"update"|"end", "after": {id, camera, label, score, current_zones, stationary, false_positive}}
 * - <camera>/motion      "ON" / "OFF" (pixel motion, optional for Matter)
 * - available            "online" / "offline" (MQTT only)
 */
import { FrigateClient } from './frigate.js';
import { MqttClient, MqttOptions } from './mqtt.js';
import { WebSocketClient } from './ws.js';

export interface FrigateObjectEvent {
  type: 'new' | 'update' | 'end';
  id: string;
  camera: string;
  label: string;
  subLabel?: string;
  score?: number;
  zones: string[];
  stationary: boolean;
  falsePositive: boolean;
}

export interface DetectionListener {
  onObject(event: FrigateObjectEvent): void;
  onMotion(camera: string, active: boolean): void;
}

type Log = (level: 'info' | 'warn' | 'debug', message: string) => void;

/** One "events" payload (MQTT or WebSocket) to an object event. */
export function parseEvent(payload: unknown): FrigateObjectEvent | undefined {
  const data = (typeof payload === 'string' ? JSON.parse(payload) : payload) as { type?: string; after?: Record<string, unknown>; before?: Record<string, unknown> };
  const after = data?.after ?? data?.before;
  if (!after || typeof after.camera !== 'string' || typeof after.label !== 'string') return undefined;
  const type = data.type === 'new' || data.type === 'end' ? data.type : 'update';
  const subLabel = Array.isArray(after.sub_label) ? String(after.sub_label[0] ?? '') : typeof after.sub_label === 'string' ? after.sub_label : undefined;
  return {
    type,
    id: String(after.id ?? `${after.camera}-${after.label}`),
    camera: after.camera,
    label: after.label,
    subLabel: subLabel || undefined,
    score: typeof after.top_score === 'number' ? after.top_score : typeof after.score === 'number' ? after.score : undefined,
    zones: Array.isArray(after.current_zones) ? after.current_zones.map(String) : [],
    stationary: after.stationary === true,
    falsePositive: after.false_positive === true,
  };
}

/** Where the detections come from right now, for the log and the plugin page. */
export interface DetectionStatus {
  via: 'mqtt' | 'websocket' | 'none';
  connected: boolean;
  target: string;
  error?: string;
  messages: number;
  lastMessageAt?: number;
}

export class DetectionFeed {
  private mqtt?: MqttClient;
  private ws?: WebSocketClient;
  private wsRetry?: NodeJS.Timeout;
  private wsAttempts = 0;
  private stopped = false;
  readonly status: DetectionStatus = { via: 'none', connected: false, target: '', messages: 0 };

  constructor(
    private readonly listener: DetectionListener,
    private readonly log: Log,
  ) {}

  /** MQTT when the settings give a broker, else Frigate's WebSocket. */
  start(options: { mqtt?: MqttOptions & { prefix?: string }; frigate: FrigateClient }): void {
    this.stopped = false;
    if (options.mqtt?.host) this.startMqtt(options.mqtt);
    else this.startWebSocket(options.frigate);
  }

  private prefix = 'frigate';

  /** Send a command topic to Frigate (e.g. "<camera>/ptz"), over MQTT or the WebSocket. False when not connected. */
  send(topic: string, payload: string): boolean {
    if (this.mqtt) return this.mqtt.publish(`${this.prefix}/${topic}`, payload);
    if (!this.ws || !this.status.connected) return false;
    this.ws.send(JSON.stringify({ topic, payload }));
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.mqtt?.stop();
    clearTimeout(this.wsRetry);
    this.ws?.close();
    this.ws = undefined;
  }

  private received(topic: string, payload: unknown): void {
    this.status.messages++;
    this.status.lastMessageAt = Date.now();
    if (topic === 'events') {
      const event = parseEvent(payload);
      if (event) this.listener.onObject(event);
      return;
    }
    const motion = /^([^/]+)\/motion$/.exec(topic);
    if (motion) {
      const text = String(payload).trim().toUpperCase();
      if (text === 'ON' || text === 'OFF') this.listener.onMotion(motion[1], text === 'ON');
    }
  }

  private startMqtt(options: MqttOptions & { prefix?: string }): void {
    const prefix = (options.prefix || 'frigate').replace(/\/+$/, '');
    this.prefix = prefix;
    this.status.via = 'mqtt';
    this.status.target = `${options.host}:${options.port ?? (options.tls ? 8883 : 1883)} (${prefix}/#)`;
    this.mqtt = new MqttClient(
      options,
      [`${prefix}/events`, `${prefix}/+/motion`, `${prefix}/available`],
      (topic, payload) => {
        const short = topic.startsWith(`${prefix}/`) ? topic.slice(prefix.length + 1) : topic;
        if (short === 'available') {
          this.log(payload.toString() === 'online' ? 'info' : 'warn', `Frigate says it is ${payload.toString()} (MQTT)`);
          return;
        }
        try {
          this.received(short, payload.toString('utf8'));
        } catch (error) {
          this.log('debug', `MQTT ${topic}: ${String(error)}`);
        }
      },
      this.log,
      (connected) => {
        this.status.connected = connected;
        this.status.error = connected ? undefined : this.mqtt?.lastError;
      },
    );
    this.mqtt.start();
  }

  private startWebSocket(frigate: FrigateClient): void {
    this.status.via = 'websocket';
    const url = `${frigate.secure ? 'wss' : 'ws'}://${frigate.address.host}:${frigate.address.port}/ws`;
    this.status.target = url;
    const connect = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        if (frigate.secure && !frigate.cookie) await frigate.login();
        let ws: WebSocketClient;
        try {
          ws = await WebSocketClient.connect(url, frigate.cookie ? { Cookie: frigate.cookie } : {});
        } catch (error) {
          // an expired login: log in again once
          if (frigate.secure && /401/.test(String(error))) {
            await frigate.login();
            ws = await WebSocketClient.connect(url, frigate.cookie ? { Cookie: frigate.cookie } : {});
          } else throw error;
        }
        if (this.stopped) {
          ws.close();
          return;
        }
        this.ws = ws;
        this.wsAttempts = 0;
        this.status.connected = true;
        this.status.error = undefined;
        this.log('info', `Frigate WebSocket connected (${url}): following detections`);
        ws.onMessage = (text) => {
          try {
            const message = JSON.parse(text) as { topic?: string; payload?: unknown };
            if (typeof message.topic === 'string') this.received(message.topic, message.payload);
          } catch {
            // not a JSON message
          }
        };
        ws.onClose = (reason) => {
          if (this.ws !== ws) return;
          this.ws = undefined;
          this.status.connected = false;
          this.status.error = reason;
          if (!this.stopped) {
            this.log('warn', `Frigate WebSocket closed (${reason}); reconnecting`);
            retry();
          }
        };
      } catch (error) {
        this.status.connected = false;
        this.status.error = error instanceof Error ? error.message : String(error);
        this.log(this.wsAttempts ? 'debug' : 'warn', `Frigate WebSocket ${url} not available: ${this.status.error}`);
        retry();
      }
    };
    const retry = (): void => {
      clearTimeout(this.wsRetry);
      const wait = Math.min(60, 2 * 2 ** Math.min(this.wsAttempts, 5));
      this.wsAttempts++;
      this.wsRetry = setTimeout(() => void connect(), wait * 1000);
    };
    void connect();
  }
}

/**
 * One camera's detections as Matter motion: occupied while any object it cares about is active (moving, not a
 * false positive, in the chosen zones), or, when chosen, while Frigate sees pixel motion.
 * An object Frigate forgets to end clears by itself after `staleMs` without news.
 */
export class CameraDetections {
  private readonly objects = new Map<string, { label: string; timer: NodeJS.Timeout }>();
  private motion = false;
  private motionTimer?: NodeJS.Timeout;
  private occupied = false;
  /** Recent detections (newest last) for the plugin page. */
  readonly recent: { at: number; kind: string; text: string; active: boolean }[] = [];

  constructor(
    readonly camera: string,
    private readonly options: { labels: string[]; zones: string[]; useMotion: boolean; staleMs?: number },
    private readonly onChange: (occupied: boolean, reason: string) => void,
  ) {}

  private note(kind: string, text: string, active: boolean): void {
    this.recent.push({ at: Date.now(), kind, text, active });
    while (this.recent.length > 40 || (this.recent.length && this.recent[0].at < Date.now() - 10 * 60_000)) this.recent.shift();
  }

  /** Whether an object event counts for this camera's settings. */
  wanted(event: FrigateObjectEvent): boolean {
    if (event.falsePositive) return false;
    if (this.options.labels.length && !this.options.labels.includes(event.label)) return false;
    if (this.options.zones.length && !event.zones.some((z) => this.options.zones.includes(z))) return false;
    return true;
  }

  onObject(event: FrigateObjectEvent): void {
    const known = this.objects.get(event.id);
    const active = event.type !== 'end' && !event.stationary && this.wanted(event);
    if (active) {
      clearTimeout(known?.timer);
      const timer = setTimeout(() => {
        this.objects.delete(event.id);
        this.update(`${event.label} (no news)`);
      }, this.options.staleMs ?? 180_000);
      this.objects.set(event.id, { label: event.label, timer });
      if (!known) this.note('object', `${event.label}${event.subLabel ? ` (${event.subLabel})` : ''}${event.score ? ` ${Math.round(event.score * 100)}%` : ''}${event.zones.length ? ` in ${event.zones.join(', ')}` : ''}`, true);
    } else if (known) {
      clearTimeout(known.timer);
      this.objects.delete(event.id);
      this.note('object', `${event.label} ${event.type === 'end' ? 'gone' : event.stationary ? 'stationary' : 'left the zones'}`, false);
    }
    this.update(event.label);
  }

  onMotion(active: boolean): void {
    if (!this.options.useMotion) return;
    if (active !== this.motion) this.note('motion', 'motion', active);
    this.motion = active;
    clearTimeout(this.motionTimer);
    if (active) this.motionTimer = setTimeout(() => this.onMotion(false), 120_000);
    this.update('motion');
  }

  private update(reason: string): void {
    const now = this.objects.size > 0 || this.motion;
    if (now === this.occupied) return;
    this.occupied = now;
    const what = [...new Set([...this.objects.values()].map((o) => o.label))];
    if (this.motion) what.push('motion');
    this.onChange(now, now ? what.join(', ') || reason : reason);
  }

  /** Lost the event feed: nothing is known to be active any more. */
  reset(): void {
    for (const o of this.objects.values()) clearTimeout(o.timer);
    this.objects.clear();
    clearTimeout(this.motionTimer);
    this.motion = false;
    this.update('event feed lost');
  }

  get active(): boolean {
    return this.occupied;
  }

  stop(): void {
    for (const o of this.objects.values()) clearTimeout(o.timer);
    this.objects.clear();
    clearTimeout(this.motionTimer);
  }
}
