// Minimal x264 wrapper for WebAssembly: RGBA in, length-prefixed H.264 NALs + avcC out.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "x264.h"

#define EXPORT __attribute__((visibility("default")))

static x264_t *enc;
static x264_param_t param;
static x264_picture_t pic_in;
static int W, H;
static uint8_t *rgba;
static uint8_t *out;
static size_t out_cap;
static int out_key;
static double out_pts, out_dts;
// x264's version/options SEI comes out of x264_encoder_headers; prepend it to the first frame.
static uint8_t *sei;
static int sei_len;
// Set before enc_open: timestamps are frame indices but frames may be skipped (variable frame rate).
static int vfr;
// One byte per macroblock (X264_MBINFO_CONSTANT for unchanged ones), written by the caller.
// x264 may analyse a frame after later ones have been submitted, so each frame gets its own copy,
// which x264 frees when it is done with it.
static uint8_t *mb_info;
static size_t mb_count;

static int ensure_out(size_t n) {
  if (n <= out_cap) return 0;
  uint8_t *p = realloc(out, n);
  if (!p) return -1;
  out = p;
  out_cap = n;
  return 0;
}

EXPORT int enc_open(int w, int h, int fps, const char *params) {
  W = w;
  H = h;
  if (x264_param_default_preset(&param, "slow", NULL) < 0) return -1;
  param.i_csp = X264_CSP_I420;
  param.i_width = w;
  param.i_height = h;
  param.i_fps_num = fps;
  param.i_fps_den = 1;
  param.i_timebase_num = 1;
  param.i_timebase_den = fps;
  param.b_vfr_input = 0;
  param.b_annexb = 0;
  param.b_repeat_headers = 0;
  param.i_threads = 1;
  param.i_log_level = X264_LOG_NONE;
  if (params && *params) {
    char *copy = strdup(params);
    char *save = NULL;
    for (char *kv = strtok_r(copy, ":", &save); kv; kv = strtok_r(NULL, ":", &save)) {
      char *eq = strchr(kv, '=');
      const char *val = NULL;
      if (eq) {
        *eq = 0;
        val = eq + 1;
      }
      if (!strcmp(kv, "preset")) {
        // Re-apply a preset, keeping the fields set above.
        x264_param_t keep = param;
        x264_param_default_preset(&param, val, NULL);
        param.i_csp = keep.i_csp; param.i_width = keep.i_width; param.i_height = keep.i_height;
        param.i_fps_num = keep.i_fps_num; param.i_fps_den = keep.i_fps_den;
        param.i_timebase_num = keep.i_timebase_num; param.i_timebase_den = keep.i_timebase_den;
        param.b_vfr_input = 0; param.b_annexb = 0; param.b_repeat_headers = 0;
        param.i_threads = 1; param.i_log_level = X264_LOG_NONE;
        continue;
      }
      if (x264_param_parse(&param, kv, val) < 0) {
        free(copy);
        return -2;
      }
    }
    free(copy);
  }
  param.b_vfr_input = vfr;
  param.analyse.b_mb_info = 1;
  if (x264_param_apply_profile(&param, "high") < 0) return -3;
  enc = x264_encoder_open(&param);
  if (!enc) return -4;
  if (x264_picture_alloc(&pic_in, X264_CSP_I420, w, h) < 0) return -5;
  rgba = malloc((size_t)w * h * 4);
  mb_count = (size_t)((w + 15) / 16) * ((h + 15) / 16);
  mb_info = calloc(mb_count, 1);
  return rgba && mb_info ? 0 : -6;
}

EXPORT uint8_t *enc_input_ptr(void) { return rgba; }
EXPORT uint8_t *enc_out_ptr(void) { return out; }
EXPORT int enc_out_key(void) { return out_key; }
EXPORT double enc_out_pts(void) { return out_pts; }
EXPORT double enc_out_dts(void) { return out_dts; }

// BT.709 limited range, fixed point (Q16), chroma from the 2x2 average.
static void rgba_to_i420(void) {
  uint8_t *Y = pic_in.img.plane[0], *U = pic_in.img.plane[1], *V = pic_in.img.plane[2];
  int ys = pic_in.img.i_stride[0], us = pic_in.img.i_stride[1], vs = pic_in.img.i_stride[2];
  // Coefficients scaled by 219/255 (luma) and 224/255 (chroma), Q16.
  const int YR = 11966, YG = 40254, YB = 4064;   // 0.2126,0.7152,0.0722 * 219/255
  const int UR = -6597, UG = -22187, UB = 28784; // -0.1146,-0.3854,0.5 * 224/255
  const int VR = 28784, VG = -26147, VB = -2637; // 0.5,-0.4542,-0.0458 * 224/255
  for (int y = 0; y < H; y++) {
    const uint8_t *s = rgba + (size_t)y * W * 4;
    uint8_t *d = Y + (size_t)y * ys;
    for (int x = 0; x < W; x++, s += 4)
      d[x] = (uint8_t)(((YR * s[0] + YG * s[1] + YB * s[2] + 32768) >> 16) + 16);
  }
  for (int y = 0; y < H / 2; y++) {
    const uint8_t *s0 = rgba + (size_t)(2 * y) * W * 4;
    const uint8_t *s1 = s0 + (size_t)W * 4;
    uint8_t *du = U + (size_t)y * us, *dv = V + (size_t)y * vs;
    for (int x = 0; x < W / 2; x++) {
      int i = 8 * x;
      int r = s0[i] + s0[i + 4] + s1[i] + s1[i + 4];
      int g = s0[i + 1] + s0[i + 5] + s1[i + 1] + s1[i + 5];
      int b = s0[i + 2] + s0[i + 6] + s1[i + 2] + s1[i + 6];
      // Sums are 4x, so shift by 18 instead of 16.
      du[x] = (uint8_t)(((UR * r + UG * g + UB * b + (1 << 17)) >> 18) + 128);
      dv[x] = (uint8_t)(((VR * r + VG * g + VB * b + (1 << 17)) >> 18) + 128);
    }
  }
}

