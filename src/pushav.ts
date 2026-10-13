/**
 * Matter Push AV clip recording and upload, following the Matter SDK camera example
 * (connectedhomeip examples/camera-app: pushav-clip-recorder, pushav-uploader):
 * - a clip is CMAF/DASH: index.mpd, <stream>/<stream>.init and <stream>/segment_<1001..>.m4s
 * - every file is sent with HTTP PUT to <transport url>session_<n>/<file>, over TLS with the client
 *   certificate the hub provisioned (mutual TLS), trusting the root certificates it provisioned
 * - order: index.mpd once the first segment exists, the init segment, the segments, and finally the
 *   index.mpd again with a SegmentTimeline
 */
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as tls from 'node:tls';

import { Sample, TIMESCALE, aacChannels, aacCodecString, audioInitSegment, audioSegment, avcCodecString, initSegment, mediaSegment, opusInitSegment } from './fmp4.js';
import { AccessUnit, ClipAudioFormat, RtspSource } from './rtsp.js';

type Log = (message: string) => void;

// ----- persistent TLS material (the client key must survive restarts) -----
export interface StoredEndpoint {
  hostname: string;
  port: number;
  caid: number;
  ccdid: number;
}
interface StoreData {
  keys: Record<string, string>; // ccdid -> private key PEM
  roots: Record<string, string>; // caid -> DER base64
  clients: Record<string, { cert: string; intermediates: string[] }>; // ccdid -> DER base64
  endpoints: Record<string, StoredEndpoint>; // TLS endpoint id
}

export class RecordingStore {
  data: StoreData = { keys: {}, roots: {}, clients: {}, endpoints: {} };

  constructor(
    private readonly file: string,
    private readonly log: Log,
  ) {
    try {
      this.data = { ...this.data, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreData>) };
    } catch {
      // first start
    }
  }

  save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (error) {
      this.log(`could not save the recording keys to ${this.file}: ${String(error)}`);
    }
  }

  /** key, client certificate chain and trusted roots for a TLS endpoint, or why they are missing. */
  tlsFor(endpointId: number): { endpoint: StoredEndpoint; key: string; cert: string; ca: string[] } | string {
    const endpoint = this.data.endpoints[endpointId];
    if (!endpoint) return `TLS endpoint ${endpointId} is unknown (it was provisioned before 0.5.0: remove the camera from SmartThings and pair it again)`;
    const key = this.data.keys[endpoint.ccdid];
    const client = this.data.clients[endpoint.ccdid];
    if (!key) return `no private key for client certificate ${endpoint.ccdid} (created before 0.5.0: remove the camera from SmartThings and pair it again)`;
    if (!client) return `client certificate ${endpoint.ccdid} was never provisioned`;
    const cert = [client.cert, ...client.intermediates].map(derToPem).join('');
    const own = this.data.roots[endpoint.caid];
    const ca = [...(own ? [derToPem(own)] : []), ...Object.entries(this.data.roots).filter(([id]) => Number(id) !== endpoint.caid).map(([, der]) => derToPem(der)), ...(tls.rootCertificates ?? [])];
    return { endpoint, key, cert, ca };
  }
}

