/**
 * Minimal fragmented MP4 (CMAF) writer for one H.264 video track, as Matter Push AV uploads it:
 * an init segment (ftyp + moov) and media segments (styp + moof + mdat). Timescale 90 kHz, the RTP clock.
 */

const u8 = (n: number): Buffer => Buffer.from([n & 0xff]);
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(n))));
  return b;
};
const zeros = (n: number): Buffer => Buffer.alloc(n);

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
}
const fullBox = (type: string, version: number, flags: number, ...parts: Buffer[]): Buffer => box(type, u8(version), u8(flags >> 16), u16(flags), ...parts);

const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
const ONE = 0x00010000;
const MINUS_ONE = 0xffff0000;
/** Display matrix that turns the picture clockwise, as ffmpeg writes it; players apply it. */
function rotationMatrix(degrees: number): Buffer {
  const [a, b, c, d] = degrees === 90 ? [0, ONE, MINUS_ONE, 0] : degrees === 180 ? [MINUS_ONE, 0, 0, MINUS_ONE] : degrees === 270 ? [0, MINUS_ONE, ONE, 0] : [ONE, 0, 0, ONE];
  return Buffer.concat([u32(a), u32(b), u32(0), u32(c), u32(d), u32(0), u32(0), u32(0), u32(0x40000000)]);
}
export const TIMESCALE = 90000;

/** "avc1.4d0029" style codec string from the SPS. */
export function avcCodecString(sps: Buffer): string {
  return `avc1.${sps.subarray(1, 4).toString('hex')}`;
}

export function initSegment(sps: Buffer, pps: Buffer, width: number, height: number, rotation = 0): Buffer {
  const profile = sps[1];
  const highProfile = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile);
  const avcC = box(
    'avcC',
    u8(1),
    sps.subarray(1, 4),
    u8(0xff), // 4-byte NAL lengths
    u8(0xe1),
    u16(sps.length),
    sps,
    u8(1),
    u16(pps.length),
    pps,
    // High profiles: 4:2:0, 8 bit, no SPS extensions
    ...(highProfile ? [u8(0xfd), u8(0xf8), u8(0xf8), u8(0)] : []),
  );
  const avc1 = box(
    'avc1',
    zeros(6),
    u16(1), // data reference index
    zeros(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1), // frame count
    zeros(32), // compressor name
    u16(0x0018),
    u16(0xffff),
    avcC,
    box('pasp', u32(1), u32(1)),
  );
  const stbl = box('stbl', fullBox('stsd', 0, 0, u32(1), avc1), fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf', fullBox('vmhd', 0, 1, zeros(8)), box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), stbl);
  const mdia = box(
    'mdia',
    fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0)),
    fullBox('hdlr', 0, 0, u32(0), Buffer.from('vide', 'latin1'), zeros(12), Buffer.from('VideoHandler\0', 'latin1')),
    minf,
  );
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0), rotationMatrix(rotation), u32(width << 16), u32(height << 16));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  // Laid out like ffmpeg's dash muxer (what the Matter SDK camera uses), which hubs are tested with
  const edts = box('edts', fullBox('elst', 0, 0, u32(1), u32(0), u32(0), u32(0x00010000)));
  const ftyp = box('ftyp', Buffer.from('iso5', 'latin1'), u32(0x200), Buffer.from('iso5iso6mp41', 'latin1'));
  return Buffer.concat([ftyp, box('moov', mvhd, box('trak', tkhd, edts, mdia), mvex)]);
}

export interface Sample {
  /** NAL units of the access unit, without start codes. */
  nals: Buffer[];
  keyframe: boolean;
  /** In 90 kHz ticks. */
  duration: number;
}

/**
 * One CMAF media segment, laid out like ffmpeg's: styp, sidx (with the segment duration), moof, mdat.
 * Every sample gets the same duration (the segment average), given once in tfhd as ffmpeg does.
 * `baseTime` is the decode time of the first sample (90 kHz). Returns the segment and its duration.
 */
export function mediaSegment(sequence: number, baseTime: number, samples: Sample[]): { data: Buffer; duration: number } {
  const payloads = samples.map((s) =>
    Buffer.concat(
      s.nals
        // parameter sets live in the init segment (avc1); access unit delimiters are not needed
        .filter((n) => ![7, 8, 9].includes(n[0] & 0x1f))
        .flatMap((n) => [u32(n.length), n]),
    ),
  );
  const total = samples.reduce((a, s) => a + s.duration, 0);
  const sampleDuration = Math.max(1, Math.round(total / samples.length));
  const duration = sampleDuration * samples.length;
  const flagsOf = (s: Sample): number => (s.keyframe ? 0x02000000 : 0x01010000);
  const entries = samples.map((s, i) => Buffer.concat([u32(payloads[i].length), u32(flagsOf(s))]));
  const build = (dataOffset: number): Buffer =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        // default-base-is-moof, default sample duration, size and flags
        fullBox('tfhd', 0, 0x020038, u32(1), u32(sampleDuration), u32(payloads[0]?.length ?? 0), u32(0x01010000)),
        fullBox('tfdt', 1, 0, u64(baseTime)),
        // data offset, sample sizes, sample flags
        fullBox('trun', 0, 0x000601, u32(samples.length), u32(dataOffset), ...entries),
      ),
    );
  const moofSize = build(0).length;
  const moof = build(moofSize + 8);
  const mdat = box('mdat', ...payloads);
  const startsWithKeyframe = samples[0]?.keyframe ? 0x90000000 : 0;
  const sidx = fullBox('sidx', 1, 0, u32(1), u32(TIMESCALE), u64(baseTime), u64(0), u16(0), u16(1), u32(moof.length + mdat.length), u32(duration), u32(startsWithKeyframe));
  const styp = box('styp', Buffer.from('msdh', 'latin1'), u32(0), Buffer.from('msdhmsix', 'latin1'));
  return { data: Buffer.concat([styp, sidx, moof, mdat]), duration };
}

