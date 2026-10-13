import * as net from 'node:net';

import { AacEncoder, OpusDecoder, OpusEncoder, applyGain, g711ToPcm, pcmRms } from './audio.js';
import { authorization, pickChallenge } from './digest.js';

/** What a camera says about its video in the RTSP DESCRIBE answer. */
export interface RtspVideoInfo {
  codec: string;
  payloadType: number;
  clockRate: number;
  fmtp: string;
  /** e.g. "640028" (High, level 4.0). */
  profileLevelId?: string;
  packetizationMode?: number;
  sps?: Buffer;
  pps?: Buffer;
  control: string;
}

/** What a camera says about its audio. */
export interface RtspAudioInfo {
  codec: string;
  payloadType: number;
  clockRate: number;
  channels?: number;
  fmtp: string;
  control: string;
  /** AAC (MPEG4-GENERIC): AudioSpecificConfig and the AU header layout (RFC 3640). */
  config?: Buffer;
  sizeLength?: number;
  indexLength?: number;
}

export interface RtspDescription {
  status: number;
  sdp: string;
  video?: RtspVideoInfo;
  audio?: RtspAudioInfo;
  /** Every audio track (go2rtc restreams can carry the camera's audio and an Opus copy). */
  audios: RtspAudioInfo[];
  server?: string;
}

/** One RTP audio packet from the camera; AAC packets are also split into raw AAC frames. */
export interface AudioPacket {
  timestamp: number;
  marker: boolean;
  payload: Buffer;
  frames?: Buffer[];
  /** The track it came from. */
  track?: RtspAudioInfo;
  /** The payload is 16-bit 8 kHz PCM decoded from Opus (stream without audio of its own). */
  pcm?: boolean;
}

/** The audio track clips carry. */
export interface ClipAudioFormat {
  codec: 'aac' | 'opus';
  label: string;
  /** AAC AudioSpecificConfig. */
  config?: Buffer;
  /** Track timescale = sample rate (Opus: 48000). */
  timescale: number;
  /** Samples per frame: AAC 1024, Opus 960 (20 ms). */
  frameDuration: number;
  channels?: number;
  /** Opus: the sample rate the encoder got (for dOps). */
  inputRate?: number;
  /** Encoder delay in samples, skipped by the clip's edit list. */
  priming?: number;
}

/** Audio codecs this plugin uses without converting: PCMA/PCMU for live view, AAC for clips. */
export const isAac = (audio?: RtspAudioInfo): boolean => /^mpeg4-generic$/i.test(audio?.codec ?? '') && !!audio?.config;
export const isG711 = (audio?: RtspAudioInfo): boolean => /^pcm[au]$/i.test(audio?.codec ?? '');
export const isOpus = (audio?: RtspAudioInfo): boolean => /^opus$/i.test(audio?.codec ?? '');

/** Duration of one Opus packet in 48 kHz samples, from its TOC byte (RFC 6716, 3.1). */
export function opusPacketSamples(packet: Buffer): number {
  if (!packet.length) return 960;
  const config = packet[0] >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const code = packet[0] & 3;
  const count = code === 0 ? 1 : code === 1 || code === 2 ? 2 : packet.length > 1 ? packet[1] & 0x3f : 1;
  return frame * count;
}

/** One H.264 access unit (all NAL units of one picture). */
export interface AccessUnit {
  timestamp: number;
  nals: Buffer[];
  keyframe: boolean;
}

interface Response {
  status: number;
  headers: Record<string, string[]>;
  body: string;
}

const header = (response: Response, name: string): string | undefined => response.headers[name.toLowerCase()]?.[0];

/** Read the profile name from profile-level-id (first byte is profile_idc). */
export function h264ProfileName(profileLevelId?: string): string {
  if (!profileLevelId || profileLevelId.length < 6) return 'unknown';
  const idc = parseInt(profileLevelId.slice(0, 2), 16);
  const iop = parseInt(profileLevelId.slice(2, 4), 16);
  const level = parseInt(profileLevelId.slice(4, 6), 16) / 10;
  const name = idc === 66 ? ((iop & 0x40) !== 0 ? 'Constrained Baseline' : 'Baseline') : idc === 77 ? 'Main' : idc === 100 ? 'High' : `profile_idc ${idc}`;
  return `${name} ${level}`;
}

/** Profile-level-id from an SPS NAL (bytes 1..3). */
const profileFromSps = (sps: Buffer): string => sps.subarray(1, 4).toString('hex');

