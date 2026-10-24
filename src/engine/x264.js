// x264 (wasm32-wasi reactor) glue. Takes an already compiled WebAssembly.Module so it works in
// Workers, where wasm must be imported as a module rather than compiled from bytes.

const ENOSYS = 52
const EBADF = 8

export function wasiStubs(getMemory) {
  return {
    // stdout/stderr writes are swallowed but reported as fully written.
    fd_write(fd, iovs, iovsLen, nwritten) {
      const view = new DataView(getMemory().buffer)
      let total = 0
      for (let i = 0; i < iovsLen; i++) total += view.getUint32(iovs + i * 8 + 4, true)
      view.setUint32(nwritten, total, true)
      return 0
    },
    fd_close: () => 0,
    fd_fdstat_get: () => EBADF,
    fd_fdstat_set_flags: () => ENOSYS,
    fd_filestat_get: () => EBADF,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_read: () => EBADF,
    fd_seek: () => EBADF,
    path_open: () => ENOSYS,
    path_rename: () => ENOSYS,
    proc_exit(code) {
      throw new Error(`x264 wasm exited with ${code}`)
    },
  }
}

export async function createEncoder(module) {
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

  const bytes = (ptr, len) => new Uint8Array(memory.buffer, ptr, len).slice()
  const chunk = (len) => ({
    data: bytes(x.enc_out_ptr(), len),
    key: x.enc_out_key() !== 0,
    pts: x.enc_out_pts(),
    dts: x.enc_out_dts(),
  })

  return {
    open(w, h, fps, params = '', { vfr = false } = {}) {
      x.enc_set_vfr?.(vfr ? 1 : 0)
      const enc = new TextEncoder().encode(`${params}\0`)
      const ptr = x.wmalloc(enc.length)
      new Uint8Array(memory.buffer, ptr, enc.length).set(enc)
      const rc = x.enc_open(w, h, fps, ptr)
      x.wfree(ptr)
      if (rc !== 0) throw new Error(`enc_open failed: ${rc}`)
      width = w
      height = h
      open = true
    },
    /** @param {Uint8Array | Uint8ClampedArray} rgba w*h*4 */
    encode(rgba, pts) {
      if (!open) throw new Error('encoder not open')
      if (rgba.length !== width * height * 4) throw new Error('bad frame size')
      new Uint8Array(memory.buffer, x.enc_input_ptr(), rgba.length).set(rgba)
      const len = x.enc_encode(BigInt(pts))
      if (len < 0) throw new Error(`enc_encode failed: ${len}`)
      return len > 0 ? chunk(len) : null
    },
    /**
     * I420, tightly packed (Y, then U, then V). `key` forces an IDR frame. `mbInfo` (one byte per
     * macroblock, 1 = unchanged since the previous frame) lets x264 skip analysing static blocks.
     */
    encodeYuv(yuv, pts, key = false, mbInfo) {
      if (!open) throw new Error('encoder not open')
      const mem = new Uint8Array(memory.buffer)
      let o = 0
      for (let p = 0; p < 3; p++) {
        const w = p ? width >> 1 : width
        const h = p ? height >> 1 : height
        const dst = x.enc_plane(p)
        const stride = x.enc_stride(p)
        if (stride === w) mem.set(yuv.subarray(o, o + w * h), dst)
        else for (let r = 0; r < h; r++) mem.set(yuv.subarray(o + r * w, o + r * w + w), dst + r * stride)
        o += w * h
      }
      const info = x.enc_mb_info?.()
      if (info) {
        if (mbInfo) mem.set(mbInfo, info)
        else mem.fill(0, info, info + ((width + 15) >> 4) * ((height + 15) >> 4))
      }
      const len = x.enc_encode_yuv(BigInt(pts), key ? 1 : 0)
      if (len < 0) throw new Error(`enc_encode_yuv failed: ${len}`)
      return len > 0 ? chunk(len) : null
    },
    flush() {
      const out = []
      for (;;) {
        const len = x.enc_flush()
        if (len < 0) throw new Error(`enc_flush failed: ${len}`)
        if (len === 0) return out
        out.push(chunk(len))
      }
    },
    avcC() {
      const len = x.enc_headers()
      if (len < 0) throw new Error(`enc_headers failed: ${len}`)
      return bytes(x.enc_out_ptr(), len)
    },
    /** Bytes of wasm memory this instance holds (it never shrinks). */
    memoryBytes: () => memory.buffer.byteLength,
    close() {
      if (open) x.enc_close()
      open = false
    },
  }
}
