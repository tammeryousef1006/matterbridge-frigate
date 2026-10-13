/**
 * Matterbridge's camera keeps its (certified) Matter signaling; only the media of a WebRTC session is replaced
 * for the cameras of this plugin: our RTSP client passes the go2rtc restream's H.264 through (no ffmpeg), with
 * Opus audio (go2rtc's Opus track as is, or made here from G.711). Snapshots come from Frigate, with the
 * built-in decoder as the backup.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { alawToUlaw, g711ToPcm, pcmRms, ulawToAlaw } from './audio.js';
import { snapshotFromKeyframe } from './snapshot.js';
import { H264Packetizer, RtspSource, h264ProfileName, isG711 } from './rtsp.js';

export interface CameraMedia {
  name: string;
  /** Live view audio: Opus (go2rtc's Opus track, or made from G.711), the G.711 as is (pcma/pcmu), or none. */
  liveAudio?: 'opus' | 'pcma' | 'pcmu' | 'off';
  source: RtspSource;
  /** A JPEG of the camera from Frigate, at most 64000 B, about the given width (undefined: use the stream). */
  frigateSnapshot?: (width: number) => Promise<{ data: Buffer; width: number; height: number; note: string }>;
  /** The last snapshot made from the stream, sent again while the camera is unreachable. */
  lastSnapshot?: { data: Buffer; width: number; height: number; at: number };
  /** Picture width, for snapshots. */
  width?: number;
  /** Clockwise degrees (0, 90, 180, 270) from the settings. */
  rotation?: number;
  /** From the stream check at startup, so the codec can be chosen before the stream is open. */
  profileLevelId?: string;
  log: (level: 'info' | 'warn' | 'debug', message: string) => void;
}

/** Cameras by the RTSP URL given to Matterbridge's WebRTC session as videoSourceDevice. */
export const camerasByUrl = new Map<string, CameraMedia>();
/** Cameras by Matterbridge endpoint id, for snapshots. */
export const camerasByEndpoint = new Map<string, CameraMedia>();