export function parseSdp(sdp: string, baseUrl: string): Pick<RtspDescription, 'video' | 'audio' | 'audios'> {
  const result: Pick<RtspDescription, 'video' | 'audio' | 'audios'> = { audios: [] };
  const sections = sdp.split(/\r?\n(?=m=)/);
  for (const section of sections.slice(1)) {
    const lines = section.split(/\r?\n/);
    const [kind, , , pt] = lines[0].slice(2).split(' ');
    const rtpmap = lines.find((l) => l.startsWith(`a=rtpmap:${pt} `))?.split(' ')[1] ?? '';
    const [codec, clock, channels] = rtpmap.split('/');
    const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${pt} `))?.slice(`a=fmtp:${pt} `.length) ?? '';
    let control = lines.find((l) => l.startsWith('a=control:'))?.slice('a=control:'.length).trim() ?? '';
    if (control && !/^rtsp:/i.test(control)) control = baseUrl.replace(/\/?$/, '/') + control;
    if (!control) control = baseUrl;
    if (kind === 'video' && !result.video) {
      const params = Object.fromEntries(fmtp.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k.toLowerCase(), v.join('=')]));
      const sprop = (params['sprop-parameter-sets'] ?? '').split(',').filter(Boolean).map((s: string) => Buffer.from(s, 'base64'));
      const sps = sprop.find((n: Buffer) => (n[0] & 0x1f) === 7);
      const pps = sprop.find((n: Buffer) => (n[0] & 0x1f) === 8);
      result.video = {
        codec: codec ?? 'unknown',
        payloadType: Number(pt),
        clockRate: Number(clock) || 90000,
        fmtp,
        profileLevelId: params['profile-level-id'] ?? (sps ? profileFromSps(sps) : undefined),
        packetizationMode: params['packetization-mode'] !== undefined ? Number(params['packetization-mode']) : undefined,
        sps,
        pps,
        control,
      };
    } else if (kind === 'audio') {
      const params = Object.fromEntries(fmtp.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k.toLowerCase(), v.join('=')]));
      // static payload types have no rtpmap: 0 = PCMU, 8 = PCMA
      const name = codec || (pt === '0' ? 'PCMU' : pt === '8' ? 'PCMA' : `payload ${pt}`);
      result.audios.push({
        codec: name,
        payloadType: Number(pt),
        clockRate: Number(clock) || 8000,
        channels: channels ? Number(channels) : undefined,
        fmtp,
        control,
        config: params.config ? Buffer.from(params.config, 'hex') : undefined,
        sizeLength: params.sizelength ? Number(params.sizelength) : undefined,
        indexLength: params.indexlength ? Number(params.indexlength) : undefined,
      });
      result.audio ??= result.audios[0];
    }
  }
  return result;
}

/**
 * Minimal RTSP client: DESCRIBE, SETUP (RTP over the RTSP TCP connection), PLAY, keep-alive.
 * Delivers H.264 access units, rebuilt from the RTP packets (single NAL, STAP-A, FU-A).
 */
export class RtspClient {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private cseq = 0;
  private pending?: { resolve: (r: Response) => void; reject: (e: Error) => void };
  private challenge?: ReturnType<typeof pickChallenge>;
  private session?: string;
  private keepAlive?: NodeJS.Timeout;
  private readonly url: string;
  private readonly user: string;
  private readonly pass: string;
  private readonly host: string;
  private readonly port: number;
  private closed = false;
  // H.264 reassembly
  private fu?: Buffer[];
  private lastSeq?: number;
  private au: Buffer[] = [];
  private auTimestamp?: number;
  onAccessUnit?: (au: AccessUnit) => void;
  onAudio?: (packet: AudioPacket) => void;
  /** Interleaved RTP channel of the video: the server's choice (go2rtc ignores the one asked for). */
  private videoChannel = 0;
  /** Audio tracks by their interleaved RTP channel (2, 4, ...). */
  private readonly audioChannels = new Map<number, RtspAudioInfo>();
  onClose?: (error?: Error) => void;
  /** Size of the biggest RTP packet seen (TCP lets cameras send packets far above the network MTU). */
  maxRtpPacket = 0;
  packets = 0;
  /** Gaps in the video sequence numbers (packets lost or out of order). */
  lostPackets = 0;

  constructor(url: string) {
    const parsed = new URL(url);
    this.user = decodeURIComponent(parsed.username);
    this.pass = decodeURIComponent(parsed.password);
    this.host = parsed.hostname;
    this.port = Number(parsed.port) || 554;
    parsed.username = '';
    parsed.password = '';
    this.url = parsed.toString();
  }

  private connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => socket.destroy(new Error(`could not connect to ${this.host}:${this.port} within ${timeoutMs} ms`)), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('data', (data) => this.onData(data));
      socket.on('close', () => {
        this.closed = true;
        clearInterval(this.keepAlive);
        this.pending?.reject(new Error('connection closed'));
        this.pending = undefined;
        this.onClose?.();
      });
      socket.on('error', () => undefined);
      this.socket = socket;
    });
  }

  private onData(data: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    for (;;) {
      if (this.buffer.length === 0) return;
      if (this.buffer[0] === 0x24) {
        if (this.buffer.length < 4) return;
        const length = this.buffer.readUInt16BE(2);
        if (this.buffer.length < 4 + length) return;
        const channel = this.buffer[1];
        const packet = this.buffer.subarray(4, 4 + length);
        this.buffer = this.buffer.subarray(4 + length);
        if (channel === this.videoChannel) this.onRtp(packet);
        else if (this.audioChannels.has(channel)) this.onAudioRtp(packet, this.audioChannels.get(channel)!);
        continue;
      }
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        // Not a response start: resync on the next interleaved frame
        if (!this.buffer.subarray(0, 5).toString().startsWith('RTSP')) {
          const next = this.buffer.indexOf(0x24);
          this.buffer = next < 0 ? Buffer.alloc(0) : this.buffer.subarray(next);
        }
        return;
      }
      const head = this.buffer.subarray(0, end).toString('utf8');
      const headers: Record<string, string[]> = {};
      const lines = head.split('\r\n');
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) (headers[line.slice(0, i).trim().toLowerCase()] ??= []).push(line.slice(i + 1).trim());
      }
      const length = Number(headers['content-length']?.[0] ?? 0);
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4 + length);
      const status = Number(lines[0].split(' ')[1]);
      const pending = this.pending;
      this.pending = undefined;
      pending?.resolve({ status, headers, body });
    }
  }

  private send(method: string, uri: string, extra: Record<string, string> = {}, timeoutMs = 8000): Promise<Response> {
    if (!this.socket || this.closed) return Promise.reject(new Error('not connected'));
    const headers: Record<string, string> = { CSeq: String(++this.cseq), 'User-Agent': 'matterbridge-frigate', ...extra };
    if (this.session) headers.Session = this.session;
    if (this.challenge && this.user) headers.Authorization = authorization(this.challenge, method, uri, this.user, this.pass);
    const text = `${method} ${uri} RTSP/1.0\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.socket!.write(text);
    });
  }

  /** Send a request, answering an authentication challenge once. */
  private async request(method: string, uri: string, extra: Record<string, string> = {}): Promise<Response> {
    let response = await this.send(method, uri, extra);
    if (response.status === 401 && this.user) {
      this.challenge = pickChallenge(response.headers['www-authenticate'] ?? []);
      if (this.challenge) response = await this.send(method, uri, extra);
    }
    return response;
  }

  /** Connect and DESCRIBE; keeps the connection open for play(). */
  async describe(timeoutMs = 6000, extraHeaders: Record<string, string> = {}): Promise<RtspDescription> {
    await this.connect(timeoutMs);
    const response = await this.request('DESCRIBE', this.url, { Accept: 'application/sdp', ...extraHeaders });
    const description: RtspDescription = { status: response.status, sdp: response.body, server: header(response, 'server'), audios: [] };
    if (response.status === 200) {
      const base = header(response, 'content-base') ?? header(response, 'content-location') ?? this.url;
      Object.assign(description, parseSdp(response.body, base));
    }
    return description;
  }

  /** SETUP the video track and the given audio tracks over TCP and PLAY. Returns the audio tracks that are on. */
  async play(video: RtspVideoInfo, audios: RtspAudioInfo[] = []): Promise<RtspAudioInfo[]> {
    // the channel in the answer counts: go2rtc numbers channels by its own track order, whatever was asked
    const channelOf = (response: Response, asked: number): number => {
      const match = /interleaved=(\d+)/.exec(header(response, 'transport') ?? '');
      return match ? Number(match[1]) : asked;
    };
    const setup = await this.request('SETUP', video.control, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    if (setup.status !== 200) throw new Error(`SETUP failed with status ${setup.status}`);
    this.videoChannel = channelOf(setup, 0);
    const sessionHeader = header(setup, 'session') ?? '';
    this.session = sessionHeader.split(';')[0];
    const on: RtspAudioInfo[] = [];
    for (const audio of audios) {
      if (audio.control === video.control) continue;
      let asked = 2 + on.length * 2;
      while (asked === this.videoChannel || this.audioChannels.has(asked)) asked += 2;
      const audioSetup = await this.request('SETUP', audio.control, { Transport: `RTP/AVP/TCP;unicast;interleaved=${asked}-${asked + 1}` }).catch(() => undefined);
      if (audioSetup?.status !== 200) continue;
      const channel = channelOf(audioSetup, asked);
      if (channel === this.videoChannel || this.audioChannels.has(channel)) continue;
      this.audioChannels.set(channel, audio);
      on.push(audio);
    }
    const timeout = Number(/timeout=(\d+)/.exec(sessionHeader)?.[1] ?? 60);
    const play = await this.request('PLAY', this.url, { Range: 'npt=0.000-' });
    if (play.status !== 200) throw new Error(`PLAY failed with status ${play.status}`);
    this.keepAlive = setInterval(() => {
      this.request('OPTIONS', this.url).catch(() => undefined);
    }, Math.max(5, timeout / 2) * 1000);
    return on;
  }

  private onAudioRtp(packet: Buffer, track: RtspAudioInfo): void {
    if (packet.length < 12 || !this.onAudio) return;
    const cc = packet[0] & 0x0f;
    let offset = 12 + cc * 4;
    if (packet[0] & 0x10) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
    let end = packet.length;
    if (packet[0] & 0x20) end -= packet[packet.length - 1];
    if (offset >= end) return;
    const payload = Buffer.from(packet.subarray(offset, end));
    const result: AudioPacket = { timestamp: packet.readUInt32BE(4), marker: (packet[1] & 0x80) !== 0, payload, track };
    if (isAac(track)) result.frames = aacFrames(payload, track.sizeLength ?? 13, track.indexLength ?? 3);
    this.onAudio(result);
  }

  close(): void {
    clearInterval(this.keepAlive);
    if (this.socket && !this.closed) {
      if (this.session) this.send('TEARDOWN', this.url, {}, 1000).catch(() => undefined);
      setTimeout(() => this.socket?.destroy(), 200);
    }
    this.closed = true;
  }

  private onRtp(packet: Buffer): void {
    if (packet.length < 12) return;
    this.packets++;
    if (packet.length > this.maxRtpPacket) this.maxRtpPacket = packet.length;
    const cc = packet[0] & 0x0f;
    const extension = (packet[0] & 0x10) !== 0;
    const padding = (packet[0] & 0x20) !== 0;
    const marker = (packet[1] & 0x80) !== 0;
    const seq = packet.readUInt16BE(2);
    const timestamp = packet.readUInt32BE(4);
    let offset = 12 + cc * 4;
    if (extension) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
    let end = packet.length;
    if (padding) end -= packet[packet.length - 1];
    if (offset >= end) return;
    const payload = packet.subarray(offset, end);
    const lost = this.lastSeq !== undefined && ((this.lastSeq + 1) & 0xffff) !== seq;
    this.lastSeq = seq;
    if (lost) {
      this.lostPackets++;
      this.fu = undefined;
    }

    if (this.auTimestamp !== undefined && timestamp !== this.auTimestamp) this.flush();
    this.auTimestamp = timestamp;

    const type = payload[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      this.au.push(Buffer.from(payload));
    } else if (type === 24) {
      let i = 1;
      while (i + 2 <= payload.length) {
        const size = payload.readUInt16BE(i);
        i += 2;
        if (i + size > payload.length) break;
        this.au.push(Buffer.from(payload.subarray(i, i + size)));
        i += size;
      }
    } else if (type === 28 && payload.length > 2) {
      const start = (payload[1] & 0x80) !== 0;
      const stop = (payload[1] & 0x40) !== 0;
      if (start) this.fu = [Buffer.from([(payload[0] & 0xe0) | (payload[1] & 0x1f)])];
      if (this.fu) {
        this.fu.push(Buffer.from(payload.subarray(2)));
        if (stop) {
          this.au.push(Buffer.concat(this.fu));
          this.fu = undefined;
        }
      }
    }
    if (marker) this.flush();
  }

  private flush(): void {
    if (this.au.length && this.auTimestamp !== undefined) {
      const nals = this.au;
      this.au = [];
      this.onAccessUnit?.({ timestamp: this.auTimestamp, nals, keyframe: nals.some((n) => (n[0] & 0x1f) === 5) });
    }
    this.au = [];
  }
}

