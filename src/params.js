// Params on the wire: query strings, the packed `s=` form, canonical JSON, content ids and
// signatures. Runtime-neutral (Web Crypto and CompressionStream exist in Workers and Node 18+).

/** Query keys the library owns; everything else is offered to the scenario's schema. */
export const RESERVED = new Set(['s', 'sig'])

/** JSON with object keys sorted, so equal params always serialize to the same bytes. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

const b64url = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64url = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function through(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

/** Params as `s=`: canonical JSON, deflate-raw, base64url. About 3x shorter than encoded JSON. */
export async function pack(params) {
  return b64url(await through(new TextEncoder().encode(canonical(params)), new CompressionStream('deflate-raw')))
}

/** Reverses pack(). Bounded, since `s` comes from strangers' URLs. */
export async function unpack(s, maxBytes = 64 * 1024) {
  if (s.length > 16 * 1024) throw new Error('s is too long')
  const bytes = await through(unb64url(s), new DecompressionStream('deflate-raw'))
  if (bytes.length > maxBytes) throw new Error('s is too large')
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** sha256 of `text` as base64url, truncated to `chars` (22 chars = 132 bits). */
export async function hash(text, chars = 22) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return b64url(new Uint8Array(digest)).slice(0, chars)
}

/** The content id of a scenario's params: the same params always give the same id. */
export const contentId = (scenarioId, params) => hash(`${scenarioId}\n${canonical(params)}`)

const keys = new Map()
async function hmacKey(secret) {
  if (!keys.has(secret))
    keys.set(secret, crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']))
  return keys.get(secret)
}

/**
 * Signs a scenario's params (validated, so equal params sign equally however the URL spelled
 * them). 22 base64url characters of HMAC-SHA256.
 */
export async function sign(secret, scenarioId, params) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(`${scenarioId}\n${canonical(params)}`))
  return b64url(new Uint8Array(mac)).slice(0, 22)
}

export async function verify(secret, scenarioId, params, sig) {
  if (typeof sig !== 'string' || sig.length !== 22) return false
  const expected = await sign(secret, scenarioId, params)
  // Constant-time comparison.
  let diff = 0
  for (let i = 0; i < 22; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

/**
 * Raw (unvalidated) params from a URL: the unpacked `s=` value, then each non-reserved query key
 * on top. With one of our object schemas, keys it does not declare are ignored, so tracking
 * params (utm_source and friends) never reach the scene or the cache key.
 */
export async function rawParams(url, schema) {
  const q = url.searchParams
  const value = q.has('s') ? await unpack(q.get('s')) : {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('s must hold an object')
  const shape = schema?.shape
  for (const [k, v] of q) {
    if (RESERVED.has(k) || (shape && !(k in shape))) continue
    value[k] = v
  }
  return value
}
