import * as fs from 'node:fs';
import * as path from 'node:path';

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { StreamUsage } from 'matterbridge/matter/types';
import { CameraAvStreamManagement } from 'matterbridge/matter/clusters';

import { levelToGain } from './audio.js';
import { CameraDetections, DetectionFeed, FrigateObjectEvent } from './detections.js';
import { FrigateCamera, FrigateClient, FrigateConfig, camerasFromConfig, discoverFrigate, fitLatestJpeg, mqttHint } from './frigate.js';
import { CameraMedia, camerasByEndpoint, camerasByUrl, installMediaPatches, patchSnapshots } from './media.js';
import { PreRollBuffer, RecordingStore } from './pushav.js';
import { FrigateZoneServer, createRecording, pushAvDefaults, setRecordingLog, timeSyncDefaults, tlsCertificateDefaults, tlsClientDefaults, zoneDefaults } from './recording.js';
import { RtspSource } from './rtsp.js';
import { RunningCamera, SetupApi } from './setup.js';
import { RestreamSettings, StreamInfo, checkStream, defaultStream, redactUrl, restreamUrl, streamTitle } from './streams.js';

const MAX_CAMERAS = 16;
export const PLUGIN = 'matterbridge-frigate';

/** One camera in the plugin settings (name = the camera's name in Frigate). */
export interface CameraConfig {
  name: string;
  /** Name in Matter / the controller app; empty = Frigate's friendly name or the camera name. */
  title?: string;
  enabled?: boolean;
  /** go2rtc stream to use; empty = chosen automatically (best H.264 up to 1080p). */
  stream?: string;
  /** Instead of the go2rtc restream: any RTSP URL with H.264. */
  rtspUrl?: string;
  rotation?: string;
  liveAudio?: 'opus' | 'off';
  clipAudio?: 'aac' | 'off';
  /** Frigate detections to Matter motion (and clips). */
  detections?: boolean;
  /** Labels that count (empty = every object Frigate tracks for this camera). */
  objects?: string[];
  /** Only objects in these Frigate zones count (empty = anywhere). */
  zones?: string[];
  /** Frigate's pixel motion counts too (not only objects). */
  motion?: boolean;
  recording?: boolean;
  keepConnected?: boolean;
  /** Read-only notes written by the plugin. */
  info?: string;
}

export interface FrigatePluginConfig extends PlatformConfig {
  frigateHost?: string;
  frigatePort?: number;
  frigateUser?: string;
  frigatePassword?: string;
  discovery?: boolean;
  restreamPort?: number;
  restreamUser?: string;
  restreamPassword?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttTls?: boolean;
  mqttUser?: string;
  mqttPassword?: string;
  mqttTopicPrefix?: string;
  cameras?: CameraConfig[];
  /** Add Frigate cameras that are not in the list yet (switched on). */
  addNewCameras?: boolean;
}

/** "front_door" -> "Front Door". */
export const prettyName = (name: string): string => name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

