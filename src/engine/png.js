// A minimal PNG encoder for poster frames (og:image). The IDAT is compressed with the runtime's
// zlib through CompressionStream, so it costs almost no JS time.

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  let c = 0xffffffff
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8)
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0)
  return out
}

/** RGB PNG of an opaque RGBA frame (read synchronously, so a view into wasm memory is fine). */
export async function encodePng(rgba, w, h) {
  const raw = new Uint8Array(h * (1 + w * 3))
  for (let y = 0, o = 0; y < h; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
      raw[o++] = rgba[i]
      raw[o++] = rgba[i + 1]
      raw[o++] = rgba[i + 2]
    }
  }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, w)
  v.setUint32(4, h)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((o, p) => (png.set(p, o), o + p.length), 0)
  return png
}