/** Raw AAC frames from an RFC 3640 (AAC-hbr) RTP payload. */
export function aacFrames(payload: Buffer, sizeLength: number, indexLength: number): Buffer[] {
  if (payload.length < 2) return [];
  const headerBits = payload.readUInt16BE(0);
  const headerBytes = Math.ceil(headerBits / 8);
  const bitsPerHeader = sizeLength + indexLength;
  const count = Math.floor(headerBits / bitsPerHeader);
  const frames: Buffer[] = [];
  let offset = 2 + headerBytes;
  for (let i = 0; i < count; i++) {
    let size = 0;
    for (let b = 0; b < sizeLength; b++) {
      const bit = i * bitsPerHeader + b;
      size = (size << 1) | ((payload[2 + (bit >> 3)] >> (7 - (bit & 7))) & 1);
    }
    if (offset + size > payload.length) break;
    frames.push(payload.subarray(offset, offset + size));
    offset += size;
  }
  return frames;
}

/** Packetize access units into RTP for one viewer (own sequence numbers; werift sets SSRC and payload type). */
export class H264Packetizer {
  private seq = Math.floor(Math.random() * 0xffff);
  private started = false;
  constructor(
    private readonly sps: () => Buffer | undefined,
    private readonly pps: () => Buffer | undefined,
    private readonly mtu = 1200,
  ) {}