function derToPem(base64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`;
}

// ----- pre-roll: the last seconds of video (from a keyframe) and AAC audio -----
export interface TimedFrame {
  frame: Buffer;
  at: number;
}

export class PreRollBuffer {
  private items: { au: AccessUnit; at: number }[] = [];
  private audio: TimedFrame[] = [];
  private unsubscribe?: () => void;
  private unsubscribeAudio?: () => void;

  constructor(
    private readonly source: RtspSource,
    private readonly keepMs = 12_000,
  ) {}

  start(): void {
    this.unsubscribe ??= this.source.subscribe((au) => {
      const now = Date.now();
      this.items.push({ au, at: now });
      // drop whole GOPs that are older than keepMs
      while (this.items.length && now - this.items[0].at > this.keepMs) {
        const next = this.items.findIndex((item, i) => i > 0 && item.au.keyframe);
        if (next < 0 || now - this.items[next].at < this.keepMs * 0.5) break;
        this.items.splice(0, next);
      }
      while (this.items.length && !this.items[0].au.keyframe) this.items.shift();
    });
    const keep = (frames: Buffer[]): void => {
      const now = Date.now();
      for (const frame of frames) this.audio.push({ frame, at: now });
      const oldest = this.items[0]?.at ?? now;
      while (this.audio.length && this.audio[0].at < Math.min(oldest, now - this.keepMs * 2)) this.audio.shift();
    };
    // the clip audio frames: the camera's AAC, AAC from ffmpeg, or Opus made from its G.711
    this.unsubscribeAudio ??= this.source.subscribeClipAudio((frame) => keep([frame]));
  }

  /** Video from the oldest keyframe not older than maxMs (or the newest keyframe), and the audio since then. */
  take(maxMs: number): { video: { au: AccessUnit; at: number }[]; audio: TimedFrame[] } {
    if (!this.items.length) return { video: [], audio: [] };
    const now = Date.now();
    // no pre-roll asked (record button): still start at the last keyframe, so the clip does not wait for the next one
    let start = maxMs > 0 ? this.items.findIndex((item) => item.au.keyframe && now - item.at <= maxMs) : -1;
    if (start < 0) start = this.items.map((item) => item.au.keyframe).lastIndexOf(true);
    if (start < 0) return { video: [], audio: [] };
    const video = this.items.slice(start);
    return { video, audio: this.audio.filter((a) => a.at >= video[0].at) };
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeAudio?.();
    this.unsubscribeAudio = undefined;
    this.items = [];
    this.audio = [];
  }
}

// ----- HTTP PUT over mutual TLS -----
interface PutResult {
  status: number;
  body: string;
  ms: number;
}

function put(url: URL, body: Buffer, contentType: string, material: { key: string; cert: string; ca: string[] }): Promise<PutResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: 'PUT',
        host: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        servername: url.hostname,
        headers: { 'Content-Type': contentType, 'Content-Length': body.length },
        key: material.key,
        cert: material.cert,
        ca: material.ca,
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 1200), ms: Date.now() - started }));
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout after 30 s')));
    request.on('error', reject);
    request.end(body);
  });
}

// ----- one clip -----
export interface TimeControl {
  initialDuration: number;
  augmentationDuration: number;
  maxDuration: number;
  blindDuration: number;
}

export interface ClipOptions {
  label: string;
  source: RtspSource;
  preRoll: PreRollBuffer;
  url: string;
  session: number;
  streamName: string;
  /** Name of the transport's audio stream; audio is recorded when this is set and the camera sends AAC. */
  audioName?: string;
  maxPreRollMs: number;
  segmentMs: number;
  time: TimeControl;
  width: number;
  height: number;
  /** Clockwise degrees (0, 90, 180, 270), written into the clip for players. */
  rotation?: number;
  tlsMaterial: () => ReturnType<RecordingStore['tlsFor']>;
  log: Log;
}

interface Segment {
  number: number;
  baseTime: number;
  duration: number;
  bytes: number;
}

export class Clip {
  private readonly startedAt = Date.now();
  private endAt: number;
  private readonly maxEndAt: number;
  private unsubscribe?: () => void;
  private unsubscribeAudio?: () => void;
  private watchdog?: NodeJS.Timeout;
  private prev?: AccessUnit;
  private firstAt = 0;
  // AAC audio, cut at the same moments as the video segments
  private readonly audioFormat?: ClipAudioFormat;
  private get audioCodec(): 'aac' | 'opus' | undefined {
    return this.audioFormat?.codec;
  }
  private audioQueue: TimedFrame[] = [];
  private audioTime = 0;
  private readonly audioSegments: Segment[] = [];
  private lastDuration = 3000;
  private samples: Sample[] = [];
  private samplesDuration = 0;
  private decodeTime = 0;
  private readonly segments: Segment[] = [];
  private sps?: Buffer;
  private pps?: Buffer;
  private uploads: Promise<void> = Promise.resolve();
  private failures = 0;
  private blocked = false;
  private audioFailed = false;
  private uploaded = 0;
  private uploadedBytes = 0;
  private stopped = false;
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor(private readonly o: ClipOptions) {
    this.endAt = this.startedAt + o.time.initialDuration * 1000;
    this.maxEndAt = this.startedAt + Math.max(o.time.maxDuration, o.time.initialDuration) * 1000;
    this.done = new Promise((resolve) => (this.finish = resolve));
    this.audioFormat = o.audioName ? o.source.clipAudioFormat : undefined;
  }

  get url(): string {
    return this.o.url;
  }

  get prefix(): string {
    return `session_${this.o.session}`;
  }

  start(): void {
    const preRoll = this.o.preRoll.take(this.o.maxPreRollMs);
    const audioText = this.audioCodec
      ? `, audio ${this.audioFormat!.label} (${preRoll.audio.length} pre-roll frames)`
      : this.o.audioName
        ? `, no audio (camera sends ${this.o.source.describedAudio?.codec ?? 'none'})`
        : '';
    this.o.log(`clip ${this.o.label} ${this.prefix}: started, ${this.o.time.initialDuration} s (max ${this.o.time.maxDuration} s), ${this.o.maxPreRollMs > 0 ? `pre-roll ${preRoll.video.length} frames${preRoll.video.length ? '' : ' (none buffered)'}` : `no pre-roll requested, starting at the last keyframe (${preRoll.video.length} frames)`}${audioText} -> ${this.o.url}`);
    for (const item of preRoll.video) this.add(item.au, item.at);
    if (!!this.audioCodec) {
      this.audioQueue.push(...preRoll.audio);
      this.unsubscribeAudio = this.o.source.subscribeClipAudio((frame) => {
        if (!this.stopped) this.audioQueue.push({ frame, at: Date.now() });
      });
    }
    this.unsubscribe = this.o.source.subscribe((au) => this.onLive(au));
    this.kick();
  }

  /** Motion or a new trigger while recording: record longer, up to the maximum. */
  extend(seconds: number): void {
    if (this.stopped || seconds <= 0) return;
    const before = this.endAt;
    this.endAt = Math.min(this.maxEndAt, Math.max(this.endAt, Date.now() + seconds * 1000));
    if (this.endAt > before) this.o.log(`clip ${this.o.label} ${this.prefix}: extended by ${Math.round((this.endAt - before) / 1000)} s`);
  }

  private kick(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.o.log(`clip ${this.o.label} ${this.prefix}: no video from the camera for 10 s, ending the clip`);
      this.stop();
    }, 10_000);
  }

  private onLive(au: AccessUnit): void {
    if (this.stopped) return;
    this.kick();
    if (Date.now() >= this.endAt) {
      this.stop();
      return;
    }
    this.add(au, Date.now());
  }

  private add(au: AccessUnit, at: number): void {
    for (const nal of au.nals) {
      const type = nal[0] & 0x1f;
      if (type === 7) this.sps ??= nal;
      else if (type === 8) this.pps ??= nal;
    }
    if (!this.prev) {
      if (!au.keyframe) return; // a clip starts with a keyframe
      this.prev = au;
      this.firstAt = at;
      return;
    }
    let duration = (au.timestamp - this.prev.timestamp) >>> 0;
    if (duration === 0 || duration > TIMESCALE * 3) duration = this.lastDuration;
    this.lastDuration = duration;
    this.push(this.prev, duration, au.keyframe, at);
    this.prev = au;
  }

  /** `nextAt`: arrival time of the next access unit, where a new segment would start. */
  private push(au: AccessUnit, duration: number, nextIsKeyframe: boolean, nextAt: number): void {
    this.samples.push({ nals: au.nals, keyframe: au.keyframe, duration });
    this.samplesDuration += duration;
    if (nextIsKeyframe && this.samplesDuration >= (this.o.segmentMs / 1000) * TIMESCALE) this.closeSegment(nextAt);
  }

  private closeSegment(boundaryAt: number): void {
    if (!this.samples.length) return;
    const number = 1001 + this.segments.length;
    const { data, duration } = mediaSegment(this.segments.length + 1, this.decodeTime, this.samples);
    const segment: Segment = { number, baseTime: this.decodeTime, duration, bytes: data.length };
    this.segments.push(segment);
    this.decodeTime += duration;
    this.samples = [];
    this.samplesDuration = 0;
    const stream = this.o.streamName;
    if (segment.number === 1001) {
      const sps = this.sps ?? this.o.source.sps;
      const pps = this.pps ?? this.o.source.pps;
      if (!sps || !pps) {
        this.o.log(`clip ${this.o.label}: no SPS/PPS from the camera, cannot build the init segment`);
        return;
      }
      this.sps = sps;
      this.pps = pps;
      // init segments before index.mpd: SmartThings answers "ClipInPresentState" to an init that comes after it
      this.upload(`${stream}/${stream}.init`, initSegment(sps, pps, this.o.width, this.o.height, this.o.rotation ?? 0), 'video/mp4');
      if (!!this.audioCodec) {
        const audio = this.o.source.audio!;
        const name = this.o.audioName!;
        const f = this.audioFormat!;
        const init = f.codec === 'aac' ? audioInitSegment(f.config!, f.timescale, f.channels ?? aacChannels(f.config!), f.priming ?? 0) : opusInitSegment(1, f.inputRate ?? 8000);
        this.upload(`${name}/${name}.init`, init, 'video/mp4', true);
      }
      this.upload('index.mpd', Buffer.from(this.mpd(false)), 'application/dash+xml');
    }
    this.upload(`${stream}/segment_${number}.m4s`, data, 'video/iso.segment');
    if (!!this.audioCodec) this.closeAudioSegment(boundaryAt);
  }

  private closeAudioSegment(boundaryAt: number): void {
    const frames = this.audioQueue.filter((a) => a.at >= this.firstAt && a.at < boundaryAt).map((a) => a.frame);
    this.audioQueue = this.audioQueue.filter((a) => a.at >= boundaryAt);
    if (!frames.length) return;
    const name = this.o.audioName!;
    const number = 1001 + this.audioSegments.length;
    const { data, duration } = audioSegment(this.audioSegments.length + 1, this.audioTime, frames, this.audioFormat!.timescale, this.audioFormat!.frameDuration);
    this.audioSegments.push({ number, baseTime: this.audioTime, duration, bytes: data.length });
    this.audioTime += duration;
    // the Matter SDK uploader sends every .m4s (audio too) as video/iso.segment; SmartThings refused audio/iso.segment (HTTP 401)
    this.upload(`${name}/segment_${number}.m4s`, data, 'video/iso.segment', true);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.watchdog);
    this.unsubscribe?.();
    this.unsubscribeAudio?.();
    if (this.prev) this.push(this.prev, this.lastDuration, false, Infinity);
    this.prev = undefined;
    this.closeSegment(Infinity);
    if (this.segments.length && this.sps) this.upload('index.mpd', () => Buffer.from(this.mpd(true)), 'application/dash+xml');
    void this.uploads.then(() => {
      const seconds = this.decodeTime / TIMESCALE;
      const audioText = this.audioCodec ? `, ${(this.audioTime / this.audioTimescale).toFixed(1)} s of ${this.audioCodec === 'aac' ? 'AAC' : 'Opus'} audio` : '';
      this.o.log(`clip ${this.o.label} ${this.prefix}: finished, ${seconds.toFixed(1)} s of video in ${this.segments.length} segment(s)${audioText}, ${this.uploaded} file(s) / ${Math.round(this.uploadedBytes / 1024)} KB uploaded${this.failures ? `, ${this.failures} upload(s) failed` : ''}${this.blocked ? ', nothing could be uploaded' : ''}`);
      this.finish();
    });
  }

  /**
   * Queue one upload. `body` may be a function, evaluated when it is sent (the final index.mpd leaves out the
   * audio track if an audio upload failed). Audio failures do not stop the video uploads.
   */
  private upload(name: string, content: Buffer | (() => Buffer), contentType: string, audio = false): void {
    this.uploads = this.uploads.then(async () => {
      if (this.blocked || this.failures >= 3 || (audio && this.audioFailed)) return;
      const body = typeof content === 'function' ? content() : content;
      const material = this.o.tlsMaterial();
      if (typeof material === 'string') {
        this.blocked = true;
        this.o.log(`clip ${this.o.label}: cannot upload: ${material}`);
        return;
      }
      const base = this.o.url.endsWith('/') ? this.o.url : `${this.o.url}/`;
      const url = new URL(`${this.prefix}/${name}`, base);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await put(url, body, contentType, material);
          const ok = result.status >= 200 && result.status < 300;
          this.o.log(`upload ${this.prefix}/${name} (${body.length} B) -> HTTP ${result.status} in ${result.ms} ms`);
          // the server's answer in short lines: the Matterbridge frontend cuts long lines in the middle
          if (!ok) {
            const text = result.body.replace(/\s+/g, ' ').trim();
            const message = /"message"\s*:\s*"([^"]*)"/.exec(text)?.[1];
            if (message) this.o.log(`  reason: ${message}`);
            for (let i = 0; i < text.length; i += 50) this.o.log(`  answer ${i / 50 + 1}: ${text.slice(i, i + 50)}`);
          }
          if (ok) {
            this.uploaded++;
            this.uploadedBytes += body.length;
          } else if (audio) {
            this.audioFailed = true;
            this.o.log(`clip ${this.o.label}: audio upload refused, the clip is finished without audio`);
          } else {
            this.failures++;
          }
          return;
        } catch (error) {
          const e = error as NodeJS.ErrnoException;
          this.o.log(`upload ${this.prefix}/${name} failed (attempt ${attempt}): ${e.code ? `${e.code} ` : ''}${e.message}`);
          if (attempt === 2) {
            if (audio) this.audioFailed = true;
            else this.failures++;
          }
        }
      }
    });
  }

  /** AAC: the camera's sample rate; Opus: always 48 kHz. */
  private get audioTimescale(): number {
    return this.audioFormat?.timescale ?? 48000;
  }

  private audioMpd(final: boolean, seconds: number): string[] {
    if (!this.audioCodec || (final && this.audioFailed)) return [];
    const audio = this.o.source.audio!;
    const name = this.o.audioName!;
    const aac = this.audioCodec === 'aac';
    const rate = this.audioTimescale;
    const channels = this.audioFormat!.channels ?? (aac ? aacChannels(this.audioFormat!.config!) : 1);
    const bandwidth = seconds > 0 ? Math.round((this.audioSegments.reduce((a, s) => a + s.bytes, 0) * 8) / seconds) : 32_000;
    const template = `initialization="${name}/${name}.init" media="${name}/segment_$Number$.m4s" startNumber="1001"`;
    return [
      '\t\t<AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" lang="und">',
      `\t\t\t<Representation id="1" mimeType="audio/mp4" codecs="${aac ? aacCodecString(this.audioFormat!.config!) : 'opus'}" bandwidth="${bandwidth}" audioSamplingRate="${rate}">`,
      `\t\t\t\t<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="${channels}" />`,
      final ? `\t\t\t\t<SegmentTemplate timescale="${rate}" ${template}>` : `\t\t\t\t<SegmentTemplate timescale="${rate}" duration="${Math.round((this.o.segmentMs / 1000) * rate)}" ${template}>`,
      ...(final ? ['\t\t\t\t\t<SegmentTimeline>', ...this.audioSegments.map((s) => `\t\t\t\t\t\t<S t="${s.baseTime}" d="${s.duration}" />`), '\t\t\t\t\t</SegmentTimeline>'] : []),
      '\t\t\t\t</SegmentTemplate>',
      '\t\t\t</Representation>',
      '\t\t</AdaptationSet>',
    ];
  }

  private mpd(final: boolean): string {
    const sps = this.sps ?? Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    const { width, height } = this.o;
    const g = gcd(width, height);
    const seconds = this.decodeTime / TIMESCALE;
    const frames = this.segments.length ? Math.round(this.lastDuration ? TIMESCALE / this.lastDuration : 15) : 15;
    const bandwidth = seconds > 0 ? Math.round((this.segments.reduce((a, s) => a + s.bytes, 0) * 8) / seconds) : 2_000_000;
    const maxSegment = Math.max(...this.segments.map((s) => s.duration), 1) / TIMESCALE;
    const stream = this.o.streamName;
    const timeline = final ? ['\t\t\t\t\t<SegmentTimeline>', ...this.segments.map((s) => `\t\t\t\t\t\t<S t="${s.baseTime}" d="${s.duration}" />`), '\t\t\t\t\t</SegmentTimeline>'] : [];
    const template = `initialization="${stream}/${stream}.init" media="${stream}/segment_$Number$.m4s" startNumber="1001"`;
    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      '\txmlns="urn:mpeg:dash:schema:mpd:2011"',
      '\txmlns:xlink="http://www.w3.org/1999/xlink"',
      '\txsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd"',
      '\tprofiles="urn:mpeg:dash:profile:isoff-live:2011"',
      '\ttype="static"',
      `\tmediaPresentationDuration="PT${seconds.toFixed(1)}S"`,
      `\tmaxSegmentDuration="PT${maxSegment.toFixed(1)}S"`,
      `\tminBufferTime="PT${(maxSegment * 2).toFixed(1)}S">`,
      '\t<ProgramInformation>',
      '\t</ProgramInformation>',
      '\t<Period id="0" start="PT0.0S">',
      `\t\t<AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" frameRate="${frames}/1" maxWidth="${width}" maxHeight="${height}" par="${width / g}:${height / g}">`,
      `\t\t\t<Representation id="0" mimeType="video/mp4" codecs="${avcCodecString(sps)}" bandwidth="${bandwidth}" width="${width}" height="${height}" sar="1:1">`,
      final
        ? `\t\t\t\t<SegmentTemplate timescale="${TIMESCALE}" ${template}>`
        : `\t\t\t\t<SegmentTemplate timescale="${TIMESCALE}" duration="${Math.round((this.o.segmentMs / 1000) * TIMESCALE)}" ${template}>`,
      ...timeline,
      '\t\t\t\t</SegmentTemplate>',
      '\t\t\t</Representation>',
      '\t\t</AdaptationSet>',
      ...this.audioMpd(final, seconds),
      '\t</Period>',
      '</MPD>',
      '',
    ].join('\n');
  }
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a || 1;
}
