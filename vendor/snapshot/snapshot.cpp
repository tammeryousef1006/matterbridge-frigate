// Snapshot from one H.264 keyframe, no ffmpeg: OpenH264 (BSD) decodes, a box/bilinear scaler turns and
// resizes, stb_image_write (public domain / MIT) writes the JPEG. Built with Emscripten into one module.
#include "codec_api.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "stb_image_write.h"
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

static unsigned char *out = nullptr;
static int outLen = 0, outCap = 0;

static void writeOut(void *, void *data, int size) {
  if (outLen + size > outCap) {
    outCap = (outLen + size) * 2;
    out = (unsigned char *)realloc(out, outCap);
  }
  memcpy(out + outLen, data, size);
  outLen += size;
}

static inline unsigned char clip(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

extern "C" {
EMSCRIPTEN_KEEPALIVE unsigned char *snap_alloc(int n) { return (unsigned char *)malloc(n); }
EMSCRIPTEN_KEEPALIVE void snap_free(void *p) { free(p); }
EMSCRIPTEN_KEEPALIVE unsigned char *snap_out() { return out; }
EMSCRIPTEN_KEEPALIVE int snap_out_len() { return outLen; }

// The last decoded picture (I420, tightly packed), kept so it can be encoded at several sizes and qualities.
static unsigned char *pic = nullptr;
static int picW = 0, picH = 0;

// Decodes one access unit (Annex B, with SPS/PPS) and keeps the picture. Returns (width << 16) | height, or < 0.
EMSCRIPTEN_KEEPALIVE int snap_decode(unsigned char *annexb, int len) {
  ISVCDecoder *dec = nullptr;
  if (WelsCreateDecoder(&dec) != 0 || !dec) return -1;
  SDecodingParam param;
  memset(&param, 0, sizeof(param));
  param.sVideoProperty.eVideoBsType = VIDEO_BITSTREAM_AVC;
  param.eEcActiveIdc = ERROR_CON_DISABLE;
  param.uiTargetDqLayer = (unsigned char)-1; // all layers, as OpenH264's own console decoder sets it
  if (dec->Initialize(&param) != 0) {
    WelsDestroyDecoder(dec);
    return -2;
  }
  // a start code after the last NAL tells the decoder the slice is complete (as OpenH264's console decoder does)
  unsigned char *buf = (unsigned char *)malloc(len + 4);
  memcpy(buf, annexb, len);
  buf[len] = 0; buf[len + 1] = 0; buf[len + 2] = 0; buf[len + 3] = 1;
  unsigned char *yuv[3] = {nullptr, nullptr, nullptr};
  SBufferInfo info;
  memset(&info, 0, sizeof(info));
  int rv = dec->DecodeFrameNoDelay(buf, len + 4, yuv, &info);
  free(buf);
  if (info.iBufferStatus != 1) {
    int end = 1;
    dec->SetOption(DECODER_OPTION_END_OF_STREAM, &end);
    int remaining = 0;
    dec->GetOption(DECODER_OPTION_NUM_OF_FRAMES_REMAINING_IN_BUFFER, &remaining);
    for (int i = 0; i < remaining && info.iBufferStatus != 1; i++) {
      memset(&info, 0, sizeof(info));
      rv |= dec->FlushFrame(yuv, &info);
    }
  }
  if (info.iBufferStatus != 1) {
    dec->Uninitialize();
    WelsDestroyDecoder(dec);
    return -1000 - rv; // no picture: OpenH264 status flags in the result
  }
  const int w = info.UsrData.sSystemBuffer.iWidth, h = info.UsrData.sSystemBuffer.iHeight;
  const int sy = info.UsrData.sSystemBuffer.iStride[0], suv = info.UsrData.sSystemBuffer.iStride[1];
  free(pic);
  pic = (unsigned char *)malloc((size_t)w * h * 3 / 2);
  for (int y = 0; y < h; y++) memcpy(pic + (size_t)y * w, info.pDst[0] + (size_t)y * sy, w);
  unsigned char *u = pic + (size_t)w * h, *v = u + (size_t)(w / 2) * (h / 2);
  for (int y = 0; y < h / 2; y++) {
    memcpy(u + (size_t)y * (w / 2), info.pDst[1] + (size_t)y * suv, w / 2);
    memcpy(v + (size_t)y * (w / 2), info.pDst[2] + (size_t)y * suv, w / 2);
  }
  picW = w;
  picH = h;
  dec->Uninitialize();
  WelsDestroyDecoder(dec);
  return (w << 16) | h;
}

// Writes a JPEG of the kept picture, at most targetWidth pixels wide (before rotation), rotated clockwise by
// 0/90/180/270. Returns (width << 16) | height of the JPEG, or < 0.
EMSCRIPTEN_KEEPALIVE int snap_encode(int targetWidth, int quality, int rotation) {
  if (!pic) return -3;
  const int w = picW, h = picH, sy = w, suv = w / 2;
  const unsigned char *yuv[3] = {pic, pic + (size_t)w * h, pic + (size_t)w * h + (size_t)(w / 2) * (h / 2)};
  int tw = targetWidth > 0 && targetWidth < w ? targetWidth : w;
  tw &= ~1;
  int th = (int)((long long)h * tw / w) & ~1;
  const bool turn = rotation == 90 || rotation == 270;
  const int ow = turn ? th : tw, oh = turn ? tw : th;
  unsigned char *rgb = (unsigned char *)malloc((size_t)ow * oh * 3);
  const float fx = (float)w / tw, fy = (float)h / th;
  const int bx = fx >= 2 ? (int)fx : 1, by = fy >= 2 ? (int)fy : 1; // box average when shrinking a lot
  for (int Y = 0; Y < oh; Y++) {
    for (int X = 0; X < ow; X++) {
      int x, yy; // position in the scaled (unrotated) picture
      if (rotation == 90) { x = Y; yy = th - 1 - X; }
      else if (rotation == 180) { x = tw - 1 - X; yy = th - 1 - Y; }
      else if (rotation == 270) { x = tw - 1 - Y; yy = X; }
      else { x = X; yy = Y; }
      const int px = (int)(x * fx), py = (int)(yy * fy);
      int sum = 0, n = 0;
      for (int j = 0; j < by && py + j < h; j++)
        for (int i = 0; i < bx && px + i < w; i++) { sum += yuv[0][(py + j) * sy + px + i]; n++; }
      const int L = sum / (n ? n : 1);
      const int U = yuv[1][(py / 2) * suv + px / 2] - 128, V = yuv[2][(py / 2) * suv + px / 2] - 128;
      const int C = (L - 16) * 298;
      unsigned char *p = rgb + ((size_t)Y * ow + X) * 3;
      p[0] = clip((C + 409 * V + 128) >> 8);
      p[1] = clip((C - 100 * U - 208 * V + 128) >> 8);
      p[2] = clip((C + 516 * U + 128) >> 8);
    }
  }
  outLen = 0;
  const int ok = stbi_write_jpg_to_func(writeOut, nullptr, ow, oh, 3, rgb, quality);
  free(rgb);
  return ok ? (ow << 16) | oh : -4;
}
}

// OpenH264's thread helpers reference sem_timedwait; the decoder runs single-threaded here and never waits.
#include <semaphore.h>
#include <errno.h>
extern "C" int sem_timedwait(sem_t *, const struct timespec *) {
  errno = ETIMEDOUT;
  return -1;
}