  packetize(au: AccessUnit): Buffer[] {
    if (!this.started) {
      if (!au.keyframe) return [];
      this.started = true;
    }
    let nals = au.nals.filter((n) => (n[0] & 0x1f) !== 9);
    if (au.keyframe && !nals.some((n) => (n[0] & 0x1f) === 7)) {
      const sps = this.sps();
      const pps = this.pps();
      nals = [...(sps ? [sps] : []), ...(pps ? [pps] : []), ...nals];
    }
    const packets: Buffer[] = [];
    nals.forEach((nal, index) => {
      const last = index === nals.length - 1;
      if (nal.length <= this.mtu) {
        packets.push(this.rtp(nal, au.timestamp, last));
        return;
      }
      const indicator = (nal[0] & 0xe0) | 28;
      const type = nal[0] & 0x1f;
      for (let i = 1; i < nal.length; i += this.mtu - 2) {
        const chunk = nal.subarray(i, Math.min(nal.length, i + this.mtu - 2));
        const first = i === 1;
        const final = i + this.mtu - 2 >= nal.length;
        const fuHeader = (first ? 0x80 : 0) | (final ? 0x40 : 0) | type;
        packets.push(this.rtp(Buffer.concat([Buffer.from([indicator, fuHeader]), chunk]), au.timestamp, last && final));
      }
    });
    return packets;
  }