export class FrigatePlatform extends MatterbridgeDynamicPlatform {
  private readonly sources: RtspSource[] = [];
  private readonly preRolls: PreRollBuffer[] = [];
  private readonly detections = new Map<string, CameraDetections>();
  private feed?: DetectionFeed;
  frigate?: FrigateClient;
  frigateConfig?: FrigateConfig;
  frigateCameras: FrigateCamera[] = [];
  /** Problem reaching Frigate at startup, for the page. */
  frigateError?: string;
  /** go2rtc streams checked at startup, by camera. */
  readonly streamInfo = new Map<string, StreamInfo[]>();
  /** Cameras running as Matter devices, for the plugin page. */
  private readonly running = new Map<string, RunningCamera>();
  private readonly setup: SetupApi;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    this.log.info('Frigate plugin loaded');
    this.setup = new SetupApi({
      version: () => this.version,
      config: () => this.cfg,
      frigate: () => ({ client: this.frigate, config: this.frigateConfig, cameras: this.frigateCameras, error: this.frigateError, feed: this.feed?.status }),
      streams: (name) => this.streamInfo.get(name),
      restream: () => this.restreamSettings(),
      saveConfig: (changes) => {
        Object.assign(this.cfg, changes);
        this.saveConfig(this.config);
        this.wssSendRestartRequired();
      },
      running: (name) => this.running.get(name),
      log: (level, message) => this.log[level](message),
    });
  }

  private get cfg(): FrigatePluginConfig {
    return this.config as FrigatePluginConfig;
  }

  private restreamSettings(): RestreamSettings | undefined {
    if (!this.frigate) return undefined;
    return { host: this.frigate.address.host, port: this.cfg.restreamPort || 8554, username: this.cfg.restreamUser || undefined, password: this.cfg.restreamPassword || undefined };
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart (${reason ?? 'no reason'})`);
    await this.ready;
    await this.clearSelect();
    let changed = false;

    // 1. Frigate: the address in the settings, or found on the network (and written to the settings)
    if (!this.cfg.frigateHost && this.cfg.discovery !== false) {
      this.log.info('No Frigate address in the settings: looking for Frigate on the network (ports 5000 and 8971) ...');
      const found = await discoverFrigate((m) => this.log.info(m)).catch(() => []);
      const pick = found.find((f) => f.port === 5000) ?? found[0];
      if (pick) {
        this.cfg.frigateHost = pick.host;
        this.cfg.frigatePort = pick.port;
        changed = true;
        this.log.notice(`Frigate found at ${pick.host}:${pick.port}${pick.version ? ` (version ${pick.version})` : ''}${pick.needsLogin ? ': it needs a login, enter the Frigate user and password in the settings' : ''}; saved in the settings`);
        if (found.length > 1) this.log.info(`Also found: ${found.filter((f) => f !== pick).map((f) => `${f.host}:${f.port}`).join(', ')}`);
      } else {
        this.log.warn('Frigate was not found on the network. Enter its address in the plugin settings (or on the plugin page) and restart.');
      }
    }
    if (!this.cfg.frigateHost) {
      if (changed) this.saveConfig(this.config);
      return;
    }
    this.frigate = new FrigateClient({ host: this.cfg.frigateHost, port: this.cfg.frigatePort || 5000, username: this.cfg.frigateUser || undefined, password: this.cfg.frigatePassword || undefined });

    // 2. Its cameras (a few tries: Frigate may still be starting after a power cut)
    for (let attempt = 1; attempt <= 3 && !this.frigateConfig; attempt++) {
      try {
        const version = await this.frigate.getVersion();
        this.frigateConfig = await this.frigate.getConfig();
        this.frigateCameras = camerasFromConfig(this.frigateConfig);
        this.frigateError = undefined;
        this.log.notice(`Connected to Frigate ${version} at ${this.frigate.url}: ${this.frigateCameras.length} camera(s): ${this.frigateCameras.map((c) => c.name).join(', ')}`);
      } catch (error) {
        this.frigateError = error instanceof Error ? error.message : String(error);
        this.log.warn(`Frigate at ${this.frigate.url} not reachable (${this.frigateError})${attempt < 3 ? '; trying again in 10 s' : ''}`);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
    const list = [...(this.cfg.cameras ?? [])].filter((c) => c && c.name);
    if (this.frigateConfig) {
      const known = new Set(list.map((c) => c.name));
      const added: string[] = [];
      for (const camera of this.frigateCameras) {
        if (known.has(camera.name) || this.cfg.addNewCameras === false) continue;
        list.push({ name: camera.name, enabled: camera.enabled, rotation: '0', liveAudio: 'opus', clipAudio: 'aac', detections: true, recording: true, keepConnected: false, info: `added from Frigate ${new Date().toISOString().slice(0, 10)}` });
        added.push(camera.name);
      }
      if (added.length) {
        changed = true;
        this.log.notice(`New Frigate camera(s) added to the settings, switched on: ${added.join(', ')}. Each one is its own Matter device: pair it with its own QR code.`);
        this.wssSendSnackbarMessage(`Frigate: ${added.length} camera(s) added; see the plugin page`, 10);
      }
      for (const c of list) if (!this.frigateCameras.some((f) => f.name === c.name) && !c.rtspUrl) this.log.warn(`${c.name}: not a camera in Frigate any more (left in the settings, not added)`);
      const hint = mqttHint(this.frigateConfig);
      if (!this.cfg.mqttHost) this.log.info(`Detections: Frigate's WebSocket${hint ? ` (Frigate also uses MQTT at ${hint.host}:${hint.port}; fill in the MQTT settings to use it instead)` : ''}`);
    }
    this.cfg.cameras = list;

    // 3. The go2rtc restreams of the enabled cameras: which ones are H.264, their size and audio
    const enabled = list.filter((c) => c.enabled);
    if (enabled.length > MAX_CAMERAS) this.log.warn(`Only the first ${MAX_CAMERAS} enabled cameras are added`);
    const restream = this.restreamSettings()!;
    for (const camera of enabled.slice(0, MAX_CAMERAS)) {
      const frigateCamera = this.frigateCameras.find((f) => f.name === camera.name);
      const candidates = camera.rtspUrl ? [] : (frigateCamera?.streams ?? (camera.stream ? [{ name: camera.stream }] : [{ name: camera.name }]));
      const infos = await Promise.all(candidates.map((s) => checkStream(restream, s.name, s.label)));
      this.streamInfo.set(camera.name, infos);
      for (const s of infos) this.log.info(`${camera.name}: go2rtc stream ${streamTitle(s)}${s.ok ? '' : ` -> not usable: ${s.error}`}`);
      if (!camera.rtspUrl && frigateCamera && !candidates.length) this.log.warn(`${camera.name}: Frigate has no go2rtc restream for this camera. Add it under go2rtc streams in the Frigate config (Frigate docs: "Restream"), or enter an RTSP URL for it`);
      const chosen = infos.find((s) => s.name === camera.stream && s.ok) ?? defaultStream(infos);
      if (!camera.rtspUrl && chosen && camera.stream !== chosen.name) {
        if (camera.stream) this.log.warn(`${camera.name}: stream "${camera.stream}" is not usable, using ${chosen.name}`);
        camera.stream = chosen.name;
        changed = true;
      }
    }
    this.updateStreamChoices(enabled);
    if (changed) this.saveConfig(this.config);

    // 4. Matter cameras
    if (enabled.length) {
      try {
        this.log.info(`Media patches: ${await installMediaPatches()}`);
      } catch (error) {
        this.log.error(`Cannot add cameras: ${String(error)}`);
        return;
      }
    }
    for (const camera of enabled.slice(0, MAX_CAMERAS)) {
      const info = this.streamInfo.get(camera.name)?.find((s) => s.name === camera.stream);
      if (!camera.rtspUrl && !info?.ok) {
        const problems = (this.streamInfo.get(camera.name) ?? []).map((st) => `${st.name}: ${st.error}`);
        this.log.error(`${camera.name}: no usable H.264 restream (${problems.join('; ') || 'Frigate has none for this camera'}), not added`);
        continue;
      }
      try {
        await this.addCamera(camera, info);
      } catch (error) {
        this.log.error(`${camera.name}: could not be added: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 5. Detections: MQTT when filled in, else Frigate's WebSocket
    if (this.detections.size) this.startDetections();
  }

  /** A per-camera "Stream" choice in the settings form, from the go2rtc streams found. */
  private updateStreamChoices(cameras: CameraConfig[]): void {
    const branches: object[] = [];
    const names: string[] = [];
    for (const camera of cameras) {
      const usable = (this.streamInfo.get(camera.name) ?? []).filter((s) => s.ok);
      if (usable.length < 2) continue;
      names.push(camera.name);
      const fallback = defaultStream(usable);
      branches.push({
        properties: {
          name: { enum: [camera.name] },
          stream: {
            title: 'Stream',
            description: `go2rtc streams of this camera in Frigate. Used for live view, clips and backup snapshots`,
            type: 'string',
            oneOf: usable.map((s) => ({ const: s.name, title: `${streamTitle(s)}${s === fallback ? ' (default)' : ''}` })),
            default: fallback?.name,
          },
        },
      });
    }
    void this.getSchema()
      .then((schema) => {
        if (!schema) return;
        const items = (schema as unknown as { properties: { cameras: { items: { dependencies?: Record<string, unknown> } } } }).properties.cameras.items;
        items.dependencies = { ...(items.dependencies ?? {}) };
        if (branches.length) items.dependencies.name = { oneOf: [...branches, { properties: { name: { not: { enum: names } } } }] };
        else delete items.dependencies.name;
        this.setSchema(schema);
      })
      .catch((error: unknown) => this.log.debug(`Could not update the settings form: ${String(error)}`));
  }

  private async addCamera(camera: CameraConfig, info: StreamInfo | undefined): Promise<void> {
    const { Camera } = await import('matterbridge/devices/camera');
    const frigateCamera = this.frigateCameras.find((f) => f.name === camera.name);
    const width = info?.width || frigateCamera?.detectWidth || 1920;
    const height = info?.height || frigateCamera?.detectHeight || 1080;
    const title = (camera.title || frigateCamera?.title || prettyName(camera.name)).slice(0, 32);
    const id = `frigate-${camera.name.replace(/[^A-Za-z0-9]/g, '')}`;
    const recording = camera.recording !== false;
    const rotation = [90, 180, 270].includes(Number(camera.rotation)) ? Number(camera.rotation) : 0;
    const liveAudio = camera.liveAudio === 'off' ? 'off' : 'opus';
    const rtspUrl = camera.rtspUrl || restreamUrl(this.restreamSettings()!, camera.stream!, liveAudio !== 'off');
    // routine lines (hub requests, each uploaded file) go to the debug log; clip start/end and problems stay visible
    const routine = (message: string): boolean => /^\[hub\]|^upload \S+ \(\d+ B\) -> HTTP 2\d\d /.test(message);
    const say = (message: string): void => (routine(message) ? this.log.debug(`${camera.name}: ${message}`) : this.log.notice(`${camera.name}: ${message}`));
    if (recording) setRecordingLog((message) => (routine(message) ? this.log.debug(message) : this.log.info(message)));
    const usages = recording ? [StreamUsage.LiveView, StreamUsage.Recording] : [StreamUsage.LiveView];
    const device = new Camera(title, id, {
      id,
      // every camera is its own Matter device (needed for recording, and one camera cannot stall another)
      mode: 'server',
      powerSourceType: 'Wired',
      supportedStreamUsages: usages,
      streamUsagePriorities: usages,
      maxConcurrentEncoders: recording ? 2 : 1,
      videoSensorParams: { sensorWidth: width, sensorHeight: height, maxFps: 30 },
      rateDistortionTradeOffPoints: [{ codec: CameraAvStreamManagement.VideoCodec.H264, resolution: { width, height }, minBitRate: 500_000 }],
      weriftOfferOptions: { offerVideo: true, offerAudio: true, videoSource: 'rtsp', videoSourceDevice: rtspUrl, audioSource: 'none' },
    }) as unknown as MatterbridgeEndpoint;

    // Recording keeps the stream open for the pre-roll (the seconds before a trigger)
    const keepConnected = camera.keepConnected === true || recording;
    const source = new RtspSource(rtspUrl, (level, message) => this.log[level](`${camera.name}: ${message}`), keepConnected);
    source.clipAudio = camera.clipAudio === 'off' ? 'off' : 'aac';
    source.wantOpus = liveAudio !== 'off';
    this.sources.push(source);
    const client = this.frigate;
    const media: CameraMedia = {
      name: camera.name,
      source,
      liveAudio,
      width,
      rotation,
      profileLevelId: info?.profileLevelId,
      frigateSnapshot: client && frigateCamera ? (w) => fitLatestJpeg(client, camera.name, w, { width: frigateCamera.detectWidth, height: frigateCamera.detectHeight }) : undefined,
      log: (level, message) => this.log[level === 'info' && routine(message) ? 'debug' : level](`${camera.name}: ${message}`),
    };
    camerasByUrl.set(rtspUrl, media);
    camerasByEndpoint.set(id, media);
    const behavior = (device as unknown as { behaviors: { supported: Record<string, { prototype: Record<string, unknown> }> } }).behaviors.supported.cameraAvStreamManagement;
    if (behavior) patchSnapshots(behavior);
    if (keepConnected) source.ensure().catch((e) => this.log.warn(`${camera.name}: ${String(e)}`));

    // Detections: Frigate's objects (and, when chosen, its motion) are motion on the Matter camera
    // (also when Frigate was unreachable at startup: the event feed connects when it is back)
    const hasDetections = camera.detections !== false && (!this.frigateConfig || !!frigateCamera);
    if (hasDetections) device.createDefaultOccupancySensingClusterServer(false);
    let rec: ReturnType<typeof createRecording> | undefined;
    if (recording) {
      const dir = path.join(this.matterbridge.matterbridgePluginDirectory, PLUGIN);
      fs.mkdirSync(dir, { recursive: true });
      const preRoll = new PreRollBuffer(source);
      preRoll.start();
      this.preRolls.push(preRoll);
      rec = createRecording({ name: camera.name, source, preRoll, store: new RecordingStore(path.join(dir, `recording-${id}.json`), say), width, height, rotation, log: say });
      device.behaviors.require(rec.PushAv, pushAvDefaults);
      if (hasDetections) device.behaviors.require(FrigateZoneServer, zoneDefaults(width, height));
    }
    await this.registerDevice(device);
    const runningCamera: RunningCamera = { name: camera.name, title, rtspUrl, source, width, height };
    Object.defineProperty(runningCamera, 'serverNode', { get: () => (device as unknown as { serverNode?: unknown }).serverNode, enumerable: true });
    this.running.set(camera.name, runningCamera);
    if (rec) {
      const node = (device as unknown as { serverNode?: { behaviors: { require: (type: unknown, options: unknown) => void } } }).serverNode;
      if (node) {
        node.behaviors.require(rec.TlsCertificates, tlsCertificateDefaults);
        node.behaviors.require(rec.TlsClients, tlsClientDefaults);
        node.behaviors.require(rec.TimeSync, timeSyncDefaults);
      } else {
        this.log.error(`${camera.name}: recording needs the camera's own Matter node, but Matterbridge did not create one`);
      }
    }
    this.followVolumes(camera, device, source);
    if (hasDetections) {
      const detections = new CameraDetections(camera.name, { labels: camera.objects ?? [], zones: camera.zones ?? [], useMotion: camera.motion === true }, (occupied, why) => this.setMotion(camera, device, occupied, why, !!rec, rec?.PushAv));
      this.detections.set(camera.name, detections);
      runningCamera.detections = detections;
    }
    const features = [
      `${width}x${height} from ${camera.rtspUrl ? redactUrl(camera.rtspUrl) : `go2rtc "${camera.stream}"`}`,
      liveAudio === 'off' ? 'no live audio' : 'live audio',
      recording ? `recording${source.clipAudio === 'off' ? ' without audio' : ''}` : 'no recording',
      hasDetections ? `detections (${camera.objects?.length ? camera.objects.join(', ') : 'all objects'}${camera.zones?.length ? ` in ${camera.zones.join(', ')}` : ''}${camera.motion ? ', motion' : ''})` : 'no detections',
      rotation ? `turned ${rotation}°` : '',
    ].filter(Boolean);
    this.log.notice(`${camera.name}: added to Matter as "${title}" (${features.join(', ')}); pair it with its own QR code (plugin page or Devices)`);
  }

  /** Occupancy, Zone events and the Push AV motion trigger (records a clip) for one camera. */
  private setMotion(camera: CameraConfig, device: MatterbridgeEndpoint, occupied: boolean, why: string, zones: boolean, pushAv?: ReturnType<typeof createRecording>['PushAv']): void {
    device.setAttribute('occupancySensing', 'occupancy', { occupied }).catch((e: unknown) => this.log.warn(`${camera.name}: could not update motion: ${String(e)}`));
    const act = (device as unknown as { act: (fn: (agent: { get: (t: unknown) => unknown }) => void) => unknown }).act.bind(device);
    if (zones) {
      Promise.resolve(act((agent) => (agent.get(FrigateZoneServer) as FrigateZoneServer).reportMotion(occupied))).catch((e: unknown) => this.log.warn(`${camera.name}: zone event failed: ${String(e)}`));
    }
    if (pushAv && occupied) {
      // Push AV transports with the Motion trigger type record on their own
      Promise.resolve(act((agent) => (agent.get(pushAv) as { motion: (active: boolean) => void }).motion(true))).catch((e: unknown) => this.log.warn(`${camera.name}: recording trigger failed: ${String(e)}`));
    }
    this.log.notice(`${camera.name}: ${occupied ? `detected: ${why}` : `clear (${why})`} -> Matter motion ${occupied ? 'on' : 'off'}`);
  }

  private startDetections(): void {
    const feed = new DetectionFeed(
      {
        onObject: (event: FrigateObjectEvent) => {
          this.log.debug(`[frigate] ${event.type} ${event.camera} ${event.label}${event.score ? ` ${Math.round(event.score * 100)}%` : ''}${event.zones.length ? ` zones ${event.zones.join(',')}` : ''}${event.stationary ? ' stationary' : ''}${event.falsePositive ? ' false positive' : ''}`);
          this.detections.get(event.camera)?.onObject(event);
        },
        onMotion: (camera, active) => this.detections.get(camera)?.onMotion(active),
      },
      (level, message) => this.log[level](message),
    );
    this.feed = feed;
    const mqtt = this.cfg.mqttHost
      ? { host: this.cfg.mqttHost, port: this.cfg.mqttPort || undefined, tls: this.cfg.mqttTls === true, username: this.cfg.mqttUser || undefined, password: this.cfg.mqttPassword || undefined, prefix: this.cfg.mqttTopicPrefix || 'frigate' }
      : undefined;
    // a lost connection may have missed the "end" of an object: forget what was active
    let wasConnected = false;
    const watch = setInterval(() => {
      if (wasConnected && !feed.status.connected) for (const d of this.detections.values()) d.reset();
      wasConnected = feed.status.connected;
    }, 2000);
    this.timers.push(watch);
    feed.start({ mqtt, frigate: this.frigate! });
  }

  private readonly timers: NodeJS.Timeout[] = [];

  /** The SmartThings microphone slider: a gain for the camera's sound (G.711 made into Opus / AAC). */
  private followVolumes(camera: CameraConfig, device: MatterbridgeEndpoint, source: RtspSource): void {
    const cluster = 'cameraAvStreamManagement';
    const value = (attribute: string): unknown => {
      try {
        return device.getAttribute(cluster, attribute);
      } catch {
        return undefined;
      }
    };
    const state: Record<string, unknown> = {};
    const apply = (): void => {
      source.micGain = levelToGain(state.microphoneVolumeLevel as number | undefined, state.microphoneMuted as boolean | undefined);
    };
    for (const attribute of ['microphoneVolumeLevel', 'microphoneMuted']) {
      state[attribute] = value(attribute);
      try {
        device.subscribeAttribute(cluster, attribute, (newValue: unknown) => {
          state[attribute] = newValue;
          apply();
          this.log.info(`${camera.name}: ${attribute} = ${String(newValue)} (camera sound ${source.micGain === 0 ? 'muted' : `${(20 * Math.log10(source.micGain)).toFixed(1)} dB`})`);
        });
      } catch (error) {
        this.log.debug(`${camera.name}: cannot follow ${attribute}: ${String(error)}`);
      }
    }
    apply();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure');
  }

  /** The plugin page API (/plugins/<plugin>/api/:path). */
  override async onFetch(method: string, apiPath?: string, _query?: Record<string, unknown>, body?: unknown): Promise<unknown> {
    return this.setup.handle(method, apiPath, body);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.setup.stop();
    this.feed?.stop();
    for (const timer of this.timers) clearInterval(timer);
    for (const d of this.detections.values()) d.stop();
    this.detections.clear();
    this.running.clear();
    for (const preRoll of this.preRolls) preRoll.stop();
    for (const source of this.sources) source.stop();
    camerasByUrl.clear();
    camerasByEndpoint.clear();
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }
}
