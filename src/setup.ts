/**
 * The plugin page (apps/frontend/build/index.html, the globe icon in Matterbridge) and its API at
 * /plugins/matterbridge-frigate/api/:path (MatterbridgePlatform.onFetch).
 *
 * The page mirrors the plugin settings: Frigate connection, then each Frigate camera with its streams, a short
 * preview, the sound, its detections and the pairing code. Tests never change the config; only "Save" does
 * (the connection, or that one camera). Previews are limited in time and reuse the running stream when there
 * is one, so live view and recording are not disturbed. Passwords never go to the page.
 */
import { QrCode } from 'matterbridge/matter/types';

import { g711ToPcm, wav } from './audio.js';
import { CameraDetections, DetectionFeed, DetectionStatus } from './detections.js';
import { FrigateCamera, FrigateClient, FrigateConfig, camerasFromConfig, discoverFrigate, fitLatestJpeg, mqttHint } from './frigate.js';
import { MqttClient } from './mqtt.js';
import type { CameraConfig, FrigatePluginConfig } from './platform.js';
import { AccessUnit, RtspSource, isG711 } from './rtsp.js';
import { snapshotFromKeyframe } from './snapshot.js';
import { RestreamSettings, StreamInfo, checkStream, defaultStream, restreamUrl, streamTitle } from './streams.js';

/** What the page can see of a camera that is running as a Matter device. */
export interface RunningCamera {
  name: string;
  title: string;
  rtspUrl: string;
  source: RtspSource;
  width: number;
  height: number;
  serverNode?: unknown;
  detections?: CameraDetections;
}

/** The platform parts the page uses. */
export interface SetupHost {
  version: () => string;
  config(): FrigatePluginConfig;
  frigate(): { client?: FrigateClient; config?: FrigateConfig; cameras: FrigateCamera[]; error?: string; feed?: DetectionStatus };
  streams(name: string): StreamInfo[] | undefined;
  restream(): RestreamSettings | undefined;
  /** Merges these settings into the config, saves it and asks Matterbridge for a restart. */
  saveConfig(changes: Partial<FrigatePluginConfig>): void;
  running(name: string): RunningCamera | undefined;
  log: (level: 'info' | 'warn' | 'debug', message: string) => void;
}

const VENDORS: Record<number, string> = { 0x110a: 'SmartThings', 0x1349: 'Apple Home', 0x6006: 'Google Home', 0x1217: 'Amazon Alexa', 0x134b: 'Home Assistant', 0x1384: 'Aqara', 0x115f: 'Aqara', 0x10b2: 'Hubitat', 0xfff1: 'Test controller' };
const MASK = '********';
const PREVIEW_MS = 15_000;
const LISTEN_MS = 5_000;
const WATCH_MS = 60_000;