  private rtp(payload: Buffer, timestamp: number, marker: boolean): Buffer {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = (marker ? 0x80 : 0) | 96;
    header.writeUInt16BE(this.seq, 2);
    this.seq = (this.seq + 1) & 0xffff;
    header.writeUInt32BE(timestamp >>> 0, 4);
    header.writeUInt32BE(0x12345678, 8);
    return Buffer.concat([header, payload]);
  }
}

/**
 * One RTSP connection per camera, shared by all viewers. Connects on the first viewer and disconnects
 * a while after the last one leaves (or stays connected with keepConnected).
 */
export class RtspSource {
  private client?: RtspClient;
  private starting?: Promise<void>;
  private readonly viewers = new Set<(au: AccessUnit) => void>();
  private readonly listeners = new Set<(packet: AudioPacket) => void>();
  private readonly opusListeners = new Set<(frame: Buffer, rms: number, samples: number) => void>();
  private opus?: OpusEncoder;
  private opusFailed = false;
  /** Microphone volume (SmartThings slider), applied to the Opus audio of live view and clips. */
  micGain = 1;
  /** The camera's own audio track the plugin uses (AAC or G.711), when the server accepted the SETUP. */
  audio?: RtspAudioInfo;
  /** An Opus track (go2rtc: `ffmpeg:<camera>#audio=opus`): passed to live view as is. */
  opusAudio?: RtspAudioInfo;
  /** The audio as described, whether used or not (the first track). */
  describedAudio?: RtspAudioInfo;
  describedAudios: RtspAudioInfo[] = [];
  /** The video codec the server described (H264, H265, ...), also when it cannot be used. */
  describedVideo?: string;
  private idleTimer?: NodeJS.Timeout;
  private stallTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private lastFrameAt = 0;
  private stopped = false;
  sps?: Buffer;
  pps?: Buffer;
  video?: RtspVideoInfo;
  accessUnits = 0;
  keyframes = 0;
  lastKeyframe?: { au: AccessUnit; at: number };
  /** The frames since the last keyframe: a new viewer starts with them instead of waiting for the next keyframe. */
  gop: AccessUnit[] = [];
  lastKeyframeAt = 0;
  keyframeIntervalMs = 0;

  constructor(
    readonly url: string,
    private readonly log: (level: 'info' | 'warn' | 'debug', message: string) => void,
    private readonly keepConnected = false,
  ) {}

