/**
 * Camera audio without ffmpeg: G.711 (PCMA/PCMU) to PCM with lookup tables, and PCM to Opus with libopus
 * compiled to WebAssembly (vendor/opusscript, MIT/BSD, about 350 KB). Opus is the codec Matter cameras use.
 */
import { createRequire } from 'node:module';

// ----- G.711 -----
function alawToLinear(a: number): number {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}
function ulawToLinear(u: number): number {
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}
function linearToUlaw(pcm: number): number {
  const sign = pcm < 0 ? 0x80 : 0;
  let v = Math.min(Math.abs(pcm), 32635) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (v & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (v >> (exponent + 3)) & 0x0f;
  v = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return v;
}
function linearToAlaw(pcm: number): number {
  const sign = pcm >= 0 ? 0xd5 : 0x55;
  const v = Math.min(Math.abs(pcm), 32767);
  if (v < 256) return (v >> 4) ^ sign;
  let seg = 1;
  for (let x = v >> 8; x > 1; x >>= 1) seg++;
  return ((seg << 4) | ((v >> (seg + 3)) & 0x0f)) ^ sign;
}
const ALAW = Int16Array.from({ length: 256 }, (_, i) => alawToLinear(i));
const ULAW = Int16Array.from({ length: 256 }, (_, i) => ulawToLinear(i));
const A2U = Buffer.from(Array.from({ length: 256 }, (_, i) => linearToUlaw(ALAW[i])));
const U2A = Buffer.from(Array.from({ length: 256 }, (_, i) => linearToAlaw(ULAW[i])));
/** 16-bit PCM (LE bytes) to A-law bytes. */
export function pcmToAlaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = linearToAlaw(pcm.readInt16LE(i * 2));
  return out;
}
export const alawToUlaw = (b: Buffer): Buffer => Buffer.from(b.map((x) => A2U[x]));
export const ulawToAlaw = (b: Buffer): Buffer => Buffer.from(b.map((x) => U2A[x]));

/**
 * Matter volume level (0..254, SmartThings slider) to a gain: the middle (128) leaves the sound as it is,
 * the top gives +12 dB, lower levels quieter; 0 or muted is silence.
 */
export function levelToGain(level: number | undefined, muted: boolean | undefined): number {
  if (muted || level === 0) return 0;
  if (level === undefined || level === null) return 1;
  return Math.pow(10, (((level - 128) / 126) * 12) / 20);
}

/** Multiply 16-bit PCM (LE bytes) by a gain, with clipping. Returns a new buffer. */
export function applyGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
  return out;
}

