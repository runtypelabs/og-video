// Frames -> H.264 -> fragmented MP4, as a prefix (a complete head: ftyp + moov + one fragment)
// and a live tail (one small fragment per encoded frame, continuing the prefix's sequence numbers
// and timestamps). A stream is always prefix + tail, whether the prefix was bundled, cached or
// encoded just now, so every render of the same params produces the same bytes.
import { Muxer, StreamTarget } from 'mp4-muxer'

/**
 * x264 settings: fast, constant quality, no B-frames (so samples come out in display order). qp 20
 * suits flat vector art; dense motion of fine detail (many small moving words) can use a higher
 * qp through the scenario's `video.qp`, for a smaller file and a faster encode.
 */
export const x264Params = (qp = 20) =>
  `preset=ultrafast:qp=${qp}:bframes=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:keyint=infinite:scenecut=0`

/**
 * Renders and encodes frames [from, to). Calls onSample({ data, key, pts, end }) for each encoded
 * frame once its duration is known (`end` = pts of the next encoded frame, or `to`). Frames
 * identical to the previous one are skipped, so samples have variable durations. The first
 * encoded frame is an IDR; no other is forced.
 */
export async function encodeFrames(encoder, run, { from = 0, to, onOpen, onSample, yieldToNetwork, frameStep = () => 1 }) {
  const end = to ?? run.frames
  encoder.open(run.width, run.height, run.fps, x264Params(run.qp))
  const avcC = encoder.avcC()
  onOpen?.(avcC)
  let held = null
  let encoded = 0
  let skipped = 0
  const push = (c) => {
    if (!c) return
    if (held) onSample({ ...held, end: c.pts })
    held = c
  }
  try {
    let first = true
    let lastEncoded = from - 1
    for (let i = from; i < end; i++) {
      // Under load, render only every step-th frame; the previous sample simply lasts longer.
      if (!first && i !== end - 1 && i - lastEncoded < frameStep()) {
        skipped++
        continue
      }
      // The last frame is always encoded, even unchanged (it is then all skip blocks): players
      // that read the duration from the last sample's start would otherwise cut a final hold.
      const must = first || i === end - 1
      if (!run.frame(i) && !must) continue
      const { yuv, mbInfo, changed } = run.i420()
      if (!changed && !must) continue
      push(encoder.encodeYuv(yuv, i, first, first ? undefined : mbInfo))
      encoded++
      first = false
      lastEncoded = i
      if (yieldToNetwork) await yieldToNetwork()
    }
    for (const c of encoder.flush()) push(c)
    if (held) onSample({ ...held, end })
  } finally {
    encoder.close()
  }
  return { avcC, encoded, skipped }
}

export const codecString = (avcC) => `avc1.${[...avcC.subarray(1, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`

/** A prefix: a complete fMP4 head covering frames [0, frames). */
export async function buildPrefix(encoder, run, frames) {
  const parts = []
  const muxer = new Muxer({
    target: new StreamTarget({ onData: (data, position) => parts.push({ data: data.slice(), position }) }),
    video: { codec: 'avc', width: run.width, height: run.height, frameRate: run.fps },
    fastStart: 'fragmented',
    // One fragment for the whole prefix: it is sent in one go anyway.
    minFragmentDuration: 1e6,
  })
  const samples = []
  const { avcC } = await encodeFrames(encoder, run, { to: frames, onSample: (s) => samples.push(s) })
  const codec = codecString(avcC)
  samples.forEach((s, i) => {
    muxer.addVideoChunkRaw(s.data, s.key ? 'key' : 'delta', (s.pts * 1e6) / run.fps, ((s.end - s.pts) * 1e6) / run.fps,
      i ? undefined : { decoderConfig: { codec, codedWidth: run.width, codedHeight: run.height, description: avcC } })
  })
  muxer.finalize()
  const size = parts.reduce((n, p) => Math.max(n, p.position + p.data.length), 0)
  const bytes = new Uint8Array(size)
  for (const p of parts) bytes.set(p.data, p.position)
  zeroTimes(bytes)
  return { bytes, avcC, frames, ...readPrefix(bytes) }
}

/**
 * The muxer stamps the wall clock into mvhd, tkhd and mdhd. Zero those, so the same params give
 * the same bytes in every isolate and every second (byte ranges of separate renders must fit).
 */