  private async start(): Promise<void> {
    const client = new RtspClient(this.url);
    this.client = client;
    const description = await client.describe();
    if (description.status !== 200) throw new Error(`DESCRIBE answered ${description.status}${description.status === 401 ? ' (wrong restream user/password?)' : description.status === 404 ? ' (no such stream in go2rtc)' : ''}`);
    this.describedVideo = description.video?.codec;
    if (!description.video || !/^h264$/i.test(description.video.codec)) throw new Error(`video is ${description.video?.codec ?? 'missing'}, only H264 can be passed through${/h265|hevc/i.test(description.video?.codec ?? '') ? ' (SmartThings takes H.264 only: add an H.264 stream for this camera in go2rtc)' : ''}`);
    this.video = description.video;
    this.sps ??= description.video.sps;
    this.pps ??= description.video.pps;
    client.onAccessUnit = (au) => {
      this.accessUnits++;
      this.lastFrameAt = Date.now();
      for (const nal of au.nals) {
        const type = nal[0] & 0x1f;
        if (type === 7) this.sps = nal;
        else if (type === 8) this.pps = nal;
      }
      if (au.keyframe) this.gop = [];
      if (this.gop.length < 400) this.gop.push(au);
      if (au.keyframe) {
        const now = Date.now();
        this.lastKeyframe = { au, at: now };
        if (this.lastKeyframeAt) this.keyframeIntervalMs = now - this.lastKeyframeAt;
        this.lastKeyframeAt = now;
        this.keyframes++;
      }
      for (const viewer of this.viewers) viewer(au);
    };
    client.onClose = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.starting = undefined;
      clearInterval(this.stallTimer);
      if (this.viewers.size || this.keepConnected) {
        this.log('warn', 'camera stream closed, reconnecting');
        this.reconnect();
      }
    };
    // A camera that stops sending video without closing the connection: close it, which reconnects
    this.lastFrameAt = Date.now();
    clearInterval(this.stallTimer);
    this.stallTimer = setInterval(() => {
      if (this.client === client && Date.now() - this.lastFrameAt > 15_000) {
        this.log('warn', 'no video from the camera for 15 s, reconnecting');
        client.close();
        client.onClose?.();
      }
    }, 5000);
    this.describedAudio = description.audio;
    this.describedAudios = description.audios;
    // the camera's own audio (AAC: clips as is; G.711: Opus / AAC made here) and an Opus copy when go2rtc has one
    const main = description.audios.find((a) => isAac(a)) ?? description.audios.find((a) => isG711(a));
    const opus = this.wantOpus ? description.audios.find((a) => isOpus(a)) : undefined;
    client.onAudio = (packet) => {
      if (packet.track === this.opusAudio) {
        this.fromOpus(packet);
        return;
      }
      for (const listener of this.listeners) listener(packet);
      this.toOpus(packet);
      this.toClips(packet);
    };
    const on = await client.play(description.video, [main, opus].filter((a): a is RtspAudioInfo => !!a));
    this.audio = main && on.includes(main) ? main : undefined;
    this.opusAudio = opus && on.includes(opus) ? opus : undefined;
    const name = (a: RtspAudioInfo): string => `${/mpeg4-generic/i.test(a.codec) ? 'AAC' : a.codec.toUpperCase()} ${a.clockRate} Hz`;
    const used = [this.audio, this.opusAudio].filter((a): a is RtspAudioInfo => !!a);
    const audioText = !description.audios.length ? 'no audio' : used.length ? `audio ${used.map(name).join(' + ')}` : `audio ${description.audios.map(name).join(', ')} not used`;
    this.log('info', `connected to the stream (${h264ProfileName(this.video.profileLevelId)}, packetization-mode ${this.video.packetizationMode ?? 'n/a'}, ${audioText})`);
  }

  /** Keep trying with a growing pause (3 s up to 60 s) until the camera answers again. */
  private reconnect(): void {
    clearTimeout(this.reconnectTimer);
    const wait = Math.min(60, 3 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped || this.client || !(this.viewers.size || this.keepConnected)) return;
      this.reconnectAttempts++;
      this.ensure()
        .then(() => {
          if (this.reconnectAttempts > 1) this.log('info', `camera stream back after ${this.reconnectAttempts} attempts`);
          this.reconnectAttempts = 0;
        })
        .catch((error) => {
          this.log('warn', `reconnect attempt ${this.reconnectAttempts} failed (${String(error)}); next in ${Math.min(60, 3 * 2 ** Math.min(this.reconnectAttempts, 5))} s`);
          this.reconnect();
        });
    }, wait * 1000);
  }

  ensure(): Promise<void> {
    this.stopped = false;
    clearTimeout(this.idleTimer);
    if (!this.starting) {
      this.starting = this.start().catch((error) => {
        this.client?.close();
        this.client = undefined;
        this.starting = undefined;
        throw error;
      });
    }
    return this.starting;
  }

  /** Add a viewer; returns the function that removes it. */
  subscribe(viewer: (au: AccessUnit) => void): () => void {
    this.viewers.add(viewer);
    this.ensure().catch((error) => this.log('warn', `could not open the camera stream: ${String(error)}`));
    return () => {
      this.viewers.delete(viewer);
      if (this.viewers.size === 0 && !this.keepConnected) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.stop(), 30_000);
      }
    };
  }

  /** Clip audio for G.711 cameras (setting): AAC (default, what the SmartThings app plays), Opus, or none. */
  clipAudio: 'opus' | 'aac' | 'off' = 'aac';
  private aac?: AacEncoder;
  private readonly clipListeners = new Set<(frame: Buffer) => void>();
  private aacFailLogged = false;

  /** What clips get: the camera's AAC as is, AAC made by ffmpeg, or Opus made from its G.711. */
  get clipAudioFormat(): ClipAudioFormat | undefined {
    if (this.clipAudio === 'off') return undefined;
    if (isAac(this.audio)) return { codec: 'aac', label: 'AAC (camera)', config: this.audio!.config!, timescale: this.audio!.clockRate, frameDuration: 1024, channels: this.audio!.channels };
    const from = isG711(this.audio) ? this.audio!.codec : this.opusAudio ? 'Opus' : undefined;
    if (!from) return undefined;
    if (this.clipAudio === 'aac') return this.aac?.failed ? undefined : { codec: 'aac', label: `AAC (from ${from})`, config: AacEncoder.config, timescale: AacEncoder.sampleRate, frameDuration: 1024, channels: 1, priming: AacEncoder.priming };
    if (!isG711(this.audio)) return undefined;
    return this.opusFailed ? undefined : { codec: 'opus', label: `Opus (from ${this.audio!.codec})`, timescale: 48000, frameDuration: 960, channels: 1, inputRate: this.audio!.clockRate };
  }

  /** Ask for the Opus track of a go2rtc restream (live view audio as is). Set before the stream opens. */
  wantOpus = true;
  private opusDecoder?: OpusDecoder;
  private opusDecodeFailed = false;

  /** Opus from the stream: to live view as is; to clips (AAC) only when the camera has no audio track of its own. */
  private fromOpus(packet: AudioPacket): void {
    const samples = opusPacketSamples(packet.payload);
    const needPcm = (!this.audio && this.clipListeners.size && this.clipAudio === 'aac') || (!this.audio && this.listeners.size);
    let pcm: Buffer | undefined;
    if (needPcm && !this.opusDecodeFailed) {
      try {
        this.opusDecoder ??= new OpusDecoder(8000);
        pcm = applyGain(this.opusDecoder.decode(packet.payload), this.micGain);
      } catch (error) {
        this.opusDecodeFailed = true;
        this.log('warn', `Opus decoder not available: ${String(error)}`);
      }
    }
    // passed as is: the loudness is only known when the packet was decoded anyway (and the microphone slider
    // does not change Opus that is passed through)
    const rms = pcm ? pcmRms(pcm) : 1000;
    for (const listener of this.opusListeners) listener(packet.payload, rms, samples);
    if (pcm && !this.audio) {
      for (const listener of this.listeners) listener({ ...packet, payload: pcm, pcm: true });
      if (this.clipListeners.size && this.clipAudio === 'aac') this.encodeAac(pcm);
    }
  }

  private encodeAac(pcm8k: Buffer): void {
    const emit = (frame: Buffer): void => {
      for (const listener of this.clipListeners) listener(frame);
    };
    this.aac ??= new AacEncoder(emit);
    if (this.aac.failed) {
      if (!this.aacFailLogged) this.log('warn', this.aac.failed);
      this.aacFailLogged = true;
      return;
    }
    this.aac.push(pcm8k);
  }

  /** Clip audio frames in the format above (camera AAC frames, ffmpeg AAC frames, or Opus frames). */
  subscribeClipAudio(listener: (frame: Buffer) => void): () => void {
    this.clipListeners.add(listener);
    return () => this.clipListeners.delete(listener);
  }

  private toClips(packet: AudioPacket): void {
    if (!this.clipListeners.size) return;
    const emit = (frame: Buffer): void => {
      for (const listener of this.clipListeners) listener(frame);
    };
    if (isAac(this.audio)) {
      for (const frame of packet.frames ?? []) emit(frame);
    } else if (isG711(this.audio) && this.clipAudio === 'aac') {
      this.encodeAac(applyGain(g711ToPcm(packet.payload, this.audio!.codec), this.micGain));
    }
  }

  /** 20 ms Opus frames made from the camera's G.711 audio (one encoder per camera, shared by live view and clips). */
  subscribeOpus(listener: (frame: Buffer, rms: number, samples: number) => void): () => void {
    this.opusListeners.add(listener);
    return () => this.opusListeners.delete(listener);
  }

  private toOpus(packet: AudioPacket): void {
    // an Opus track from go2rtc is used as is instead
    if (this.opusAudio || (!this.opusListeners.size && !(this.clipListeners.size && this.clipAudio === 'opus')) || !isG711(this.audio) || this.opusFailed) return;
    try {
      this.opus ??= new OpusEncoder();
      const pcm = applyGain(g711ToPcm(packet.payload, this.audio!.codec), this.micGain);
      for (const { frame, rms } of this.opus.push(pcm)) {
        for (const listener of this.opusListeners) listener(frame, rms, OpusEncoder.frameDuration48k);
        if (this.clipAudio === 'opus') for (const listener of this.clipListeners) listener(frame);
      }
    } catch (error) {
      this.opusFailed = true;
      this.log('warn', `Opus encoder not available, no converted audio: ${String(error)}`);
    }
  }

  /** Listen to the camera's audio packets (only while the stream is open; does not open it). */
  subscribeAudio(listener: (packet: AudioPacket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A recent keyframe: the cached one while streaming, otherwise connect and wait for the next. */
  latestKeyframe(maxAgeMs = 3000, timeoutMs = 8000): Promise<AccessUnit> {
    if (this.lastKeyframe && Date.now() - this.lastKeyframe.at < maxAgeMs) return Promise.resolve(this.lastKeyframe.au);
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        reject(new Error(`no keyframe from the camera within ${timeoutMs} ms`));
      }, timeoutMs);
      unsubscribe = this.subscribe((au) => {
        if (!au.keyframe) return;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(au);
      });
      this.ensure().catch((error) => {
        clearTimeout(timer);
        unsubscribe?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  stats(): string {
    return `viewers=${this.viewers.size} accessUnits=${this.accessUnits} keyframes=${this.keyframes} keyframeInterval=${this.keyframeIntervalMs}ms maxRtpPacket=${this.client?.maxRtpPacket ?? 0}B packets=${this.client?.packets ?? 0} lost=${this.client?.lostPackets ?? 0}`;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.stallTimer);
    this.aac?.close();
    this.aac = undefined;
    this.opusDecoder?.close();
    this.opusDecoder = undefined;
    clearTimeout(this.idleTimer);
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    client?.close();
  }
}

/** Picture size from an H.264 SPS NAL (exp-Golomb parsing, cropping applied). */
export function spsResolution(sps: Buffer): { width: number; height: number } | undefined {
  try {
    // Remove emulation prevention bytes (00 00 03)
    const bytes: number[] = [];
    for (let i = 1; i < sps.length; i++) {
      if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
      bytes.push(sps[i]);
    }
    let bit = 0;
    const u = (n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
      return v;
    };
    const ue = (): number => {
      let zeros = 0;
      while (u(1) === 0 && zeros < 32) zeros++;
      return (1 << zeros) - 1 + u(zeros);
    };
    const se = (): number => {
      const k = ue();
      return k & 1 ? (k + 1) / 2 : -(k / 2);
    };
    const profile = u(8);
    u(16);
    ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue();
      if (chroma === 3) u(1);
      ue();
      ue();
      u(1);
      if (u(1)) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (u(1)) {
            let last = 8;
            let next = 8;
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
              if (next !== 0) next = (last + se() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    ue();
    const pocType = ue();
    if (pocType === 0) ue();
    else if (pocType === 1) {
      u(1);
      se();
      se();
      const n = ue();
      for (let i = 0; i < n; i++) se();
    }
    ue();
    u(1);
    const widthMbs = ue() + 1;
    const heightMapUnits = ue() + 1;
    const frameMbsOnly = u(1);
    if (!frameMbsOnly) u(1);
    u(1);
    let [cl, cr, ct, cb] = [0, 0, 0, 0];
    if (u(1)) [cl, cr, ct, cb] = [ue(), ue(), ue(), ue()];
    const cropX = chroma === 0 ? 1 : 2;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return { width: widthMbs * 16 - (cl + cr) * cropX, height: (2 - frameMbsOnly) * heightMapUnits * 16 - (ct + cb) * cropY };
  } catch {
    return undefined;
  }
}