static int collect(x264_nal_t *nals, int n, int size, x264_picture_t *pic_out) {
  if (size <= 0) return size;
  int pre = sei_len;
  if (ensure_out(size + pre)) return -1;
  if (pre) memcpy(out, sei, pre);
  // With b_annexb=0 the payloads are contiguous and already length-prefixed.
  memcpy(out + pre, nals[0].p_payload, size);
  free(sei);
  sei = NULL;
  sei_len = 0;
  size += pre;
  out_key = pic_out->b_keyframe;
  out_pts = (double)pic_out->i_pts;
  out_dts = (double)pic_out->i_dts;
  return size;
}

EXPORT int enc_encode(int64_t pts) {
  x264_nal_t *nals;
  int n;
  x264_picture_t pic_out;
  rgba_to_i420();
  pic_in.i_pts = pts;
  int size = x264_encoder_encode(enc, &nals, &n, &pic_in, &pic_out);
  return collect(nals, n, size, &pic_out);
}

EXPORT void enc_set_vfr(int on) { vfr = on; }
EXPORT uint8_t *enc_plane(int i) { return pic_in.img.plane[i]; }
EXPORT int enc_stride(int i) { return pic_in.img.i_stride[i]; }

/** Encodes the I420 picture already written into enc_plane(0..2); key != 0 forces an IDR. */
EXPORT uint8_t *enc_mb_info(void) { return mb_info; }

EXPORT int enc_encode_yuv(int64_t pts, int key) {
  x264_nal_t *nals;
  int n;
  x264_picture_t pic_out;
  pic_in.i_pts = pts;
  pic_in.i_type = key ? X264_TYPE_IDR : X264_TYPE_AUTO;
  uint8_t *copy = malloc(mb_count);
  if (!copy) return -1;
  memcpy(copy, mb_info, mb_count);
  pic_in.prop.mb_info = copy;
  pic_in.prop.mb_info_free = free;
  int size = x264_encoder_encode(enc, &nals, &n, &pic_in, &pic_out);
  pic_in.i_type = X264_TYPE_AUTO;
  return collect(nals, n, size, &pic_out);
}

EXPORT int enc_flush(void) {
  x264_nal_t *nals;
  int n;
  x264_picture_t pic_out;
  if (!x264_encoder_delayed_frames(enc)) return 0;
  int size = x264_encoder_encode(enc, &nals, &n, NULL, &pic_out);
  return collect(nals, n, size, &pic_out);
}

EXPORT int enc_headers(void) {
  x264_nal_t *nals;
  int n;
  if (x264_encoder_headers(enc, &nals, &n) < 0) return -1;
  const uint8_t *sps = NULL, *pps = NULL;
  int sps_len = 0, pps_len = 0;
  for (int i = 0; i < n; i++) {
    // Skip the 4-byte length prefix.
    if (nals[i].i_type == NAL_SPS) { sps = nals[i].p_payload + 4; sps_len = nals[i].i_payload - 4; }
    if (nals[i].i_type == NAL_PPS) { pps = nals[i].p_payload + 4; pps_len = nals[i].i_payload - 4; }
    if (nals[i].i_type == NAL_SEI && !sei) {
      sei = malloc(nals[i].i_payload);
      if (sei) { memcpy(sei, nals[i].p_payload, nals[i].i_payload); sei_len = nals[i].i_payload; }
    }
  }
  if (!sps || !pps) return -2;
  int len = 6 + 2 + sps_len + 1 + 2 + pps_len + 4;
  if (ensure_out(len)) return -3;
  uint8_t *p = out;
  *p++ = 1;          // configurationVersion
  *p++ = sps[1];     // AVCProfileIndication
  *p++ = sps[2];     // profile_compatibility
  *p++ = sps[3];     // AVCLevelIndication
  *p++ = 0xff;       // lengthSizeMinusOne = 3
  *p++ = 0xe1;       // one SPS
  *p++ = sps_len >> 8; *p++ = sps_len & 0xff;
  memcpy(p, sps, sps_len); p += sps_len;
  *p++ = 1;          // one PPS
  *p++ = pps_len >> 8; *p++ = pps_len & 0xff;
  memcpy(p, pps, pps_len); p += pps_len;
  // High profile extension: chroma_format=1 (4:2:0), 8-bit luma/chroma, no SPS ext.
  if (sps[1] == 100 || sps[1] == 110 || sps[1] == 122 || sps[1] == 144) {
    *p++ = 0xfc | 1;
    *p++ = 0xf8 | 0;
    *p++ = 0xf8 | 0;
    *p++ = 0;
  }
  return (int)(p - out);
}

EXPORT void enc_close(void) {
  if (enc) x264_encoder_close(enc);
  enc = NULL;
  x264_picture_clean(&pic_in);
  free(rgba);
  rgba = NULL;
  free(mb_info);
  mb_info = NULL;
}

EXPORT void *wmalloc(size_t n) { return malloc(n); }
EXPORT void wfree(void *p) { free(p); }