/** One QR code as SVG, from the text form matter.js draws (block characters, light modules). */
export function qrSvg(text: string): string {
  const rows: boolean[][] = [];
  for (const line of QrCode.get(text).split('\n')) {
    if (!line.length) continue;
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of line) {
      top.push(ch === '█' || ch === '▀');
      bottom.push(ch === '█' || ch === '▄');
    }
    rows.push(top, bottom);
  }
  // the text form has dark padding around the light quiet zone: keep only the code and its quiet zone
  const lit = rows.flatMap((row, y) => row.map((light, x) => (light ? [x, y] : undefined)).filter((p): p is number[] => !!p));
  const x0 = Math.min(...lit.map((p) => p[0]));
  const x1 = Math.max(...lit.map((p) => p[0]));
  const y0 = Math.min(...lit.map((p) => p[1]));
  const y1 = Math.max(...lit.map((p) => p[1]));
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  let path = '';
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!rows[y][x]) path += `M${x - x0} ${y - y0}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** The Frigate connection as the page edits it. */
interface ConnectionDraft {
  frigateHost?: string;
  frigatePort?: number | string | null;
  frigateUser?: string;
  frigatePassword?: string;
  restreamPort?: number | string | null;
  restreamUser?: string;
  restreamPassword?: string;
  mqttHost?: string;
  mqttPort?: number | string | null;
  mqttTls?: boolean;
  mqttUser?: string;
  mqttPassword?: string;
  mqttTopicPrefix?: string;
}

interface Preview {
  key: string;
  source: RtspSource;
  temporary: boolean;
  unsubscribe: () => void;
  endsAt: number;
  timer: NodeJS.Timeout;
  keyframe?: { au: AccessUnit; at: number };
  served: number;
  error?: string;
}

const port = (value: unknown, fallback?: number): number | undefined => {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : NaN;
};

export class SetupApi {
  private readonly previews = new Map<string, Preview>();
  private watch?: { feed: DetectionFeed; endsAt: number; seen: { at: number; camera: string; kind: string; text: string; active: boolean }[]; timer: NodeJS.Timeout };
  private readonly busy = new Set<string>();
  /** Streams checked from the page (fresher than the startup check). */
  private readonly checked = new Map<string, StreamInfo[]>();
  /** A Frigate the page connected to (a new address not saved yet). */
  private probed?: { key: string; client: FrigateClient; config: FrigateConfig; cameras: FrigateCamera[] };

  constructor(private readonly host: SetupHost) {}

  stop(): void {
    for (const preview of this.previews.values()) this.endPreview(preview);
    this.stopWatch();
  }

  async handle(method: string, path: string | undefined, body: unknown): Promise<unknown> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const camera = typeof input.camera === 'string' ? input.camera : '';
    try {
      switch (path) {
        case 'state':
          return this.state();
        case 'discover':
          return await this.once('discover', () => this.discover());
        case 'connect':
          return await this.once('connect', () => this.connect((input.connection as ConnectionDraft) ?? {}));
        case 'save-connection':
          return this.saveConnection((input.connection as ConnectionDraft) ?? {});
        case 'streams':
          return await this.once(`streams:${camera}`, () => this.checkStreams(camera));
        case 'preview':
          return await this.preview(camera, input as { stream?: string; rotation?: string; restart?: boolean });
        case 'preview-stop':
          this.stopPreview(camera);
          return { ok: true };
        case 'snapshot':
          return await this.once(`snapshot:${camera}`, () => this.snapshot(camera));
        case 'listen':
          return await this.once(`listen:${camera}`, () => this.listen(camera, input as { stream?: string }));
        case 'detections':
          return this.detections(camera, input.start === true);
        case 'save':
          return this.save((input.settings as Partial<CameraConfig>) ?? {}, camera);
        default:
          return method === 'GET' ? undefined : { error: `unknown request ${path ?? ''}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** One request of a kind at a time (a second click while the first runs gets an answer at once). */
  private async once(key: string, fn: () => Promise<unknown>): Promise<unknown> {
    if (this.busy.has(key)) return { error: 'already running, wait for it to finish' };
    this.busy.add(key);
    try {
      return await fn();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.busy.delete(key);
    }
  }

  // ---- what the page shows (passwords never leave the plugin) ----

  private state(): unknown {
    const cfg = this.host.config();
    const frigate = this.host.frigate();
    const frigateCameras = frigate.cameras;
    const saved = (cfg.cameras ?? []).filter((c) => c && c.name);
    const names = [...new Set([...frigateCameras.map((c) => c.name), ...saved.map((c) => c.name)])];
    return {
      version: this.host.version(),
      connection: {
        frigateHost: cfg.frigateHost ?? '',
        frigatePort: cfg.frigatePort ?? 5000,
        frigateUser: cfg.frigateUser ?? '',
        frigatePassword: cfg.frigatePassword ? MASK : '',
        restreamPort: cfg.restreamPort ?? 8554,
        restreamUser: cfg.restreamUser ?? '',
        restreamPassword: cfg.restreamPassword ? MASK : '',
        mqttHost: cfg.mqttHost ?? '',
        mqttPort: cfg.mqttPort ?? 1883,
        mqttTls: cfg.mqttTls === true,
        mqttUser: cfg.mqttUser ?? '',
        mqttPassword: cfg.mqttPassword ? MASK : '',
        mqttTopicPrefix: cfg.mqttTopicPrefix ?? 'frigate',
      },
      frigate: {
        connected: !!frigate.config,
        url: frigate.client?.url ?? '',
        version: frigate.client?.version ?? '',
        error: frigate.error ?? '',
        mqttHint: frigate.config ? (mqttHint(frigate.config) ?? null) : null,
        feed: frigate.feed ?? null,
      },
      cameras: names.map((name) => this.publicCamera(name, saved.find((c) => c.name === name), frigateCameras.find((c) => c.name === name))),
    };
  }

  private publicCamera(name: string, camera: CameraConfig | undefined, frigateCamera: FrigateCamera | undefined): unknown {
    const running = this.host.running(name);
    const streams = this.checked.get(name) ?? this.host.streams(name) ?? [];
    return {
      name,
      inSettings: !!camera,
      inFrigate: !!frigateCamera,
      frigateTitle: frigateCamera?.title ?? '',
      title: camera?.title ?? '',
      enabled: camera?.enabled === true,
      stream: camera?.stream ?? '',
      rtspUrl: camera?.rtspUrl ? camera.rtspUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, `//$1:${MASK}@`) : '',
      rotation: camera?.rotation ?? '0',
      liveAudio: camera?.liveAudio === 'off' ? 'off' : 'opus',
      clipAudio: camera?.clipAudio === 'off' ? 'off' : 'aac',
      detections: camera ? camera.detections !== false : true,
      objects: camera?.objects ?? [],
      zones: camera?.zones ?? [],
      motion: camera?.motion === true,
      recording: camera ? camera.recording !== false : true,
      keepConnected: camera?.keepConnected === true,
      info: camera?.info ?? '',
      frigateObjects: frigateCamera?.objects ?? [],
      frigateZones: frigateCamera?.zones ?? [],
      detect: frigateCamera ? { width: frigateCamera.detectWidth ?? null, height: frigateCamera.detectHeight ?? null } : null,
      streams: streams.map((s) => ({ name: s.name, label: s.label ?? '', ok: s.ok, codec: s.codec ?? '', width: s.width ?? null, height: s.height ?? null, audio: s.audio, error: s.error ?? '', title: streamTitle(s) })),
      defaultStream: defaultStream(streams)?.name ?? '',
      running: !!running,
      motionNow: running?.detections?.active ?? false,
      matter: running ? this.matter(running) : undefined,
    };
  }

  /** Pairing QR / manual code while not paired, else the controllers (fabrics) it is paired with. */
  private matter(running: RunningCamera): unknown {
    const node = running.serverNode as
      | { state?: { commissioning?: { commissioned?: boolean; pairingCodes?: { qrPairingCode?: string; manualPairingCode?: string }; fabrics?: Record<string, { label?: string; rootVendorId?: number }> } }; lifecycle?: { isOnline?: boolean } }
      | undefined;
    const commissioning = node?.state?.commissioning;
    if (!commissioning) return { available: false };
    const fabrics = Object.values(commissioning.fabrics ?? {}).map((f) => ({ label: f.label || '', vendor: (f.rootVendorId !== undefined && VENDORS[f.rootVendorId]) || (f.rootVendorId !== undefined ? `vendor 0x${f.rootVendorId.toString(16)}` : '') }));
    const qr = commissioning.pairingCodes?.qrPairingCode;
    return {
      available: true,
      online: node?.lifecycle?.isOnline !== false,
      commissioned: commissioning.commissioned === true,
      fabrics,
      manualCode: commissioning.pairingCodes?.manualPairingCode ?? '',
      qrSvg: qr && !commissioning.commissioned ? qrSvg(qr) : '',
    };
  }

  // ---- Frigate connection ----

  private async discover(): Promise<unknown> {
    const lines: string[] = [];
    const found = await discoverFrigate((m) => lines.push(m));
    return { found, log: lines };
  }

  /** The draft with the saved passwords filled in where the page shows them masked. */
  private resolveConnection(draft: ConnectionDraft): FrigatePluginConfig {
    const cfg = this.host.config();
    const secret = (value: string | undefined, saved: string | undefined): string | undefined => (value === MASK ? saved : value || undefined);
    return {
      ...cfg,
      frigateHost: String(draft.frigateHost ?? '').trim(),
      frigatePort: port(draft.frigatePort, 5000),
      frigateUser: String(draft.frigateUser ?? '').trim() || undefined,
      frigatePassword: secret(draft.frigatePassword, cfg.frigatePassword),
      restreamPort: port(draft.restreamPort, 8554),
      restreamUser: String(draft.restreamUser ?? '').trim() || undefined,
      restreamPassword: secret(draft.restreamPassword, cfg.restreamPassword),
      mqttHost: String(draft.mqttHost ?? '').trim() || undefined,
      mqttPort: port(draft.mqttPort, 1883),
      mqttTls: draft.mqttTls === true,
      mqttUser: String(draft.mqttUser ?? '').trim() || undefined,
      mqttPassword: secret(draft.mqttPassword, cfg.mqttPassword),
      mqttTopicPrefix: String(draft.mqttTopicPrefix ?? '').trim() || 'frigate',
    };
  }

  /** Test a connection: Frigate's API (version, cameras), its restream port, and MQTT when filled in. */
  private async connect(draft: ConnectionDraft): Promise<unknown> {
    const c = this.resolveConnection(draft);
    if (!c.frigateHost) return { error: 'enter the Frigate address first (or search the network)' };
    if (Number.isNaN(c.frigatePort) || Number.isNaN(c.restreamPort) || Number.isNaN(c.mqttPort)) return { error: 'a port must be 1-65535' };
    const client = new FrigateClient({ host: c.frigateHost, port: c.frigatePort!, username: c.frigateUser, password: c.frigatePassword });
    const result: Record<string, unknown> = { url: client.url };
    try {
      result.version = await client.getVersion();
      const config = await client.getConfig();
      const cameras = camerasFromConfig(config);
      this.probed = { key: `${c.frigateHost}:${c.frigatePort}`, client, config, cameras };
      result.cameras = cameras.map((cam) => ({ name: cam.name, streams: cam.streams.map((s) => s.name), objects: cam.objects }));
      result.mqttHint = mqttHint(config) ?? null;
      // the restream of the first camera that has one: is the RTSP port open, does it need a login?
      const first = cameras.find((cam) => cam.streams.length);
      if (first) {
        const info = await checkStream({ host: c.frigateHost, port: c.restreamPort!, username: c.restreamUser, password: c.restreamPassword }, first.streams[0].name, first.streams[0].label);
        result.restream = { stream: first.streams[0].name, ok: info.ok, title: streamTitle(info), error: info.error ?? '' };
      } else {
        result.restream = { ok: false, error: 'no camera has a go2rtc restream in Frigate (go2rtc streams in the Frigate config)' };
      }
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
    if (c.mqttHost) result.mqtt = await this.testMqtt(c);
    return { ...result, ok: true };
  }

  private testMqtt(c: FrigatePluginConfig): Promise<unknown> {
    return new Promise((resolve) => {
      let messages = 0;
      const topics: string[] = [];
      const prefix = c.mqttTopicPrefix || 'frigate';
      const client = new MqttClient(
        { host: c.mqttHost!, port: c.mqttPort, tls: c.mqttTls, username: c.mqttUser, password: c.mqttPassword },
        [`${prefix}/#`],
        (topic) => {
          messages++;
          if (topics.length < 8 && !topics.includes(topic)) topics.push(topic);
        },
        () => undefined,
      );
      client.start();
      // a few seconds to see Frigate's retained topics (available, camera states) arrive
      setTimeout(() => {
        const connected = client.connected;
        const error = client.lastError;
        client.stop();
        resolve({ ok: connected, error: connected ? (messages ? '' : `connected, but nothing arrived on ${prefix}/# yet (topic prefix right?)`) : (error ?? 'no answer'), messages, topics });
      }, 4000);
    });
  }

  private saveConnection(draft: ConnectionDraft): unknown {
    const c = this.resolveConnection(draft);
    if (Number.isNaN(c.frigatePort) || Number.isNaN(c.restreamPort) || Number.isNaN(c.mqttPort)) return { error: 'a port must be 1-65535' };
    if (c.frigateHost && !/^[A-Za-z0-9.:-]+$/.test(c.frigateHost)) return { error: 'the Frigate address is not valid (an IP address or host name, without http://)' };
    const keys = ['frigateHost', 'frigatePort', 'frigateUser', 'frigatePassword', 'restreamPort', 'restreamUser', 'restreamPassword', 'mqttHost', 'mqttPort', 'mqttTls', 'mqttUser', 'mqttPassword', 'mqttTopicPrefix'] as const;
    const before = this.host.config() as Record<string, unknown>;
    const changes: Record<string, unknown> = {};
    for (const key of keys) if (JSON.stringify(before[key] ?? null) !== JSON.stringify((c as Record<string, unknown>)[key] ?? null)) changes[key] = (c as Record<string, unknown>)[key];
    const changed = Object.keys(changes);
    if (!changed.length) return { ok: true, changed: [], restart: false };
    this.host.saveConfig(changes as Partial<FrigatePluginConfig>);
    this.host.log('info', `Frigate connection saved from the plugin page (${changed.map((k) => (/password/i.test(k) ? `${k} (changed)` : k)).join(', ')})`);
    return { ok: true, changed, restart: true };
  }

  // ---- one camera ----

  private client(): FrigateClient | undefined {
    return this.host.frigate().client ?? this.probed?.client;
  }

  private frigateCamera(name: string): FrigateCamera | undefined {
    return this.host.frigate().cameras.find((c) => c.name === name) ?? this.probed?.cameras.find((c) => c.name === name);
  }

  private restream(): RestreamSettings | undefined {
    const settings = this.host.restream();
    if (settings) return settings;
    const cfg = this.host.config();
    const probed = this.probed?.client.address;
    return probed ? { host: probed.host, port: cfg.restreamPort || 8554, username: cfg.restreamUser, password: cfg.restreamPassword } : undefined;
  }

  private async checkStreams(name: string): Promise<unknown> {
    const restream = this.restream();
    if (!restream) return { error: 'not connected to Frigate yet' };
    const camera = this.frigateCamera(name);
    const saved = this.host.config().cameras?.find((c) => c.name === name);
    const candidates = camera?.streams.length ? camera.streams : saved?.stream ? [{ name: saved.stream }] : [{ name }];
    const infos = await Promise.all(candidates.map((s) => checkStream(restream, s.name, s.label)));
    this.checked.set(name, infos);
    return { streams: infos.map((s) => ({ name: s.name, label: s.label ?? '', ok: s.ok, codec: s.codec ?? '', width: s.width ?? null, height: s.height ?? null, audio: s.audio, error: s.error ?? '', title: streamTitle(s) })), defaultStream: defaultStream(infos)?.name ?? '' };
  }

  /** The URL of a stream of a camera (the running one is shared when it is the same). */
  private streamUrl(name: string, stream?: string): string {
    const saved = this.host.config().cameras?.find((c) => c.name === name);
    if (!stream && saved?.rtspUrl) return saved.rtspUrl;
    const restream = this.restream();
    if (!restream) throw new Error('not connected to Frigate yet');
    const infos = this.checked.get(name) ?? this.host.streams(name) ?? [];
    const pick = stream || saved?.stream || defaultStream(infos)?.name || this.frigateCamera(name)?.streams[0]?.name;
    if (!pick) throw new Error('this camera has no go2rtc restream in Frigate');
    return restreamUrl(restream, pick, saved?.liveAudio !== 'off');
  }

  private sourceFor(name: string, url: string): { source: RtspSource; temporary: boolean } {
    const running = this.host.running(name);
    if (running && sameStream(running.rtspUrl, url)) return { source: running.source, temporary: false };
    const source = new RtspSource(url, (level, message) => this.host.log(level === 'info' ? 'debug' : level, `${name} (page preview): ${message}`));
    return { source, temporary: true };
  }

  // ---- preview: a picture about every keyframe, for 15 s at most ----

  private async preview(name: string, options: { stream?: string; rotation?: string; restart?: boolean }): Promise<unknown> {
    const saved = this.host.config().cameras?.find((c) => c.name === name);
    const rotationValue = Number(options.rotation ?? saved?.rotation ?? 0);
    const rotation = [90, 180, 270].includes(rotationValue) ? rotationValue : 0;
    let preview = this.previews.get(name);
    if (preview && options.restart) {
      this.endPreview(preview);
      preview = undefined;
    }
    if (!preview) {
      if (this.previews.size >= 2) return { error: 'two previews are already running; stop one first' };
      const url = this.streamUrl(name, options.stream);
      const { source, temporary } = this.sourceFor(name, url);
      const created: Preview = { key: name, source, temporary, unsubscribe: () => undefined, endsAt: Date.now() + PREVIEW_MS, timer: setTimeout(() => this.endPreview(created), PREVIEW_MS), served: 0 };
      // a recent keyframe of a running stream shows at once
      if (source.lastKeyframe && Date.now() - source.lastKeyframe.at < 3000) created.keyframe = source.lastKeyframe;
      created.unsubscribe = source.subscribe((au) => {
        if (au.keyframe) created.keyframe = { au, at: Date.now() };
      });
      source.ensure().catch((error) => (created.error = String(error instanceof Error ? error.message : error)));
      this.previews.set(name, created);
      preview = created;
      this.host.log('info', `${name}: page preview started (${temporary ? 'own short connection' : 'shares the running stream'}, ${PREVIEW_MS / 1000} s)`);
    }
    const left = Math.max(0, preview.endsAt - Date.now());
    if (preview.error) {
      const error = preview.error;
      this.endPreview(preview);
      return { error, ended: true };
    }
    if (!preview.keyframe || preview.keyframe.at <= preview.served) return { waiting: true, left, shared: !preview.temporary };
    const { au, at } = preview.keyframe;
    preview.served = at;
    const source = preview.source;
    const shot = await snapshotFromKeyframe(au, source.sps, source.pps, 960, 0, rotation);
    return { image: `data:image/jpeg;base64,${shot.data.toString('base64')}`, width: shot.width, height: shot.height, left, shared: !preview.temporary, keyframeSeconds: source.keyframeIntervalMs ? source.keyframeIntervalMs / 1000 : null };
  }

  private stopPreview(name: string): void {
    const preview = this.previews.get(name);
    if (preview) this.endPreview(preview);
  }

  private endPreview(preview: Preview): void {
    clearTimeout(preview.timer);
    preview.unsubscribe();
    if (preview.temporary) preview.source.stop();
    if (this.previews.get(preview.key) === preview) this.previews.delete(preview.key);
  }

  /** The snapshot the hub would get from Frigate (fitted to 64000 B). */
  private async snapshot(name: string): Promise<unknown> {
    const client = this.client();
    if (!client) return { error: 'not connected to Frigate yet' };
    const camera = this.frigateCamera(name);
    const started = Date.now();
    const shot = await fitLatestJpeg(client, name, 1280, { width: camera?.detectWidth, height: camera?.detectHeight });
    return { image: `data:image/jpeg;base64,${shot.data.toString('base64')}`, width: shot.width, height: shot.height, bytes: shot.data.length, ms: Date.now() - started, note: shot.note };
  }

  // ---- listen: 5 s of the camera's sound as WAV ----

  private async listen(name: string, options: { stream?: string }): Promise<unknown> {
    const url = this.streamUrl(name, options.stream);
    const { source, temporary } = this.sourceFor(name, url);
    const pcm: Buffer[] = [];
    const unsubscribeVideo = source.subscribe(() => undefined);
    const unsubscribeAudio = source.subscribeAudio((packet) => {
      if (packet.pcm) pcm.push(packet.payload);
      else if (isG711(source.audio)) pcm.push(g711ToPcm(packet.payload, source.audio!.codec));
    });
    try {
      await source.ensure();
      const described = source.describedAudios.map((a) => (/mpeg4-generic/i.test(a.codec) ? 'AAC' : a.codec.toUpperCase()));
      if (!described.length) return { error: 'the stream has no audio' };
      if (!isG711(source.audio) && !source.opusAudio) return { error: `the stream has ${described.join(', ')} audio: clips get it as is, but live view needs Opus or G.711 (add "ffmpeg:${name}#audio=opus" to the go2rtc stream)` };
      await new Promise((resolve) => setTimeout(resolve, LISTEN_MS));
    } finally {
      unsubscribeAudio();
      unsubscribeVideo();
      if (temporary) source.stop();
    }
    const data = Buffer.concat(pcm);
    if (!data.length) return { error: 'no sound arrived from the stream' };
    const codec = isG711(source.audio) ? source.audio!.codec.toUpperCase() : 'Opus';
    return { audio: `data:audio/wav;base64,${wav(data, 8000).toString('base64')}`, seconds: data.length / 2 / 8000, codec };
  }

  // ---- detections: the running camera's, or a temporary feed for 60 s ----

  private detections(name: string, start: boolean): unknown {
    const running = this.host.running(name);
    if (running?.detections) return { shared: true, active: running.detections.active, events: running.detections.recent.slice(-20), left: null };
    if (!this.watch && start) {
      const client = this.client();
      if (!client) return { error: 'not connected to Frigate yet' };
      const cfg = this.host.config();
      const seen: { at: number; camera: string; kind: string; text: string; active: boolean }[] = [];
      const feed = new DetectionFeed(
        {
          onObject: (e) => seen.push({ at: Date.now(), camera: e.camera, kind: 'object', text: `${e.type} ${e.label}${e.score ? ` ${Math.round(e.score * 100)}%` : ''}${e.zones.length ? ` in ${e.zones.join(', ')}` : ''}${e.stationary ? ' (stationary)' : ''}`, active: e.type !== 'end' && !e.stationary }),
          onMotion: (camera, active) => seen.push({ at: Date.now(), camera, kind: 'motion', text: 'motion', active }),
        },
        (level, message) => this.host.log(level === 'info' ? 'debug' : level, `(page) ${message}`),
      );
      const mqtt = cfg.mqttHost ? { host: cfg.mqttHost, port: cfg.mqttPort, tls: cfg.mqttTls, username: cfg.mqttUser, password: cfg.mqttPassword, prefix: cfg.mqttTopicPrefix } : undefined;
      feed.start({ mqtt, frigate: client });
      this.watch = { feed, seen, endsAt: Date.now() + WATCH_MS, timer: setTimeout(() => this.stopWatch(), WATCH_MS) };
    }
    if (!this.watch) return { events: [], left: 0 };
    const events = this.watch.seen.filter((e) => e.camera === name).slice(-20);
    return { shared: false, feed: this.watch.feed.status, events, left: Math.max(0, this.watch.endsAt - Date.now()) };
  }

  private stopWatch(): void {
    if (!this.watch) return;
    clearTimeout(this.watch.timer);
    this.watch.feed.stop();
    this.watch = undefined;
  }

  // ---- save: only this camera entry, checked field by field ----

  private save(settings: Partial<CameraConfig>, name: string): unknown {
    if (!name) return { error: 'no camera given' };
    const cfg = this.host.config();
    const cameras = (cfg.cameras ?? []).map((c) => ({ ...c }));
    const index = cameras.findIndex((c) => c.name === name);
    const before = index >= 0 ? cameras[index] : undefined;
    const errors: string[] = [];
    const rtspUrl = String(settings.rtspUrl ?? '').trim();
    if (rtspUrl && !/^rtsps?:\/\//.test(rtspUrl)) errors.push('the RTSP URL must start with rtsp://');
    const list = (value: unknown): string[] => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((v) => String(v).trim()).filter(Boolean);
    if (errors.length) return { error: errors.join('; ') };
    let finalUrl = rtspUrl;
    if (rtspUrl.includes(`:${MASK}@`)) {
      const savedPass = before?.rtspUrl ? /\/\/[^:@/]+:([^@/]+)@/.exec(before.rtspUrl)?.[1] : undefined;
      finalUrl = savedPass ? rtspUrl.replace(`:${MASK}@`, `:${savedPass}@`) : rtspUrl.replace(`:${MASK}@`, '@');
    }
    const entry: CameraConfig = {
      ...(before ?? {}),
      name,
      title: String(settings.title ?? '').trim() || undefined,
      enabled: settings.enabled === true,
      stream: String(settings.stream ?? '').trim() || before?.stream,
      rtspUrl: finalUrl || undefined,
      rotation: ['0', '90', '180', '270'].includes(String(settings.rotation)) ? String(settings.rotation) : '0',
      liveAudio: settings.liveAudio === 'off' ? 'off' : 'opus',
      clipAudio: settings.clipAudio === 'off' ? 'off' : 'aac',
      detections: settings.detections !== false,
      objects: list(settings.objects),
      zones: list(settings.zones),
      motion: settings.motion === true,
      recording: settings.recording !== false,
      keepConnected: settings.keepConnected === true,
    };
    for (const key of Object.keys(entry) as (keyof CameraConfig)[]) if (entry[key] === undefined) delete entry[key];
    if (index >= 0) cameras[index] = entry;
    else cameras.push(entry);
    const changed = before ? Object.keys({ ...before, ...entry }).filter((k) => JSON.stringify((before as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify((entry as unknown as Record<string, unknown>)[k] ?? null)) : ['new camera'];
    if (!changed.length) return { ok: true, changed: [], restart: false };
    this.host.saveConfig({ cameras });
    this.host.log('info', `${name}: settings saved from the plugin page (${changed.join(', ')})`);
    return { ok: true, changed, restart: true };
  }
}

function sameStream(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.hostname === y.hostname && (x.port || '554') === (y.port || '554') && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}
