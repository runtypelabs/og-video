// Frames -> AV1 (libaom realtime) -> a plain progressive MP4 (ftyp, moov, mdat).
//
// AV1 in wasm encodes several times slower than x264 ultrafast, too slow to stream a live tail
// faster than it plays, so the AV1 variant is one whole file: rendered once, then cached. It is
// not fragmented and has no prefix; moov comes first so players can start before mdat arrives.

/** Bump whenever the bytes an AV1 render produces change: AV1 cache keys include it. */
export const AV1_VERSION = '1'

/** Encoder settings: libaom realtime speed 10, constant quality 30, screen-content tools. */
export const AV1_DEFAULTS = { fps: 120, speed: 10, cq: 30, screen: true }

/**
 * The scenario retimed to `fps`: same duration, frames scaled. Scenarios seek their timeline by
 * i / fps, so any rate works. The prefix is scaled too (it only matters for H.264 streaming).
 */
export function atFps(scenario, fps) {
  const v = scenario.video
  if (!fps || fps === v.fps) return scenario
  const frames = Math.round((v.frames * fps) / v.fps)
  const prefix = Math.max(1, Math.min(frames - 1, Math.round((scenario.prefix.frames * fps) / v.fps)))
  return { ...scenario, video: { ...v, fps, frames }, prefix: { ...scenario.prefix, frames: prefix } }
}

/**
 * Renders and encodes every frame of `run`, skipping frames identical to the previous one (the
 * previous sample then lasts longer) and blocks that did not change. The first and last frames
 * are always encoded. Awaits `yieldToNetwork` after each encoded frame, so a Worker can flush
 * responses and serve other requests during a render that takes seconds. Returns the MP4 bytes
 * and stats.
 */
export async function encodeAv1(encoder, run, { yieldToNetwork, ...settings } = {}) {
  const s = { ...AV1_DEFAULTS, ...settings }
  encoder.open(run.width, run.height, run.fps, s)
  const samples = []
  let held = null
  const push = (c) => {
    if (!c) return
    if (held) samples.push({ ...held, end: c.pts })
    held = c
  }
  let seq
  try {
    let first = true
    for (let i = 0; i < run.frames; i++) {
      const must = first || i === run.frames - 1
      if (!run.frame(i) && !must) continue
      const { yuv, mbInfo, changed } = run.i420()
      if (!changed && !must) continue
      push(encoder.encodeYuv(yuv, i, first, first ? undefined : mbInfo))
      first = false
      if (yieldToNetwork) await yieldToNetwork()
    }
    for (const c of encoder.flush()) push(c)
    if (held) samples.push({ ...held, end: run.frames })
    seq = encoder.sequenceHeader()
  } finally {
    encoder.close()
  }
  const bytes = muxAv1({ width: run.width, height: run.height, fps: run.fps, frames: run.frames, seq, samples })
  return { bytes, codec: av1CodecString(seq), encoded: samples.length, frames: run.frames, fps: run.fps }
}

// ---------------------------------------------------------------- sequence header

/** profile, level and tier from a sequence header OBU (the fields av1C and codec strings need). */
export function readSequenceHeader(obu) {
  // OBU header: forbidden(1) type(4) extension(1) has_size(1) reserved(1), then leb128 size.
  if (((obu[0] >> 3) & 15) !== 1) throw new Error('not a sequence header OBU')
  let o = 1
  if (obu[0] & 4) o++
  if (obu[0] & 2) while (obu[o++] & 0x80);
  let bit = o * 8
  const read = (n) => {
    let v = 0
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((obu[bit >> 3] >> (7 - (bit & 7))) & 1)
    return v
  }
  const profile = read(3)
  read(1) // still_picture
  const reduced = read(1)
  if (reduced) return { profile, level: read(5), tier: 0 }
  if (read(1)) throw new Error('timing_info in the sequence header is not supported')
  if (read(1)) throw new Error('initial_display_delay in the sequence header is not supported')
  if (read(5) !== 0) throw new Error('only one operating point is supported')
  read(12) // operating_point_idc
  const level = read(5)
  const tier = level > 7 ? read(1) : 0
  return { profile, level, tier }
}

