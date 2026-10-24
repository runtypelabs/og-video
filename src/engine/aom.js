// libaom (AV1 realtime encoder, wasm32-wasi reactor) glue. Like x264.js, it takes an already
// compiled WebAssembly.Module so it works in Workers.
import { wasiStubs } from './x264.js'

export async function createAv1Encoder(module) {
  let memory
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasiStubs(() => memory),
  })
  const x = instance.exports
  memory = x.memory
  x._initialize?.()

  let width = 0
  let height = 0
  let open = false
  const chunk = (len) => ({
    data: new Uint8Array(memory.buffer, x.enc_out_ptr(), len).slice(),
    key: x.enc_out_key() !== 0,
    pts: x.enc_out_pts(),
  })

  return {
    /**
     * `speed` is libaom's realtime cpu-used (7-12), `cq` its constant-quality level (0-63, lower
     * is better), `screen` turns on the screen-content tools (palette, intra block copy).
     */
    open(w, h, fps, { speed = 10, cq = 30, screen = true } = {}) {
      const rc = x.enc_open(w, h, fps, speed, cq, screen ? 1 : 0)
      if (rc !== 0) throw new Error(`aom enc_open failed: ${rc}`)
      width = w
      height = h
      open = true
    },
    /**
     * I420, tightly packed. `key` forces a key frame. `mbInfo` (one byte per 16x16 block, 1 =
     * unchanged since the previous encoded frame) becomes an active map: those blocks are skipped.
     */
    encodeYuv(yuv, pts, key = false, mbInfo) {
      if (!open) throw new Error('encoder not open')
      new Uint8Array(memory.buffer, x.enc_input_ptr(), (width * height * 3) / 2).set(yuv)
      if (mbInfo) new Uint8Array(memory.buffer, x.enc_mb_info(), mbInfo.length).set(mbInfo)
      const len = x.enc_encode(pts, 1, key ? 1 : 0, mbInfo ? 1 : 0)
      if (len < 0) throw new Error(`aom enc_encode failed: ${len}`)
      return len > 0 ? chunk(len) : null
    },
    flush() {
      const out = []
      for (;;) {
        const len = x.enc_flush()
        if (len < 0) throw new Error(`aom enc_flush failed: ${len}`)
        if (len === 0) return out
        out.push(chunk(len))
      }
    },
    /** The sequence header OBU. */
    sequenceHeader() {
      const len = x.enc_headers()
      if (len < 0) throw new Error(`aom enc_headers failed: ${len}`)
      return new Uint8Array(memory.buffer, x.enc_out_ptr(), len).slice()
    },
    memoryBytes: () => memory.buffer.byteLength,
    close() {
      if (open) x.enc_close()
      open = false
    },
  }
}
