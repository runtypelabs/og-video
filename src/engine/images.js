// Image params: fetched before a render takes the engine, bounded in size and count, and cached
// per isolate twice over: the encoded bytes by URL, and each decoded, fitted sprite by URL and
// box (a render runs setup twice, for the prefix and the tail, and repeat renders reuse them).
//
// A fetch that fails leaves the image missing: ctx.image() returns null, the scene draws without
// it, and the render reports it so the caller does not cache a video with a hole in it.

/** A byte-budgeted LRU map. */
export class Lru {
  constructor(maxBytes, size = (v) => v.byteLength ?? v.px?.byteLength ?? 0) {
    this.max = maxBytes
    this.size = size
    this.bytes = 0
    this.map = new Map()
  }
  get(key) {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key, value) {
    const n = this.size(value)
    if (n > this.max) return
    if (this.map.has(key)) this.bytes -= this.size(this.map.get(key))
    this.map.delete(key)
    this.map.set(key, value)
    this.bytes += n
    for (const [k, v] of this.map) {
      if (this.bytes <= this.max) break
      this.map.delete(k)
      this.bytes -= this.size(v)
    }
  }
}

function fromDataUri(uri) {
  const b64 = uri.slice(uri.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Reads a response body, failing as soon as it passes `max` bytes. */
async function readCapped(res, max) {
  const declared = Number(res.headers.get('content-length'))
  if (declared > max) throw new Error(`image larger than ${max} bytes`)
  const reader = res.body.getReader()
  const parts = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) {
      await reader.cancel().catch(() => {})
      throw new Error(`image larger than ${max} bytes`)
    }
    parts.push(value)
  }
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

/**
 * @typedef {{
 *   fetch?: (url: string) => Promise<Response | Uint8Array | ArrayBuffer>,
 *   allow?: (url: URL) => boolean,
 *   maxBytes?: number, maxImages?: number, timeout?: number, cacheBytes?: number,
 * }} ImageLoaderOptions
 */

/** @param {ImageLoaderOptions} [options] */
export function createImageLoader(options = {}) {
  const {
    allow = () => true,
    maxBytes = 5 << 20,
    maxImages = 24,
    timeout = 8000,
    cacheBytes = 16 << 20,
  } = options
  const fetcher =
    options.fetch ??
    ((url) =>
      fetch(url, {
        headers: { accept: 'image/webp,image/png,image/jpeg;q=0.9' },
        signal: AbortSignal.timeout(timeout),
        // Workers: keep fetched images in the zone's cache for a day. Ignored elsewhere.
        cf: { cacheTtl: 86400, cacheEverything: true },
      }))
  const bytes = new Lru(cacheBytes)
  const decoded = new Lru(cacheBytes)
  const inflight = new Map()

  async function one(url) {
    const hit = bytes.get(url)
    if (hit) return hit
    if (url.startsWith('data:')) {
      const b = fromDataUri(url)
      if (b.byteLength > maxBytes) throw new Error(`image larger than ${maxBytes} bytes`)
      return b
    }
    if (!allow(new URL(url))) throw new Error('image host not allowed')
    let p = inflight.get(url)
    if (!p) {
      p = (async () => {
        const res = await fetcher(url)
        let b
        if (res instanceof Uint8Array) b = res
        else if (res instanceof ArrayBuffer) b = new Uint8Array(res)
        else {
          if (!res.ok) throw new Error(`image fetch failed: ${res.status}`)
          b = await readCapped(res, maxBytes)
        }
        if (b.byteLength > maxBytes) throw new Error(`image larger than ${maxBytes} bytes`)
        bytes.set(url, b)
        return b
      })()
      inflight.set(url, p)
      p.finally(() => inflight.delete(url)).catch(() => {})
    }
    return p
  }

  return {
    decoded,
    /**
     * Fetches `urls` (deduplicated, at most maxImages; the rest count as missing).
     * @returns {Promise<{ images: Map<string, Uint8Array | null>, missing: string[] }>}
     */
    async load(urls) {
      const unique = [...new Set(urls.filter(Boolean))]
      const images = new Map()
      const missing = []
      await Promise.all(
        unique.map(async (url, i) => {
          if (i >= maxImages) {
            images.set(url, null)
            return
          }
          try {
            images.set(url, await one(url))
          } catch {
            images.set(url, null)
          }
        }),
      )
      for (const url of unique) if (!images.get(url)) missing.push(url)
      return { images, missing }
    },
  }
}