function findUp(start: string, relative: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface Werift {
  MediaStreamTrack: new (props: { kind: 'video' | 'audio' }) => { writeRtp: (rtp: Buffer) => void; stop: () => void };
  RTCRtpCodecParameters: new (props: Record<string, unknown>) => unknown;
}
interface Codec {
  mimeType: string;
  payloadType: number;
  parameters?: string;
}
interface Session {
  options: { videoSource?: string; videoSourceDevice?: string };
  peerConnection: {
    addTrack: (track: unknown) => void;
    getTransceivers: () => { kind: string; codecs: Codec[]; sender: { codec?: Codec; track?: { codec?: Codec } } }[];
    config: { codecs: { audio?: unknown[] }; headerExtensions: { audio?: { id: number; uri: string }[]; video?: { id: number; uri: string }[] } };
  };
  log: { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void };
  testVideoAttached: boolean;
  testVideoUdpDisposer?: () => void;
  frigateCodec?: Codec;
  frigateAudioCodec?: Codec;
  testAudioAttached: boolean;
  testAudioUdpDisposer?: () => void;
  /** RTP header extension id of the video orientation (CVO) the hub offered, when the picture is turned. */
  frigateCvoId?: number;
}

const CVO_URI = 'urn:3gpp:video-orientation';

/**
 * Adds the video orientation (CVO, 3GPP TS 26.114) to an RTP packet: one-byte header extension, rotation in
 * 90° steps (WebRTC receivers turn the picture clockwise by that much when showing it). No re-encoding.
 */
function withCvo(packet: Buffer, id: number, rotation: number): Buffer {
  if (packet[0] & 0x10) return packet; // already has an extension
  const headerLength = 12 + 4 * (packet[0] & 0x0f);
  const extension = Buffer.from([0xbe, 0xde, 0x00, 0x01, (id << 4) | 0, (Math.round(rotation / 90) & 3), 0, 0]);
  const out = Buffer.concat([packet.subarray(0, headerLength), extension, packet.subarray(headerLength)]);
  out[0] |= 0x10;
  return out;
}

/** Audio codecs in an SDP offer: "PCMA/8000 (8)" style, from the audio m= section. */
function offeredAudio(sdp: string): { name: string; payloadType: number; text: string }[] {
  const section = sdp.split(/\r?\n(?=m=)/).find((m) => m.startsWith('m=audio'));
  if (!section) return [];
  return [...section.matchAll(/a=rtpmap:(\d+) ([^\r\n]+)/g)].map((m) => ({ name: m[2].split('/')[0], payloadType: Number(m[1]), text: `${m[2]} (${m[1]})` }));
}

interface Pair {
  localCandidate?: { host?: string };
  remoteCandidate?: { host?: string };
}

let patched = false;

/** Patch Matterbridge's WebRTC session and snapshot code (once). Returns what was found, for the log. */
export async function installMediaPatches(): Promise<string> {
  if (patched) return 'already installed';
  const matterbridgeEntry = fileURLToPath(import.meta.resolve('matterbridge'));
  const sessionFile = findUp(path.dirname(matterbridgeEntry), 'node_modules/@matterbridge/core/dist/behaviors/weriftSession.js') ?? findUp(path.dirname(matterbridgeEntry), '../core/dist/behaviors/weriftSession.js');
  if (!sessionFile) throw new Error('Matterbridge camera support not found (needs Matterbridge 3.10.4 or later)');
  const coreDir = path.resolve(path.dirname(sessionFile), '../..');
  const weriftDir = findUp(coreDir, 'node_modules/werift');
  if (!weriftDir) throw new Error('werift not found next to Matterbridge');
  const { WeriftWebRtcSession } = (await import(pathToFileURL(sessionFile).href)) as { WeriftWebRtcSession: { prototype: Record<string, unknown> } };
  const werift = (await import(pathToFileURL(path.join(weriftDir, 'lib/index.mjs')).href)) as Werift;

  const proto = WeriftWebRtcSession.prototype as Record<string, (...args: unknown[]) => unknown>;
  const originalGenerate = proto.generateVideoTrack;
  const originalPreferred = proto.getPreferredInjectableVideoCodec;
  const originalPrefer = proto.preferVideoCodecOnTransceivers;

  // Choose the H.264 variant the hub offered that matches the camera (same profile, packetization-mode 1)
  proto.getPreferredInjectableVideoCodec = function (this: Session) {
    const camera = camerasByUrl.get(this.options.videoSourceDevice ?? '');
    if (!camera) return originalPreferred.call(this);
    const offered = this.peerConnection.getTransceivers().filter((t) => t.kind === 'video').flatMap((t) => t.codecs);
    this.log.info(`[frigate] hub offered video codecs: ${offered.map((c) => `${c.mimeType}/${c.payloadType} ${c.parameters ?? ''}`).join(' | ') || 'none'}`);
    const h264 = offered.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    const cameraProfileLevelId = camera.source.video?.profileLevelId ?? camera.profileLevelId;
    const cameraProfile = cameraProfileLevelId?.slice(0, 2).toLowerCase();
    const mode1 = h264.filter((c) => /packetization-mode=1/.test(c.parameters ?? ''));
    const pick = mode1.find((c) => cameraProfile && new RegExp(`profile-level-id=${cameraProfile}`, 'i').test(c.parameters ?? '')) ?? mode1[0] ?? h264[0];
    this.frigateCodec = pick;
    camera.log('info', `hub codec chosen: ${pick ? `${pick.mimeType}/${pick.payloadType} ${pick.parameters ?? ''}` : 'none'}; camera sends ${h264ProfileName(cameraProfileLevelId)}`);
    return pick;
  };
  proto.preferVideoCodecOnTransceivers = function (this: Session, mimeType: unknown) {
    if (!this.frigateCodec) return originalPrefer.call(this, mimeType);
    for (const transceiver of this.peerConnection.getTransceivers()) {
      if (transceiver.kind !== 'video') continue;
      transceiver.codecs = transceiver.codecs.filter((c) => c.payloadType === this.frigateCodec!.payloadType);
      // werift picked the sender codec (the hub's first) when the offer was applied; send with the chosen one
      transceiver.sender.codec = this.frigateCodec;
      if (transceiver.sender.track) transceiver.sender.track.codec = this.frigateCodec;
    }
  };

  const originalCreateAnswer = proto.createAnswer;
  const originalPreferredAudio = proto.getPreferredInjectableAudioCodec;
  const originalPreferAudio = proto.preferAudioCodecOnTransceivers;
  const originalGenerateAudio = proto.generateAudioTrack;

  // Camera audio for live view: G.711 (PCMA/PCMU) passes through when the hub offers it; anything else needs ffmpeg
  proto.getPreferredInjectableAudioCodec = function (this: Session) {
    if (!this.frigateAudioCodec) return originalPreferredAudio.call(this);
    const codec = this.peerConnection
      .getTransceivers()
      .filter((t) => t.kind === 'audio')
      .flatMap((t) => t.codecs)
      .find((c) => c.mimeType.toLowerCase() === this.frigateAudioCodec!.mimeType.toLowerCase());
    if (codec) this.frigateAudioCodec = codec;
    return codec ?? originalPreferredAudio.call(this);
  };
  proto.preferAudioCodecOnTransceivers = function (this: Session, mimeType: unknown) {
    if (!this.frigateAudioCodec) return originalPreferAudio.call(this, mimeType);
    for (const transceiver of this.peerConnection.getTransceivers()) {
      if (transceiver.kind !== 'audio') continue;
      transceiver.codecs = transceiver.codecs.filter((c) => c.payloadType === this.frigateAudioCodec!.payloadType);
      transceiver.sender.codec = this.frigateAudioCodec;
      if (transceiver.sender.track) transceiver.sender.track.codec = this.frigateAudioCodec;
    }
  };
  proto.generateAudioTrack = async function (this: Session, codec: unknown) {
    const camera = camerasByUrl.get(this.options.videoSourceDevice ?? '');
    const selected = codec as Codec | undefined;
    if (!camera || !this.frigateAudioCodec || this.testAudioAttached || selected?.payloadType !== this.frigateAudioCodec.payloadType) return originalGenerateAudio.call(this, codec);
    const track = new werift.MediaStreamTrack({ kind: 'audio' });
    this.peerConnection.addTrack(track);
    const fromCodec = camera.source.audio?.codec.toLowerCase() ?? '';
    const opus = /opus/i.test(selected.mimeType);
    // RTP clock: Opus 48 kHz (each packet carries its own duration, usually 20 ms), G.711 8 kHz (20 ms packets)
    const convert = opus ? undefined : fromCodec === 'pcma' && /pcmu/i.test(selected.mimeType) ? alawToUlaw : fromCodec === 'pcmu' && /pcma/i.test(selected.mimeType) ? ulawToAlaw : undefined;
    // Steady 20 ms packets with our own continuous timestamps, paced like a real audio source
    // each 20 ms frame with whether it is quiet: when the delay grows, quiet frames are skipped first (inaudible)
    const queue: { payload: Buffer; quiet: boolean; ms: number; step: number }[] = [];
    const QUIET = 300; // RMS of 32767: about -40 dBFS
    let pending = Buffer.alloc(0);
    let skipped = 0;
    let seq = Math.floor(Math.random() * 0xffff);
    let timestamp = Math.floor(Math.random() * 0xffffffff);
    let sent = 0;
    let dropped = 0;
    let first = true;
    const steps: number[] = [];
    let lastCameraTs: number | undefined;
    const unsubscribe = camera.source.subscribeAudio((packet) => {
      if (packet.pcm) return;
      if (opus && camera.source.opusAudio) return;
      if (lastCameraTs !== undefined && steps.length < 6) steps.push((packet.timestamp - lastCameraTs) >>> 0);
      lastCameraTs = packet.timestamp;
      if (steps.length === 6) {
        camera.log('info', `camera audio: ${packet.payload.length} B packets, timestamp steps ${steps.join(', ')} (${packet.payload.length} expected); sent as 20 ms ${selected.mimeType} packets${convert || opus ? ' (converted)' : ''}`);
        steps.push(0);
      }
      if (opus) return;
      pending = Buffer.concat([pending, convert ? convert(packet.payload) : packet.payload]);
      while (pending.length >= 160) {
        const payload = pending.subarray(0, 160);
        queue.push({ payload, quiet: pcmRms(g711ToPcm(payload, convert === alawToUlaw || (!convert && fromCodec === 'pcmu') ? 'pcmu' : 'pcma')) < QUIET, ms: 20, step: 160 });
        pending = pending.subarray(160);
      }
      trim();
    });
    // keep the delay low without audible gaps: above 200 ms skip a quiet frame, only above 500 ms drop any frame
    const queued = (): number => queue.reduce((a, q) => a + q.ms, 0);
    const trim = (): void => {
      if (queued() > 200) {
        const i = queue.findIndex((q) => q.quiet);
        if (i >= 0) {
          queue.splice(i, 1);
          skipped++;
        }
      }
      while (queued() > 500) {
        queue.shift();
        dropped++;
      }
    };
    const unsubscribeOpus = opus
      ? camera.source.subscribeOpus((frame, rms, samples) => {
          queue.push({ payload: frame, quiet: rms < QUIET, ms: samples / 48, step: samples });
          trim();
        })
      : undefined;
    let next = Date.now();
    const pace = setInterval(() => {
      const now = Date.now();
      // send everything that is due (timers are not exact), one packet per its duration of wall time
      while (next <= now && queue.length) {
        const { payload, ms, step } = queue.shift()!;
        const header = Buffer.alloc(12);
        header[0] = 0x80;
        header[1] = (first ? 0x80 : 0) | (selected.payloadType & 0x7f);
        first = false;
        header.writeUInt16BE(seq, 2);
        seq = (seq + 1) & 0xffff;
        header.writeUInt32BE(timestamp >>> 0, 4);
        timestamp = (timestamp + step) >>> 0;
        track.writeRtp(Buffer.concat([header, payload]));
        sent++;
        next += ms;
      }
      if (!queue.length && next < now) next = now;
    }, 10);
    this.testAudioUdpDisposer = () => {
      clearInterval(pace);
      unsubscribe();
      unsubscribeOpus?.();
      track.stop();
      const trimmed = [skipped ? `${skipped} quiet frames skipped` : '', dropped ? `${dropped} dropped` : ''].filter(Boolean).join(', ');
      camera.log('info', `audio ended after ${sent} RTP packets${trimmed ? ` (${trimmed} to keep the delay low)` : ''}`);
    };
    this.testAudioAttached = true;
    const what = opus ? (camera.source.opusAudio ? "go2rtc's Opus passed through" : `Opus made from ${fromCodec.toUpperCase()}`) : convert ? `${fromCodec.toUpperCase()} converted` : `${fromCodec.toUpperCase()} as is`;
    camera.log('info', `audio attached (${selected.mimeType}, payload type ${selected.payloadType}: ${what})`);
  };

  proto.createAnswer = async function (this: Session, ...args: unknown[]) {
    const camera = camerasByUrl.get(this.options.videoSourceDevice ?? '');
    if (camera) {
      // Only pair our addresses that are on the hub's network (not Docker or VPN interfaces)
      const config = (this.peerConnection as unknown as { config: { iceFilterCandidatePair?: (pair: Pair) => boolean } }).config;
      config.iceFilterCandidatePair = (pair: Pair) => {
        const local = pair.localCandidate?.host;
        const remote = pair.remoteCandidate?.host;
        if (!local || !remote || !/^\d+\.\d+\.\d+\.\d+$/.test(remote)) return true;
        const sameNet = (a: string): boolean => a.split('.').slice(0, 3).join('.') === remote.split('.').slice(0, 3).join('.');
        if (sameNet(local)) return true;
        const anyLocalOnHubNet = Object.values(os.networkInterfaces()).flat().some((i) => i?.family === 'IPv4' && !i.internal && sameNet(i.address));
        return !anyLocalOnHubNet;
      };
    }
    if (camera) await camera.source.ensure().catch((error) => camera.log('warn', `camera stream: ${String(error)}`));
    if (camera?.rotation && typeof args[0] === 'string') {
      // turning live video without re-encoding: the WebRTC video orientation extension (CVO), if the hub offers it
      const video = args[0].split(/\r?\n(?=m=)/).find((m) => m.startsWith('m=video')) ?? '';
      const extensions = [...video.matchAll(/a=extmap:(\d+)(?:\/\w+)? (\S+)/g)].map((m) => ({ id: Number(m[1]), uri: m[2] }));
      const cvo = extensions.find((e) => e.uri === CVO_URI);
      if (cvo) {
        // accepted in the answer by werift when it is in the configuration before the offer is applied
        const config = this.peerConnection.config;
        config.headerExtensions ??= {};
        const list = (config.headerExtensions.video ??= []);
        if (!list.some((e) => e.uri === CVO_URI)) list.push({ id: cvo.id, uri: CVO_URI });
        this.frigateCvoId = cvo.id;
      }
      camera.log('info', `rotation ${camera.rotation}°: hub video extensions: ${extensions.map((e) => e.uri).join(', ') || 'none'}; ${cvo ? `live view turned with the video orientation extension (id ${cvo.id})` : 'video orientation (CVO) not offered: live view stays as the camera sends it (clips and snapshots are turned)'}`);
    }
    if (camera && typeof args[0] === 'string') {
      const hub = offeredAudio(args[0]);
      const source = camera.source;
      const cameraAudio = source.audio ?? source.describedAudio;
      // what we send: Opus (go2rtc's Opus track, or made from G.711), or the G.711 itself (setting liveAudio)
      const setting = camera.liveAudio ?? 'opus';
      const sendAs = setting === 'off' ? undefined : setting;
      const usable = sendAs === 'opus' ? !!source.opusAudio || isG711(source.audio) : isG711(source.audio);
      const match = usable && sendAs ? hub.find((c) => c.name.toLowerCase() === sendAs) : undefined;
      const aacName = (codec: string): string => (/mpeg4-generic/i.test(codec) ? 'AAC' : codec.toUpperCase());
      const verdict = match
        ? match.name.toLowerCase() === 'opus'
          ? source.opusAudio
            ? "passing go2rtc's Opus through"
            : `converting the ${source.audio!.codec} to Opus`
          : source.audio!.codec.toLowerCase() === match.name.toLowerCase()
            ? `passing the ${match.name} through`
            : `converting the ${source.audio!.codec} to ${match.name}`
        : setting === 'off'
          ? 'live audio switched off in the settings'
          : !cameraAudio
            ? 'the stream has no audio'
            : `no live audio: the stream has ${source.describedAudios.map((a) => aacName(a.codec)).join(', ')}${hub.length ? '' : ', and the hub offers no audio'}; add an Opus track in go2rtc for live audio (stream source "ffmpeg:${camera.name}#audio=opus")`;
      camera.log('info', `hub offered audio codecs: ${hub.map((c) => c.text).join(' | ') || 'none'}; ${verdict}`);
      if (match) {
        // werift only answers with codecs it was created with (Opus, PCMU): add PCMA when needed (Opus is always there)
        const list = (this.peerConnection.config.codecs.audio ??= []);
        const known = list.some((c) => (c as Codec).mimeType?.toLowerCase() === `audio/${match.name.toLowerCase()}`);
        if (!known && match.name.toLowerCase() !== 'opus') list.push(new werift.RTCRtpCodecParameters({ mimeType: `audio/${match.name.toUpperCase()}`, clockRate: 8000, channels: 1, payloadType: match.payloadType }));
        this.frigateAudioCodec = { mimeType: match.name.toLowerCase() === 'opus' ? 'audio/OPUS' : `audio/${match.name.toUpperCase()}`, payloadType: match.payloadType };
      }
    }
    const answer = await originalCreateAnswer.apply(this, args);
    return answer;
  };

  proto.generateVideoTrack = async function (this: Session, codec: unknown) {
    const camera = camerasByUrl.get(this.options.videoSourceDevice ?? '');
    if (!camera || this.testVideoAttached) return originalGenerate.call(this, codec);
    const selected = (codec as Codec | undefined) ?? this.frigateCodec;
    if (!selected || selected.mimeType.toLowerCase() !== 'video/h264') {
      camera.log('warn', `the hub did not offer H264 (got ${selected?.mimeType ?? 'nothing'}); no video`);
      return;
    }
    {
      // Our RTSP client -> werift track, no ffmpeg
      await camera.source.ensure().catch((error) => camera.log('warn', `camera stream: ${String(error)}`));
      const track = new werift.MediaStreamTrack({ kind: 'video' });
      this.peerConnection.addTrack(track);
      const packetizer = new H264Packetizer(
        () => camera.source.sps,
        () => camera.source.pps,
      );
      let sent = 0;
      let firstAt = 0;
      const cvoId = this.frigateCvoId;
      const turn = (packet: Buffer): Buffer => (cvoId && camera.rotation ? withCvo(packet, cvoId, camera.rotation) : packet);
      // instant start: once the connection to the hub is up, the frames since the last keyframe go first
      // (frames sent before that are lost), then live; without cached frames the next keyframe starts the picture
      const started = Date.now();
      let connected = false;
      const pc = this.peerConnection as unknown as { connectionState: string; connectionStateChange: { subscribe: (fn: (state: string) => void) => unknown } };
      const onConnected = (): void => {
        if (connected) return;
        connected = true;
        const cached = camera.source.gop[0]?.keyframe ? [...camera.source.gop] : [];
        for (const au of cached) for (const packet of packetizer.packetize(au)) {
          track.writeRtp(turn(packet));
          sent++;
        }
        if (cached.length && !firstAt) {
          firstAt = Date.now();
          camera.log('info', `first keyframe sent to the hub as soon as connected (${cached.length} cached frames, ${firstAt - started} ms after the offer)`);
        }
      };
      if (pc.connectionState === 'connected') onConnected();
      else pc.connectionStateChange.subscribe((state) => state === 'connected' && onConnected());
      const unsubscribe = camera.source.subscribe((au) => {
        if (!connected) return;
        for (const packet of packetizer.packetize(au)) {
          track.writeRtp(turn(packet));
          sent++;
          if (!firstAt) {
            firstAt = Date.now();
            camera.log('info', `first keyframe sent to the hub after ${firstAt - started} ms`);
          }
        }
      });
      const stats = setInterval(() => camera.log('debug', `video session: ${sent} RTP packets sent; ${camera.source.stats()}`), 10_000);
      this.testVideoUdpDisposer = () => {
        clearInterval(stats);
        unsubscribe();
        track.stop();
        camera.log('info', `video session ended after ${sent} RTP packets`);
      };
      this.testVideoAttached = true;
      camera.log('info', `video pass-through attached (payload type ${selected.payloadType})`);
    }
  };
  patched = true;
  return `patched ${sessionFile}`;
}

/**
 * captureSnapshot of a camera's stream management behavior: Frigate's latest frame (fitted to 64000 B), else a
 * keyframe of the restream decoded here (also when the picture is turned: Frigate cannot turn it), else the last
 * snapshot sent. Never Matterbridge's ffmpeg.
 */
export function patchSnapshots(behaviorType: { prototype: Record<string, unknown> }): void {
  const proto = behaviorType.prototype as Record<string, unknown> & { __frigate?: boolean };
  if (proto.__frigate) return;
  const original = proto.captureSnapshot as (this: { endpoint: { maybeId?: string } }, request: unknown) => Promise<unknown>;
  proto.captureSnapshot = async function (this: { endpoint: { maybeId?: string } }, request: { requestedResolution?: { width: number; height: number } }) {
    const camera = camerasByEndpoint.get(this.endpoint.maybeId ?? '');
    if (!camera) return original.call(this, request);
    camera.log('info', `[hub] CaptureSnapshot ${JSON.stringify(request)}`);
    const wanted = request.requestedResolution?.width ?? 1280;
    const keep = (data: Buffer, width: number, height: number): { data: Buffer; imageCodec: number; resolution: { width: number; height: number } } => {
      camera.lastSnapshot = { data, width, height, at: Date.now() };
      return { data, imageCodec: 0, resolution: { width, height } };
    };
    const problems: string[] = [];
    if (camera.frigateSnapshot && !camera.rotation) {
      const started = Date.now();
      try {
        const shot = await camera.frigateSnapshot(wanted);
        camera.log('info', `snapshot from Frigate: ${shot.data.length} B, ${shot.width}x${shot.height}, ${shot.note}, ${Date.now() - started} ms`);
        return keep(shot.data, shot.width, shot.height);
      } catch (error) {
        problems.push(`Frigate: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const started = Date.now();
    try {
      const cached = camera.source.lastKeyframe && Date.now() - camera.source.lastKeyframe.at < 3000;
      const au = await camera.source.latestKeyframe();
      const waited = Date.now() - started;
      const shot = await snapshotFromKeyframe(au, camera.source.sps, camera.source.pps, wanted, camera.width ?? 1920, camera.rotation ?? 0);
      camera.log(problems.length ? 'warn' : 'info', `snapshot from the stream${problems.length ? ` (${problems.join('; ')})` : ''}: ${shot.data.length} B, ${shot.width}x${shot.height}, quality ${shot.quality}, ${Date.now() - started} ms (${cached ? 'cached keyframe' : `waited ${waited} ms for a keyframe`})`);
      return keep(shot.data, shot.width, shot.height);
    } catch (error) {
      problems.push(`stream: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Frigate and the stream are both unreachable: send the last picture we have (or fail)
    const last = camera.lastSnapshot;
    if (last) {
      camera.log('warn', `snapshot failed (${problems.join('; ')}); sending the last snapshot (${Math.round((Date.now() - last.at) / 1000)} s old)`);
      return { data: last.data, imageCodec: 0, resolution: { width: last.width, height: last.height } };
    }
    camera.log('warn', `snapshot failed (${problems.join('; ')}); no earlier snapshot to send`);
    throw new Error(problems.join('; '));
  };
  // Log every stream command the hub sends, and any error returned to it
  for (const command of ['videoStreamAllocate', 'videoStreamModify', 'videoStreamDeallocate', 'audioStreamAllocate', 'audioStreamDeallocate', 'snapshotStreamAllocate', 'snapshotStreamModify', 'snapshotStreamDeallocate', 'setStreamPriorities', 'captureSnapshot']) {
    const method = proto[command] as ((this: { endpoint: { maybeId?: string } }, request: unknown) => unknown) | undefined;
    if (typeof method !== 'function') continue;
    proto[command] = async function (this: { endpoint: { maybeId?: string } }, request: unknown) {
      const camera = camerasByEndpoint.get(this.endpoint.maybeId ?? '');
      if (command !== 'captureSnapshot') camera?.log('info', `[hub] ${command} ${JSON.stringify(request)}`);
      try {
        const result = await method.call(this, request);
        if (command !== 'captureSnapshot') camera?.log('info', `[hub] ${command} answered ${JSON.stringify(result) ?? 'ok'}`);
        return result;
      } catch (error) {
        camera?.log('warn', `[hub] ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    };
  }
  proto.__frigate = true;
}
