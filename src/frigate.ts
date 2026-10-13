/**
 * Frigate NVR: its HTTP API (port 5000 without login, or 8971 with login over HTTPS), finding it on the network,
 * and what the plugin takes from its config: the cameras, their go2rtc restreams and the MQTT settings.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';

export interface FrigateAddress {
  host: string;
  port: number;
  /** HTTPS (port 8971, Frigate's authenticated port). Default: by the port. */
  https?: boolean;
  username?: string;
  password?: string;
}

export interface HttpAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export const isHttps = (address: FrigateAddress): boolean => address.https ?? address.port === 8971;
export const baseUrl = (address: FrigateAddress): string => `${isHttps(address) ? 'https' : 'http'}://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`;

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<HttpAnswer> {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.body) headers['Content-Length'] = String(Buffer.byteLength(options.body));
    // Frigate's port 8971 has a self-signed certificate unless one was installed: the address is the user's own NVR
    const req = lib.request(target, { method: options.method ?? 'GET', headers, timeout: options.timeoutMs ?? 8000, rejectUnauthorized: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${options.timeoutMs ?? 8000} ms`)));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ----- the parts of Frigate's /api/config the plugin uses -----

export interface FrigateCameraConfig {
  enabled?: boolean;
  enabled_in_config?: boolean;
  detect?: { width?: number; height?: number; fps?: number; enabled?: boolean };
  ffmpeg?: { inputs?: { path?: string; roles?: string[] }[] };
  /** 0.15+: { "Main": "front_door", "Sub": "front_door_sub" }; 0.14: stream_name */
  live?: { streams?: Record<string, string> | string[]; stream_name?: string; height?: number };
  objects?: { track?: string[] };
  zones?: Record<string, unknown>;
  audio?: { enabled?: boolean };
  onvif?: { host?: string; port?: number; autotracking?: { enabled?: boolean } };
  record?: { enabled?: boolean };
  ui?: { order?: number; dashboard?: boolean };
  friendly_name?: string;
}

export interface FrigateConfig {
  cameras?: Record<string, FrigateCameraConfig>;
  go2rtc?: { streams?: Record<string, string | string[]>; rtsp?: { username?: string; password?: string; listen?: string } };
  mqtt?: { enabled?: boolean; host?: string; port?: number; topic_prefix?: string; user?: string; client_id?: string };
  auth?: { enabled?: boolean };
  version?: string;
}

/** One go2rtc restream a camera can be shown with. */
export interface StreamCandidate {
  /** go2rtc stream name (rtsp://frigate:8554/<name>). */
  name: string;
  /** How Frigate labels it (live.streams key), if it does. */
  label?: string;
}

export interface FrigateCamera {
  name: string;
  /** Frigate's friendly name (0.16+), else the camera name. */
  title: string;
  enabled: boolean;
  detectWidth?: number;
  detectHeight?: number;
  objects: string[];
  zones: string[];
  streams: StreamCandidate[];
  /** Frigate controls this camera over ONVIF (it may have PTZ). */
  onvif: boolean;
  /** Frigate's PTZ autotracking is on. */
  autotracking: boolean;
}

/** Cameras from Frigate's config, in its UI order, with the go2rtc streams that belong to each. */
export function camerasFromConfig(config: FrigateConfig): FrigateCamera[] {
  const go2rtc = Object.keys(config.go2rtc?.streams ?? {});
  const list = Object.entries(config.cameras ?? {}).map(([name, camera]) => {
    const streams: StreamCandidate[] = [];
    const add = (stream: string | undefined, label?: string): void => {
      if (stream && !streams.some((s) => s.name === stream)) streams.push({ name: stream, label });
    };
    const live = camera.live?.streams;
    if (Array.isArray(live)) live.forEach((s) => add(s));
    else if (live) for (const [label, stream] of Object.entries(live)) add(stream, label);
    add(camera.live?.stream_name);
    if (go2rtc.includes(name)) add(name);
    // the usual naming for a camera's second stream
    for (const suffix of ['_sub', '_low', '_lq', '-sub', '_hd', '_main', '_high']) if (go2rtc.includes(name + suffix)) add(name + suffix);
    // only streams go2rtc really has (0.14 sets stream_name to the camera name even without a restream)
    const real = streams.filter((s) => go2rtc.includes(s.name));
    return {
      name,
      title: camera.friendly_name || name.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()),
      enabled: camera.enabled !== false,
      detectWidth: camera.detect?.width,
      detectHeight: camera.detect?.height,
      objects: camera.objects?.track ?? ['person'],
      zones: Object.keys(camera.zones ?? {}),
      streams: real,
      onvif: !!camera.onvif?.host,
      autotracking: camera.onvif?.autotracking?.enabled === true,
      order: camera.ui?.order ?? 0,
    };
  });
  return list.sort((a, b) => a.order - b.order).map(({ order: _order, ...camera }) => camera);
}

/** Frigate's own MQTT settings (the password is never in /api/config), as a hint for the plugin settings. */
export function mqttHint(config: FrigateConfig): { host: string; port: number; prefix: string; user?: string } | undefined {
  const mqtt = config.mqtt;
  if (!mqtt || mqtt.enabled === false || !mqtt.host) return undefined;
  return { host: mqtt.host, port: mqtt.port ?? 1883, prefix: mqtt.topic_prefix ?? 'frigate', user: mqtt.user || undefined };
}

// ----- the API client -----

export class FrigateClient {
  private token?: string;
  private loggingIn?: Promise<void>;
  version?: string;

  constructor(readonly address: FrigateAddress) {}

  get url(): string {
    return baseUrl(this.address);
  }

  get secure(): boolean {
    return isHttps(this.address);
  }

  /** The login cookie for requests on port 8971 (also used by the WebSocket). */
  get cookie(): string | undefined {
    return this.token ? `frigate_token=${this.token}` : undefined;
  }

  /** Log in (port 8971): POST /api/login answers with the frigate_token cookie. */
  async login(): Promise<void> {
    if (!this.address.username) throw new Error('Frigate asks for a login: enter the Frigate user and password in the settings');
    this.loggingIn ??= (async () => {
      const answer = await request(`${this.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: this.address.username, password: this.address.password ?? '' }) });
      const cookies = ([] as string[]).concat(answer.headers['set-cookie'] ?? []);
      const token = cookies.map((c) => /frigate_token=([^;]+)/.exec(c)?.[1]).find(Boolean);
      if (answer.status === 401 || answer.status === 400) throw new Error('Frigate refused the login: check the Frigate user and password');
      if (answer.status === 429) throw new Error('Frigate refused the login: too many attempts, wait a minute');
      if (answer.status >= 300 || !token) throw new Error(`Frigate login failed (HTTP ${answer.status})`);
      this.token = token;
    })().finally(() => {
      this.loggingIn = undefined;
    });
    return this.loggingIn;
  }

  /** GET (or POST) an API path; logs in first and again when the login has expired. */
  async fetch(path: string, options: { method?: string; body?: string; timeoutMs?: number } = {}): Promise<HttpAnswer> {
    const send = (): Promise<HttpAnswer> =>
      request(`${this.url}${path}`, { ...options, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    let answer = await send();
    if (answer.status === 401 && this.address.username) {
      this.token = undefined;
      await this.login();
      answer = await send();
    }
    if (answer.status === 401) throw new Error('Frigate asks for a login: enter the Frigate user and password, or use port 5000');
    return answer;
  }

  async json<T>(path: string): Promise<T> {
    const answer = await this.fetch(path);
    if (answer.status !== 200) throw new Error(`${path} answered HTTP ${answer.status}`);
    return JSON.parse(answer.body.toString('utf8')) as T;
  }

  async getVersion(): Promise<string> {
    const answer = await this.fetch('/api/version', { timeoutMs: 5000 });
    if (answer.status !== 200) throw new Error(`/api/version answered HTTP ${answer.status}`);
    const text = answer.body.toString('utf8').trim().replace(/^"|"$/g, '');
    if (!/^\d+\.\d+/.test(text)) throw new Error(`this does not look like Frigate (/api/version: ${text.slice(0, 40)})`);
    this.version = text;
    return text;
  }

  getConfig(): Promise<FrigateConfig> {
    return this.json<FrigateConfig>('/api/config');
  }

  /** The latest frame Frigate has of a camera (its detect stream), as JPEG. */
  async latestJpeg(camera: string, height?: number, quality = 70): Promise<Buffer> {
    const query = new URLSearchParams({ quality: String(quality) });
    if (height) {
      query.set('height', String(height));
      query.set('h', String(height)); // older Frigate versions
    }
    const answer = await this.fetch(`/api/${encodeURIComponent(camera)}/latest.jpg?${query}`, { timeoutMs: 6000 });
    if (answer.status !== 200 || answer.body[0] !== 0xff || answer.body[1] !== 0xd8) throw new Error(`latest.jpg answered HTTP ${answer.status}`);
    return answer.body;
  }

  /** PTZ features and presets of a camera that Frigate controls over ONVIF (empty when it has none). */
  async ptzInfo(camera: string): Promise<{ features: string[]; presets: string[] }> {
    const answer = await this.fetch(`/api/${encodeURIComponent(camera)}/ptz/info`, { timeoutMs: 10000 });
    if (answer.status !== 200) return { features: [], presets: [] };
    const data = JSON.parse(answer.body.toString('utf8') || '{}') as { features?: unknown; presets?: unknown };
    return {
      features: Array.isArray(data.features) ? data.features.map(String) : [],
      presets: Array.isArray(data.presets) ? data.presets.map(String) : [],
    };
  }

  /** go2rtc's view of the streams (codecs of the producers), through Frigate's API. */
  async go2rtcStreams(): Promise<Record<string, { producers?: { url?: string; medias?: string[] }[] }> | undefined> {
    try {
      return await this.json('/api/go2rtc/streams');
    } catch {
      return undefined;
    }
  }
}

// ----- finding Frigate -----

export interface FoundFrigate {
  host: string;
  port: number;
  https: boolean;
  version?: string;
  /** Port 8971 answers but needs a login before it tells its version. */
  needsLogin?: boolean;
}

function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Is Frigate at this address? Port 5000: /api/version; 8971: the version, or a login request from Frigate's API. */
export async function checkFrigate(host: string, port: number): Promise<FoundFrigate | undefined> {
  const secure = port === 8971;
  try {
    const answer = await request(`${baseUrl({ host, port })}/api/version`, { timeoutMs: 3000 });
    const text = answer.body.toString('utf8').trim().replace(/^"|"$/g, '');
    if (answer.status === 200 && /^\d+\.\d+/.test(text)) return { host, port, https: secure, version: text };
    if (secure && answer.status === 401) {
      // Frigate's nginx answers 401 on the API without the login cookie; its login page names Frigate
      const page = await request(`${baseUrl({ host, port })}/login`, { timeoutMs: 3000 }).catch(() => undefined);
      if (page && /frigate/i.test(page.body.toString('utf8'))) return { host, port, https: true, needsLogin: true };
    }
  } catch {
    // not Frigate
  }
  return undefined;
}

/** The local IPv4 networks to search (only the /24 around each address, at most 4 networks). */
export function localNetworks(): { address: string; base: string }[] {
  const seen = new Set<string>();
  const out: { address: string; base: string }[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      // Docker bridges and link-local: not where an NVR is
      if (/^169\.254\./.test(i.address) || /^172\.(1[7-9]|2\d|3[01])\./.test(i.address)) continue;
      const base = i.address.split('.').slice(0, 3).join('.');
      if (seen.has(base)) continue;
      seen.add(base);
      out.push({ address: i.address, base });
    }
  }
  return out.slice(0, 4);
}