// ----- AAC audio track (its own init and segments, like ffmpeg's dash muxer) -----

/** "mp4a.40.2" style codec string from the AudioSpecificConfig. */
export function aacCodecString(config: Buffer): string {
  return `mp4a.40.${config[0] >> 3}`;
}

/** Channels from the AudioSpecificConfig. */
export function aacChannels(config: Buffer): number {
  return ((config[1] >> 3) & 0x0f) || 1;
}

const descriptor = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u8(tag), u8(body.length), body]);
};

export function audioInitSegment(config: Buffer, sampleRate: number, channels: number, priming = 0): Buffer {
  const esds = fullBox(
    'esds',
    0,
    0,
    descriptor(
      0x03,
      u16(1), // ES_ID
      u8(0),
      descriptor(0x04, u8(0x40), u8(0x15), Buffer.from([0, 0, 0]), u32(0), u32(0), descriptor(0x05, config)),
      descriptor(0x06, u8(0x02)),
    ),
  );
  const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 65536), esds);
  return audioInit(mp4a, sampleRate, priming);
}

/** Opus in MP4 (ISO/IEC 23003-5 style 'Opus' + 'dOps'); the timescale is always 48 kHz. */
export function opusInitSegment(channels: number, inputSampleRate: number, preSkip = 312): Buffer {
  const dOps = box('dOps', u8(0), u8(channels), u16(preSkip), u32(inputSampleRate), u16(0), u8(0));
  // like ffmpeg: a bitrate box, and an edit list that skips the encoder's start-up samples (pre-skip)
  const btrt = box('btrt', u32(0), u32(24000), u32(24000));
  const entry = box('Opus', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(48000 * 65536), dOps, btrt);
  return audioInit(entry, 48000, preSkip);
}

function audioInit(sampleEntry: Buffer, sampleRate: number, mediaTime = 0): Buffer {
  const stbl = box('stbl', fullBox('stsd', 0, 0, u32(1), sampleEntry), fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), stbl);
  const mdia = box(
    'mdia',
    fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(0), u16(0x55c4), u16(0)),
    fullBox('hdlr', 0, 0, u32(0), Buffer.from('soun', 'latin1'), zeros(12), Buffer.from('SoundHandler\0', 'latin1')),
    minf,
  );
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(1), u16(0x0100), u16(0), MATRIX, u32(0), u32(0));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  const edts = box('edts', fullBox('elst', 0, 0, u32(1), u32(0), u32(mediaTime), u32(0x00010000)));
  const ftyp = box('ftyp', Buffer.from('iso5', 'latin1'), u32(0x200), Buffer.from('iso5iso6mp41', 'latin1'));
  return Buffer.concat([ftyp, box('moov', mvhd, box('trak', tkhd, edts, mdia), mvex)]);
}

/** One audio media segment (AAC: 1024 samples per frame; Opus: 960 at 48 kHz). `baseTime` in timescale units. */
export function audioSegment(sequence: number, baseTime: number, frames: Buffer[], timescale: number, frameDuration: number): { data: Buffer; duration: number } {
  const duration = frames.length * frameDuration;
  const build = (dataOffset: number): Buffer =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        fullBox('tfhd', 0, 0x020038, u32(1), u32(frameDuration), u32(frames[0]?.length ?? 0), u32(0x02000000)),
        fullBox('tfdt', 1, 0, u64(baseTime)),
        fullBox('trun', 0, 0x000201, u32(frames.length), u32(dataOffset), ...frames.map((f) => u32(f.length))),
      ),
    );
  const moofSize = build(0).length;
  const moof = build(moofSize + 8);
  const mdat = box('mdat', ...frames);
  return { data: Buffer.concat([box('styp', Buffer.from('msdh', 'latin1'), u32(0), Buffer.from('msdhmsix', 'latin1')), fullBox('sidx', 1, 0, u32(1), u32(timescale), u64(baseTime), u64(0), u16(0), u16(1), u32(moof.length + mdat.length), u32(duration), u32(0x90000000)), moof, mdat]), duration };
}