function zeroTimes(bytes) {
  for (let i = 0; i + 8 <= bytes.length; i++) {
    const t = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7])
    if (t !== 'mvhd' && t !== 'tkhd' && t !== 'mdhd') continue
    // FullBox: version (1 byte) + flags (3), then creation and modification time (u32, or u64 in v1).
    const n = bytes[i + 8] === 1 ? 16 : 8
    bytes.fill(0, i + 12, i + 12 + n)
  }
}

// ---------------------------------------------------------------- fMP4 boxes

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const box = (type, ...payload) => {
  const body = payload.flat()
  return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body]
}

/** What a live tail needs to continue a prefix: timescale, track id, next sequence number, avcC. */
export function readPrefix(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const find = (type, from = 0) => {
    for (let i = from; i + 8 <= bytes.length; i++)
      if (bytes[i + 4] === type.charCodeAt(0) && bytes[i + 5] === type.charCodeAt(1) && bytes[i + 6] === type.charCodeAt(2) && bytes[i + 7] === type.charCodeAt(3)) return i
    return -1
  }
  const mdhd = find('mdhd')
  const timescale = view.getUint32(mdhd + 8 + 4 + (bytes[mdhd + 8] === 1 ? 16 : 8))
  const tkhd = find('tkhd')
  const trackId = view.getUint32(tkhd + 8 + 4 + (bytes[tkhd + 8] === 1 ? 16 : 8))
  let seq = 0
  for (let i = find('mfhd'); i >= 0; i = find('mfhd', i + 8)) seq = Math.max(seq, view.getUint32(i + 12))
  const avcCAt = find('avcC')
  const avcC = bytes.slice(avcCAt + 8, avcCAt + view.getUint32(avcCAt))
  return { timescale, trackId, nextSeq: seq + 1, avcC }
}

/** One moof + mdat holding `samples` ({ data, key, pts, end } in frames), starting at samples[0].pts. */
export function fragment({ timescale, trackId, fps }, seq, samples) {
  const t = (frames) => Math.round((frames * timescale) / fps)
  const base = t(samples[0].pts)
  const entries = samples.flatMap((s) => [
    ...u32(t(s.end) - t(s.pts)),
    ...u32(s.data.length),
    // sample_depends_on = 2 (independent) for IDRs; otherwise depends on others + non-sync.
    ...u32(s.key ? 0x0200_0000 : 0x0101_0000),
  ])
  const mfhd = box('mfhd', u32(0), u32(seq))
  const tfhd = box('tfhd', u32(0x020000), u32(trackId)) // default-base-is-moof
  const tfdt = box('tfdt', [1, 0, 0, 0], u32(Math.floor(base / 2 ** 32)), u32(base >>> 0))
  const trunHead = (dataOffset) => [...u32(0x000701), ...u32(samples.length), ...u32(dataOffset)]
  // data_offset counts from the start of moof to the first sample byte, so size moof first.
  const moofSize = 8 + mfhd.length + 8 + tfhd.length + tfdt.length + 8 + 12 + entries.length
  const trun = box('trun', trunHead(moofSize + 8), entries)
  const moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun))
  const dataLen = samples.reduce((n, s) => n + s.data.length, 0)
  const out = new Uint8Array(moof.length + 8 + dataLen)
  out.set(moof, 0)
  out.set([...u32(8 + dataLen), 0x6d, 0x64, 0x61, 0x74], moof.length)
  let o = moof.length + 8
  for (const s of samples) {
    out.set(s.data, o)
    o += s.data.length
  }
  return out
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Encodes the live tail after `prefix`: frames [prefix.frames, run.frames), one fragment per
 * encoded frame, each passed to `write`.
 */
export async function streamTail(encoder, run, prefix, { write, yieldToNetwork, frameStep }) {
  let seq = prefix.nextSeq
  return encodeFrames(encoder, run, {
    from: prefix.frames,
    yieldToNetwork,
    frameStep,
    // The tail is decoded with the prefix's SPS/PPS, so the encoder must produce identical ones.
    onOpen: (avcC) => {
      if (!sameBytes(avcC, prefix.avcC)) throw new Error('live encoder parameters differ from the prefix (rebuild prefixes after changing the encoder)')
    },
    onSample: (s) => write(fragment({ ...prefix, fps: run.fps }, seq++, [s])),
  })
}
