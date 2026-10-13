/**
 * Snapshots without ffmpeg: one keyframe is decoded by OpenH264 compiled to WebAssembly (vendor/snapshot,
 * about 530 KB, with a scaler and stb_image_write for the JPEG). Matter allows at most 64000 B per snapshot.
 */
import { createRequire } from 'node:module';

import { AccessUnit } from './rtsp.js';

const MAX_BYTES = 64000;

interface SnapshotModule {
  HEAPU8: Uint8Array;
  _snap_alloc: (n: number) => number;
  _snap_free: (p: number) => void;
  _snap_decode: (p: number, len: number) => number;
  _snap_encode: (width: number, quality: number, rotation: number) => number;
  _snap_out: () => number;
  _snap_out_len: () => number;
}
let module: Promise<SnapshotModule> | undefined;
function load(): Promise<SnapshotModule> {
  const require = createRequire(import.meta.url);
  module ??= (require('../vendor/snapshot/snapshot.js') as () => Promise<SnapshotModule>)();
  return module;
}

/** JPEG of at most 64000 B (the Matter limit) from a keyframe, as close to the requested width as fits. */
export async function snapshotFromKeyframe(au: AccessUnit, sps: Buffer | undefined, pps: Buffer | undefined, requestedWidth: number, sourceWidth: number, rotation = 0): Promise<{ data: Buffer; width: number; height: number; quality: number }> {
  const start = Buffer.from([0, 0, 0, 1]);
  const nals = au.nals.some((n) => (n[0] & 0x1f) === 7) ? au.nals : [...(sps ? [sps] : []), ...(pps ? [pps] : []), ...au.nals];
  const annexB = Buffer.concat(nals.flatMap((n) => [start, n]));
  const firstWidth = Math.min(requestedWidth || 1920, sourceWidth || 1920);
  const widths = [firstWidth, 1280, 960, 640].filter((w, i, all) => w <= firstWidth && all.indexOf(w) === i);
  // decode once, then only the JPEG is redone for each size and quality (all synchronous, so two snapshots
  // at the same time cannot swap the kept picture between them)
  const m = await load();
  const p = m._snap_alloc(annexB.length);
  m.HEAPU8.set(annexB, p);
  const decoded = m._snap_decode(p, annexB.length);
  m._snap_free(p);
  if (decoded < 0) throw new Error(decoded <= -1000 ? `the keyframe could not be decoded (OpenH264 status ${-1000 - decoded})` : `snapshot error ${decoded}`);
  let last = 0;
  for (const width of widths) {
    for (const quality of [85, 75, 60, 45]) {
      const result = m._snap_encode(width - (width % 2), quality, rotation);
      if (result < 0) throw new Error(`snapshot error ${result}`);
      last = m._snap_out_len();
      // far too big: a lower quality will not save this size, go to the next smaller one
      if (last > MAX_BYTES * 1.6) break;
      if (last <= MAX_BYTES) {
        const out = m._snap_out();
        return { data: Buffer.from(m.HEAPU8.subarray(out, out + last)), width: result >> 16, height: result & 0xffff, quality };
      }
    }
  }
  throw new Error(`snapshot still ${last} B at 640 px (Matter limit ${MAX_BYTES} B)`);
}