// AV1 levels (Annex A): seq_level_idx, max picture size, max width, max height, max display rate.
const LEVELS = [
  [0, 147456, 2048, 1152, 4423680],
  [1, 278784, 2816, 1584, 8363520],
  [4, 665856, 4352, 2448, 19975680],
  [5, 1065024, 5504, 3096, 31950720],
  [8, 2359296, 6144, 3456, 70778880],
  [9, 2359296, 6144, 3456, 141557760],
  [12, 8912896, 8192, 4352, 267386880],
  [13, 8912896, 8192, 4352, 534773760],
  [14, 8912896, 8192, 4352, 1069547520],
  [15, 8912896, 8192, 4352, 1069547520],
  [16, 35651584, 16384, 8704, 1069547520],
]

/**
 * The codec string an encode at this size and rate will have (the lowest level that fits, as
 * libaom picks it), so pages can name it in <source type> before anything is rendered.
 */
export function av1Codec(width, height, fps) {
  const level = LEVELS.find(([, pic, w, h, rate]) => width * height <= pic && width <= w && height <= h && width * height * fps <= rate)?.[0] ?? 31
  return `av01.0.${String(level).padStart(2, '0')}M.08`
}

/** RFC 6381 codec string for an 8-bit 4:2:0 stream, e.g. av01.0.08M.08. */
export function av1CodecString(seq) {
  const { profile, level, tier } = readSequenceHeader(seq)
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.08`
}

// ---------------------------------------------------------------- MP4

const u16 = (n) => [(n >> 8) & 255, n & 255]
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const str = (s) => [...s].map((c) => c.charCodeAt(0))
const box = (type, ...payload) => {
  const body = payload.flat(Infinity)
  return [...u32(8 + body.length), ...str(type), ...body]
}
const full = (type, version, flags, ...payload) => box(type, version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255, ...payload)
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32)

/**
 * A progressive MP4 with one AV1 track. `samples` are temporal units with `pts` and `end` in
 * frames. Deterministic: no wall-clock times are written.
 */
export function muxAv1({ width, height, fps, frames, seq, samples }) {
  // 90 kHz when every frame duration is a whole number of ticks there (24, 30, 60, 120 fps...).
  const timescale = 90000 % fps === 0 ? 90000 : fps * 1000
  const t = (f) => Math.round((f * timescale) / fps)
  const duration = t(frames)
  const movieDuration = Math.round((frames * 1000) / fps)
  const { profile, level, tier } = readSequenceHeader(seq)
  // av1C: marker + version, profile/level, tier + 8-bit 4:2:0 (subsampling x and y), no delay.
  const av1C = box('av1C', 0x81, (profile << 5) | level, (tier << 7) | 0b0000_1100, 0, [...seq])
  const colr = box('colr', str('nclx'), u16(1), u16(1), u16(1), 0) // BT.709, limited range
  const av01 = box('av01', [0, 0, 0, 0, 0, 0], u16(1), u16(0), u16(0), u32(0), u32(0), u32(0), u16(width), u16(height),
    u32(0x480000), u32(0x480000), u32(0), u16(1), Array(32).fill(0), u16(24), u16(0xffff), av1C, colr)
  // stts: run-length durations.
  const runs = []
  for (const s of samples) {
    const d = t(s.end) - t(s.pts)
    if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++
    else runs.push([1, d])
  }
  const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []))
  const stbl = (chunkOffset) =>
    box('stbl',
      full('stsd', 0, 0, u32(1), av01),
      full('stts', 0, 0, u32(runs.length), runs.map(([n, d]) => [u32(n), u32(d)])),
      full('stss', 0, 0, u32(keys.length), keys.map(u32)),
      full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
      full('stsz', 0, 0, u32(0), u32(samples.length), samples.map((s) => u32(s.data.length))),
      full('stco', 0, 0, u32(1), u32(chunkOffset)))
  const moov = (chunkOffset) =>
    box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x10000), u16(0x100), Array(10).fill(0), MATRIX, Array(24).fill(0), u32(2)),
      box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16)),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), str('vide'), Array(12).fill(0), str('VideoHandler'), 0),
          box('minf',
            full('vmhd', 0, 1, Array(8).fill(0)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
            stbl(chunkOffset)))))
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('av01'), str('mp41'))
  const dataLen = samples.reduce((n, s) => n + s.data.length, 0)
  const head = ftyp.length + moov(0).length
  const header = [...ftyp, ...moov(head + 8), ...u32(8 + dataLen), ...str('mdat')]
  const out = new Uint8Array(header.length + dataLen)
  out.set(header, 0)
  let o = header.length
  for (const s of samples) {
    out.set(s.data, o)
    o += s.data.length
  }
  return out
}