/**
 * Look for Frigate: this machine and the usual host names first (Frigate often runs next to Matterbridge),
 * then every address of the local /24 networks on ports 5000 and 8971.
 */
export async function discoverFrigate(log: (message: string) => void = () => undefined, timeoutMs = 400): Promise<FoundFrigate[]> {
  const found: FoundFrigate[] = [];
  const add = (f?: FoundFrigate): void => {
    if (f && !found.some((x) => x.host === f.host && x.port === f.port)) found.push(f);
  };
  const networks = localNetworks();
  const candidates = ['127.0.0.1', 'frigate', 'frigate.local', ...networks.map((n) => n.address)];
  for (const host of candidates) for (const port of [5000, 8971]) if (await portOpen(host, port, timeoutMs)) add(await checkFrigate(host, port));
  if (found.length) log(`Frigate found on this machine or by name: ${found.map((f) => `${f.host}:${f.port}`).join(', ')}`);
  const targets: string[] = [];
  for (const n of networks) for (let i = 1; i < 255; i++) targets.push(`${n.base}.${i}`);
  log(`Scanning ${targets.length} addresses (${networks.map((n) => `${n.base}.0/24`).join(', ') || 'no network'}) on ports 5000 and 8971 ...`);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < targets.length) {
      const host = targets[index++];
      for (const port of [5000, 8971]) if (await portOpen(host, port, timeoutMs)) add(await checkFrigate(host, port));
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  // the same Frigate by several addresses: keep the LAN address over 127.0.0.1 (it stays right if Matterbridge moves)
  const lan = found.filter((f) => f.host !== '127.0.0.1');
  return (lan.length ? lan : found).sort((a, b) => a.port - b.port);
}