/** Loudness of 16-bit PCM (LE bytes): RMS on the 0..32767 scale. */
export function pcmRms(pcm: Buffer): number {
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** G.711 bytes to 16-bit PCM (little endian bytes, as the Opus encoder takes them). */
export function g711ToPcm(payload: Buffer, codec: string): Buffer {
  const table = /pcmu/i.test(codec) ? ULAW : ALAW;
  const out = Buffer.alloc(payload.length * 2);
  for (let i = 0; i < payload.length; i++) out.writeInt16LE(table[payload[i]], i * 2);
  return out;
}

// ----- Opus -----
interface OpusScriptInstance {
  encode: (pcm: Buffer, frameSize: number) => Buffer;
  decode: (packet: Buffer) => Buffer;
  setBitrate: (bitrate: number) => void;
  delete: () => void;
}
type OpusScriptClass = (new (rate: number, channels: number, application: number) => OpusScriptInstance) & { Application: { AUDIO: number; VOIP: number } };

let opusScript: OpusScriptClass | undefined;
function loadOpus(): OpusScriptClass {
  const require = createRequire(import.meta.url);
  opusScript ??= require('../vendor/opusscript/index.js') as OpusScriptClass;
  return opusScript;
}

/** 20 ms Opus frames from 8 kHz mono PCM (Opus decoders always play it at 48 kHz). */
export class OpusEncoder {
  private readonly encoder: OpusScriptInstance;
  private pending: Buffer = Buffer.alloc(0);
  static readonly frameSamples = 160; // 20 ms at 8 kHz
  static readonly frameDuration48k = 960; // the same 20 ms in Opus' 48 kHz clock

  constructor(bitrate = 24_000) {
    const OpusScript = loadOpus();
    this.encoder = new OpusScript(8000, 1, OpusScript.Application.VOIP);
    this.encoder.setBitrate(bitrate);
  }

  /** Add PCM (16-bit LE, 8 kHz mono); returns the complete Opus frames with their loudness (RMS, 0..32767). */
  push(pcm: Buffer): { frame: Buffer; rms: number }[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
    const frames: { frame: Buffer; rms: number }[] = [];
    const bytes = OpusEncoder.frameSamples * 2;
    while (this.pending.length >= bytes) {
      const chunk = this.pending.subarray(0, bytes);
      frames.push({ frame: this.encoder.encode(chunk, OpusEncoder.frameSamples), rms: pcmRms(chunk) });
      this.pending = this.pending.subarray(bytes);
    }
    return frames;
  }

  close(): void {
    this.encoder.delete();
  }
}

/** Opus packets (from the hub: your voice when you talk) to 48 kHz mono PCM, 16-bit LE. */
export class OpusDecoder {
  private readonly decoder: OpusScriptInstance;

  /** libopus decodes straight to any of its rates: 48000 for listening, 8000 for G.711 cameras. */
  constructor(readonly sampleRate = 48000) {
    const OpusScript = loadOpus();
    this.decoder = new OpusScript(sampleRate, 1, OpusScript.Application.VOIP);
  }

  decode(packet: Buffer): Buffer {
    return this.decoder.decode(packet);
  }

  close(): void {
    this.decoder.delete();
  }
}

/** A 16-bit mono PCM WAV file. */
export function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface FdkEncoder {
  encode: (channels: Float32Array[]) => Uint8Array;
  free: () => void;
  priming: number;
}
let fdkLoader: Promise<(opts: { sampleRate: number; channels: number; bitrate: number; profile: string }) => Promise<FdkEncoder>> | undefined;

/**
 * AAC-LC from 8 kHz PCM, built in: the Fraunhofer FDK AAC encoder compiled to WebAssembly (vendor/encode-aac,
 * about 480 KB; MIT wrapper, FDK license). Upsampled to 16 kHz mono, the format the SmartThings app plays.
 * ADTS from the encoder is split into raw AAC frames (1024 samples each).
 */
export class AacEncoder {
  static readonly sampleRate = 16000;
  /** AudioSpecificConfig: AAC-LC, 16 kHz (index 8), mono. */
  static readonly config = Buffer.from([0x14, 0x08]);
  /** Encoder delay in samples (FDK AAC-LC), skipped with the clip's edit list. */
  static readonly priming = 2048;
  private encoder?: FdkEncoder;
  private loading?: Promise<void>;
  private waiting: Buffer[] = [];
  private last = 0;
  private pending: Buffer = Buffer.alloc(0);
  failed?: string;

  constructor(private readonly onFrame: (frame: Buffer) => void) {}

  private load(): void {
    this.loading ??= (async () => {
      fdkLoader ??= import(new URL('../vendor/encode-aac/aac-encode.js', import.meta.url).href).then((m: { default: Parameters<typeof Promise.resolve>[0] }) => m.default as never);
      const create = await fdkLoader;
      this.encoder = await create({ sampleRate: AacEncoder.sampleRate, channels: 1, bitrate: 32, profile: 'lc' });
      for (const pcm of this.waiting) this.encode(pcm);
      this.waiting = [];
    })().catch((error: unknown) => {
      this.failed = `AAC encoder not available (${String(error)})`;
    });
  }

  /** 16-bit PCM at 8 kHz (LE bytes). */
  push(pcm8k: Buffer): void {
    if (this.failed) return;
    if (!this.encoder) {
      this.load();
      if (this.waiting.length < 50) this.waiting.push(pcm8k);
      return;
    }
    this.encode(pcm8k);
  }

  private encode(pcm8k: Buffer): void {
    // 8 kHz -> 16 kHz: linear interpolation, carried over between packets
    const n = pcm8k.length >> 1;
    const samples = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = pcm8k.readInt16LE(i * 2) / 32768;
      samples[i * 2] = (this.last + v) / 2;
      samples[i * 2 + 1] = v;
      this.last = v;
    }
    this.parse(Buffer.from(this.encoder!.encode([samples])));
  }

  private parse(data: Buffer): void {
    if (!data.length) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    while (this.pending.length >= 7) {
      if (this.pending[0] !== 0xff || (this.pending[1] & 0xf0) !== 0xf0) {
        const next = this.pending.indexOf(0xff, 1);
        this.pending = next < 0 ? Buffer.alloc(0) : this.pending.subarray(next);
        continue;
      }
      const length = ((this.pending[3] & 0x03) << 11) | (this.pending[4] << 3) | (this.pending[5] >> 5);
      if (this.pending.length < length) return;
      const header = this.pending[1] & 0x01 ? 7 : 9; // protection absent: 7 bytes
      this.onFrame(Buffer.from(this.pending.subarray(header, length)));
      this.pending = this.pending.subarray(length);
    }
  }

  close(): void {
    this.encoder?.free();
    this.encoder = undefined;
  }
}
