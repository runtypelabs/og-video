// Minimal libaom (AV1, realtime mode) wrapper for WebAssembly: I420 in, AV1 temporal units
// (low-overhead OBUs, as MP4 samples carry them) + the av1C sequence header out.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "aom/aom_encoder.h"
#include "aom/aomcx.h"

#define EXPORT __attribute__((visibility("default")))

static aom_codec_ctx_t codec;
static aom_codec_enc_cfg_t cfg;
static aom_image_t img;
static int W, H, is_open;
static uint8_t *yuv;
static uint8_t *out;
static size_t out_cap, out_len;
static int out_key;
static int64_t out_pts;
// One byte per 16x16 block (1 = unchanged since the previous frame), written by the caller and
// turned into an active map so the encoder skips static blocks.
static uint8_t *mb_info;
static unsigned char *active;
static int mb_cols, mb_rows;

static int ensure_out(size_t n) {
  if (n <= out_cap) return 0;
  uint8_t *p = realloc(out, n);
  if (!p) return -1;
  out = p;
  out_cap = n;
  return 0;
}

#define CTRL(id, v) \
  if (aom_codec_control(&codec, id, v)) return -10 - __LINE__

/** speed: libaom realtime cpu-used (7-12). cq: constant quality level (0-63, lower is better). */
EXPORT int enc_open(int w, int h, int fps, int speed, int cq, int screen) {
  aom_codec_iface_t *iface = aom_codec_av1_cx();
  if (aom_codec_enc_config_default(iface, &cfg, AOM_USAGE_REALTIME)) return -1;
  W = w;
  H = h;
  cfg.g_w = w;
  cfg.g_h = h;
  cfg.g_timebase.num = 1;
  cfg.g_timebase.den = fps;
  cfg.g_threads = 1;
  cfg.g_lag_in_frames = 0;
  cfg.g_error_resilient = 0;
  cfg.rc_end_usage = AOM_Q;
  cfg.rc_dropframe_thresh = 0;
  cfg.rc_min_quantizer = 0;
  cfg.rc_max_quantizer = 63;
  cfg.kf_mode = AOM_KF_DISABLED;
  cfg.kf_min_dist = 0;
  cfg.kf_max_dist = 1 << 30;
  cfg.g_profile = 0;
  cfg.g_bit_depth = AOM_BITS_8;
  cfg.g_input_bit_depth = 8;
  if (aom_codec_enc_init(&codec, iface, &cfg, 0)) return -2;
  is_open = 1;
  CTRL(AOME_SET_CPUUSED, speed);
  CTRL(AOME_SET_CQ_LEVEL, cq);
  CTRL(AV1E_SET_TUNE_CONTENT, screen ? AOM_CONTENT_SCREEN : AOM_CONTENT_DEFAULT);
  CTRL(AV1E_SET_COLOR_PRIMARIES, AOM_CICP_CP_BT_709);
  CTRL(AV1E_SET_TRANSFER_CHARACTERISTICS, AOM_CICP_TC_BT_709);
  CTRL(AV1E_SET_MATRIX_COEFFICIENTS, AOM_CICP_MC_BT_709);
  CTRL(AV1E_SET_COLOR_RANGE, AOM_CR_STUDIO_RANGE);
  CTRL(AV1E_SET_CHROMA_SAMPLE_POSITION, AOM_CSP_UNKNOWN);
  CTRL(AV1E_SET_AQ_MODE, 0);
  CTRL(AV1E_SET_ENABLE_ORDER_HINT, 0);
  CTRL(AV1E_SET_ENABLE_TPL_MODEL, 0);
  CTRL(AV1E_SET_DELTAQ_MODE, 0);
  CTRL(AV1E_SET_ENABLE_CDEF, 1);
  free(yuv);
  yuv = malloc((size_t)w * h * 3 / 2);
  if (!yuv) return -3;
  if (!aom_img_wrap(&img, AOM_IMG_FMT_I420, w, h, 1, yuv)) return -4;
  img.cp = AOM_CICP_CP_BT_709;
  img.tc = AOM_CICP_TC_BT_709;
  img.mc = AOM_CICP_MC_BT_709;
  img.range = AOM_CR_STUDIO_RANGE;
  mb_cols = (w + 15) >> 4;
  mb_rows = (h + 15) >> 4;
  free(mb_info);
  free(active);
  mb_info = calloc(mb_cols * mb_rows, 1);
  active = malloc(mb_cols * mb_rows);
  if (!mb_info || !active) return -5;
  return 0;
}

EXPORT uint8_t *enc_input_ptr(void) { return yuv; }
EXPORT uint8_t *enc_mb_info(void) { return mb_info; }
EXPORT uint8_t *enc_out_ptr(void) { return out; }
EXPORT int enc_out_key(void) { return out_key; }
EXPORT double enc_out_pts(void) { return (double)out_pts; }

// Gathers every compressed packet the encoder has ready into `out` (one temporal unit).
static int drain(void) {
  aom_codec_iter_t iter = NULL;
  const aom_codec_cx_pkt_t *pkt;
  out_len = 0;
  out_key = 0;
  while ((pkt = aom_codec_get_cx_data(&codec, &iter))) {
    if (pkt->kind != AOM_CODEC_CX_FRAME_PKT) continue;
    if (ensure_out(out_len + pkt->data.frame.sz)) return -1;
    memcpy(out + out_len, pkt->data.frame.buf, pkt->data.frame.sz);
    if (!out_len) out_pts = pkt->data.frame.pts;
    out_len += pkt->data.frame.sz;
    if (pkt->data.frame.flags & AOM_FRAME_IS_KEY) out_key = 1;
  }
  return (int)out_len;
}

/**
 * Encodes the frame in enc_input_ptr() at `pts` lasting `duration` (in frames). `key` forces a
 * key frame. `use_mb_info`: skip blocks enc_mb_info() marks unchanged. Returns the length of the
 * temporal unit in enc_out_ptr(), 0 if none yet, < 0 on error.
 */
EXPORT int enc_encode(double pts, int duration, int key, int use_mb_info) {
  if (!is_open) return -1;
  aom_active_map_t map = { active, (unsigned)mb_rows, (unsigned)mb_cols };
  if (use_mb_info)
    for (int i = 0; i < mb_cols * mb_rows; i++) active[i] = !mb_info[i];
  else
    memset(active, 1, mb_cols * mb_rows);
  if (aom_codec_control(&codec, AOME_SET_ACTIVEMAP, &map)) return -2;
  if (aom_codec_encode(&codec, &img, (aom_codec_pts_t)pts, duration, key ? AOM_EFLAG_FORCE_KF : 0)) return -3;
  return drain();
}

/** Returns the next pending temporal unit's length, 0 when the encoder is empty. */
EXPORT int enc_flush(void) {
  if (aom_codec_encode(&codec, NULL, 0, 0, 0)) return -1;
  return drain();
}

/** The sequence header OBU (for av1C configOBUs) in enc_out_ptr(); returns its length. */
EXPORT int enc_headers(void) {
  aom_fixed_buf_t *h = aom_codec_get_global_headers(&codec);
  if (!h) return -1;
  if (ensure_out(h->sz)) return -2;
  memcpy(out, h->buf, h->sz);
  int n = (int)h->sz;
  free(h->buf);
  free(h);
  return n;
}

EXPORT void enc_close(void) {
  if (is_open) aom_codec_destroy(&codec);
  is_open = 0;
}

EXPORT void *wmalloc(size_t n) { return malloc(n); }
EXPORT void wfree(void *p) { free(p); }