// ----- snapshots from Frigate -----

/** Width and height from a JPEG's SOF marker. */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return undefined;
    const marker = data[i + 1];
    const length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return undefined;
}

const MAX_SNAPSHOT = 64000;

/**
 * Frigate's latest frame of a camera as a JPEG of at most 64000 B (the Matter limit), about the requested width:
 * Frigate scales it (height) and sets the JPEG quality, so a few tries are enough. The frame comes from Frigate's
 * detect stream, so it is never bigger than that.
 */
export async function fitLatestJpeg(client: FrigateClient, camera: string, requestedWidth: number, detect?: { width?: number; height?: number }): Promise<{ data: Buffer; width: number; height: number; note: string }> {
  const aspect = detect?.width && detect?.height ? detect.height / detect.width : 9 / 16;
  const maxHeight = detect?.height || 1080;
  let height = Math.min(maxHeight, Math.round((requestedWidth || 1280) * aspect), 1080);
  height -= height % 2;
  // full size at falling quality, then smaller sizes; a try far over the limit skips the rest of that size
  const plan: [number, number][] = [];
  for (const scale of [1, 0.75, 0.5, 0.35]) for (const quality of [80, 65, 50]) plan.push([Math.max(240, Math.round((height * scale) / 2) * 2), quality]);
  let tries = 0;
  let last = 0;
  let skipHeight = 0;
  for (const [h, quality] of plan) {
    if (h === skipHeight) continue;
    tries++;
    const data = await client.latestJpeg(camera, h, quality);
    last = data.length;
    const size = jpegSize(data);
    if (data.length <= MAX_SNAPSHOT && size) return { data, width: size.width, height: size.height, note: `quality ${quality}, ${tries} ${tries === 1 ? 'try' : 'tries'}` };
    if (data.length > MAX_SNAPSHOT * 2.2) skipHeight = h;
  }
  throw new Error(`Frigate's picture stays ${last} B (Matter limit ${MAX_SNAPSHOT} B)`);
}
