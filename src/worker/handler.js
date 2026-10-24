// createHandler: a Worker that serves scenarios as streaming MP4s, posters and share pages,
// renders each distinct video once, and caches it.
//
//   GET  /:scenario.mp4?<params>          video (params inline; &sig= when signatures are on)
//   GET  /:scenario/:id.mp4               video from stored params (content id or name)
//   GET  /:scenario.png?…, /:scenario/:id.png     poster frame (og:image)
//   GET  /:scenario?…, /:scenario/:id     share page with og:video / og:image tags
//   GET  /:scenario.json?…, /:scenario/:id.json   resolved params, content id and URLs
//   POST /:scenario                       store params (JSON body) -> content id
//   PUT  /:scenario/:name                 store params under a name (bearer token)
//
// A request for a video goes: edge cache (Cache API, this location) -> R2 (global) -> render.
// A render streams: the scenario's prefix (pre-encoded opening, from memory, R2, or encoded now)
// is written first, then the live tail one fragment per frame. When the tail rendered every frame
// the whole file is stored, so the next request anywhere is a cache hit. Renders are
// deterministic, so a byte range of a fresh render matches the stored file exactly.
import ogfxModule from '../../wasm/ogfx.wasm'
import x264Module from '../../wasm/x264.wasm'
import interRegular from '../../fonts/Inter-Regular.ttf.bin'
import interSemiBold from '../../fonts/Inter-SemiBold.ttf.bin'
import { createEngine, ENGINE_VERSION, concat } from '../engine/engine.js'
import { readPrefix } from '../engine/encode.js'
import { validate, ParamError } from '../schema.js'
import { rawParams, contentId, verify, sign, hash, canonical, pack } from '../params.js'
import { sharePage } from './page.js'
import { isName } from './store.js'

let engine = null
const yieldToNetwork = () => new Promise((r) => setTimeout(r, 0))

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-length, content-range, server-timing, x-sogv-cache, x-sogv-id, x-sogv-duration',
}

/**
 * @param {import('../../types/worker.js').HandlerOptions} options
 * @returns {{ fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> }}
 */
export function createHandler(options) {
  const scenarios = new Map(options.scenarios.map((s) => [s.id, s]))
  const o = {
    siteName: undefined,
    signatures: options.secret ? 'required' : 'off',
    writes: 'token',
    edgeCache: true,
    cacheControl: 'public, max-age=3600',
    prefixMemory: 32,
    tailsAtFullRate: 3,
    ...options,
  }
  if (o.signatures === 'required' && !o.secret) throw new Error('signatures: "required" needs a secret binding name')
  const R2 = o.bucket
  const prefixes = new Map()

  const getEngine = () =>
    (engine ??= createEngine({
      modules: { ogfx: ogfxModule, x264: x264Module },
      fonts: { 'inter-regular': interRegular, 'inter-semibold': interSemiBold, ...o.fonts },
      tailsAtFullRate: o.tailsAtFullRate,
    }))

  const secretOf = (env) => {
    const s = o.secret && env[o.secret]
    if (o.secret && !s) throw new HttpError(500, `missing secret ${o.secret}`)
    return s
  }

  // ---------------------------------------------------------------- params

  async function resolve(request, env, ctx, scenario, id) {
    const url = new URL(request.url)
    if (id) {
      if (!o.store) throw new HttpError(404, 'stored params are not enabled')
      const stored = await o.store.get(env, ctx, scenario.id, id, { mutable: isName(id) })
      if (!stored) throw new HttpError(404, `no ${scenario.id} with id ${id}`)
      return { params: stored.params, cid: stored.cid, source: isName(id) ? 'named' : 'stored', id }
    }
    const params = await validate(scenario.params, await rawParams(url, scenario.params).catch((e) => {
      throw new ParamError(e.message)
    }))
    if (o.signatures === 'required' && !(await verify(secretOf(env), scenario.id, params, url.searchParams.get('sig'))))
      throw new HttpError(403, 'missing or invalid sig (see videoUrl() to sign params)')
    return { params, cid: await contentId(scenario.id, params), source: 'inline' }
  }

  const renderKey = (scenario, cid) => `${ENGINE_VERSION}/${scenario.id}/${scenario.version}/${cid}`
  const cacheUrl = (key, ext) => `https://streaming-og-video.internal/${key}.${ext}`

  async function edgeLookup(key, ext) {
    if (!o.edgeCache) return null
    const hit = await caches.default.match(cacheUrl(key, ext))
    return hit && { cache: 'edge', bytes: () => hit.arrayBuffer().then((b) => new Uint8Array(b)), body: hit.body, size: Number(hit.headers.get('content-length')) }
  }

  async function r2Lookup(env, key, ext) {
    if (!R2) return null
    const obj = await env[R2].get(`renders/${key}.${ext}`)
    return obj && { cache: 'r2', obj, bytes: () => obj.arrayBuffer().then((b) => new Uint8Array(b)), body: obj.body, size: obj.size }
  }

  const lookup = async (env, key, ext) => (await edgeLookup(key, ext)) ?? (await r2Lookup(env, key, ext))

  const putEdge = (key, ext, body, type) =>
    caches.default.put(cacheUrl(key, ext), new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' } }))

  async function store(env, key, ext, bytes, type) {
    await Promise.all([
      R2 && env[R2].put(`renders/${key}.${ext}`, bytes, { httpMetadata: { contentType: type } }),
      o.edgeCache && putEdge(key, ext, bytes, type),
    ])
  }

  async function limited(request, env) {
    if (!o.rateLimit) return false
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const { success } = await env[o.rateLimit].limit({ key: ip })
    return !success
  }

  /** The scenario's prefix for these params: memory, then R2, then encoded now (and stored). */
  function getPrefix(env, ctx, scenario, params) {
    const pkey = scenario.prefix.key(params)
    const id = `${ENGINE_VERSION}/${scenario.id}/${scenario.version}/${pkey}`
    let entry = prefixes.get(id)
    if (entry) {
      prefixes.delete(id)
      prefixes.set(id, entry) // least recently used goes first
      return entry.then((prefix) => ({ ...prefix, source: 'memory' }))
    }
    entry = (async () => {
      const r2Key = `prefixes/${ENGINE_VERSION}/${scenario.id}/${scenario.version}/${await hash(pkey)}.mp4`
      const obj = R2 && (await env[R2].get(r2Key))
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer())
        return { bytes, frames: scenario.prefix.frames, ...readPrefix(bytes), source: 'r2' }
      }
      const built = await getEngine().prefix(scenario, params)
      if (R2) ctx.waitUntil(env[R2].put(r2Key, built.bytes, { httpMetadata: { contentType: 'video/mp4' } }))
      return { ...built, source: 'built' }
    })()
    entry.catch(() => prefixes.delete(id))
    prefixes.set(id, entry)
    while (prefixes.size > o.prefixMemory) prefixes.delete(prefixes.keys().next().value)
    return entry
  }

  // ---------------------------------------------------------------- responses

  function mediaHeaders(scenario, type, input, cache, extra = {}) {
    return {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': cache === 'miss' ? 'no-store' : o.cacheControl,
      'content-disposition': `inline; filename="${scenario.id}.${type === 'video/mp4' ? 'mp4' : 'png'}"`,
      'x-sogv-cache': cache,
      'x-sogv-id': input.cid,
      'x-sogv-duration': String(scenario.video.frames / scenario.video.fps),
      ...CORS,
      ...extra,
    }
  }

  /** A single `bytes=` range of `size` bytes, or null for the whole file (no header, `bytes=0-`). */
  function parseRange(header, size) {
    const m = header?.match(/^bytes=(\d*)-(\d*)$/)
    if (!m || (m[1] === '' && m[2] === '') || (m[1] === '0' && m[2] === '')) return null
    let start
    let end
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    } else {
      start = Number(m[1])
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    }
    return start > end || start >= size ? 'unsatisfiable' : { start, end }
  }

  function sliceResponse(bytes, request, headers) {
    const range = parseRange(request.headers.get('range'), bytes.length)
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}` } })
    const head = request.method === 'HEAD'
    if (!range) return new Response(head ? null : bytes, { headers: { ...headers, 'content-length': String(bytes.length) } })
    const part = bytes.subarray(range.start, range.end + 1)
    return new Response(head ? null : part, {
      status: 206,
      headers: { ...headers, 'content-length': String(part.length), 'content-range': `bytes ${range.start}-${range.end}/${bytes.length}` },
    })
  }

  async function video(request, env, ctx, scenario, input, ev) {
    const key = renderKey(scenario, input.cid)
    const wantsRange = parseRange(request.headers.get('range'), Infinity) !== null || request.method === 'HEAD'
    // Server-Timing: Date.now() only advances across I/O in Workers, which is what these measure.
    const timing = []
    const timed = async (name, promise) => {
      const t0 = Date.now()
      try {
        return await promise
      } finally {
        timing.push(`${name};dur=${Date.now() - t0}`)
      }
    }
    let hit = await timed('edge', edgeLookup(key, 'mp4'))
    let prefixPromise = null
    if (!hit) {
      // On an R2 miss the prefix is needed next, so fetch both at once.
      prefixPromise = getPrefix(env, ctx, scenario, input.params)
      prefixPromise.catch(() => {})
      hit = await timed('r2', r2Lookup(env, key, 'mp4'))
    }
    if (hit) {
      ev.cache = hit.cache
      const headers = mediaHeaders(scenario, 'video/mp4', input, hit.cache, { 'server-timing': timing.join(', ') })
      if (wantsRange) return sliceResponse(await hit.bytes(), request, headers)
      ev.bytes = hit.size
      if (hit.cache === 'r2' && o.edgeCache) {
        const [a, b] = hit.body.tee()
        ctx.waitUntil(putEdge(key, 'mp4', b, 'video/mp4').catch(() => {}))
        return new Response(a, { headers: { ...headers, 'content-length': String(hit.size) } })
      }
      return new Response(hit.body, { headers: { ...headers, 'content-length': String(hit.size) } })
    }
    ev.cache = 'miss'
    if (await timed('limit', limited(request, env))) throw new HttpError(429, 'too many renders from this address; try again in a minute')
    const eng = getEngine()
    const prefix = await timed('prefix', prefixPromise)
    ev.prefix = prefix.source
    const headers = mediaHeaders(scenario, 'video/mp4', input, 'miss', { 'server-timing': [...timing, `prefix-source;desc=${prefix.source}`].join(', ') })

    if (wantsRange) {
      // Safari probes with `bytes=0-1`, needs the total size, then fetches ranges: render the
      // whole file (every frame, so the bytes match any other render), store it, slice it.
      const bytes = await eng.file(scenario, input.params, prefix)
      ctx.waitUntil(store(env, key, 'mp4', bytes, 'video/mp4').catch(() => {}))
      ev.bytes = bytes.length
      return sliceResponse(bytes, request, headers)
    }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const parts = [prefix.bytes]
    // Before any further await: the opening is on the wire while the tail waits its turn.
    writer.write(prefix.bytes)
    let degraded = false
    ev.queued = eng.queued + 1
    // Yield once first: the tail's setup (instantiating the engine, parsing fonts, rasterizing) is
    // synchronous CPU, and the runtime only flushes the headers and the prefix when it gets the
    // event loop back.
    const done = yieldToNetwork()
      .then(() => eng.tail(scenario, input.params, prefix, {
        write: (b) => {
          parts.push(b)
          writer.write(b)
        },
        frameStep: () => {
          const step = eng.frameStep()
          if (step > 1) degraded = true
          return step
        },
        yieldToNetwork,
      }))
      .then(async (r) => {
        await writer.close()
        ev.frames = r.encoded
        ev.degraded = degraded
        const bytes = concat(parts)
        ev.bytes = bytes.length
        // A degraded render skipped frames; never store it, the next request renders in full.
        if (!degraded) await store(env, key, 'mp4', bytes, 'video/mp4')
      })
      .catch(async (error) => {
        ev.error = String(error?.message ?? error)
        await writer.abort(error).catch(() => {})
      })
      .finally(() => emit(env, ctx, ev, request))
    ev.deferred = true
    ctx.waitUntil(done)
    return new Response(readable, { headers })
  }

  async function poster(request, env, ctx, scenario, input, ev) {
    const key = renderKey(scenario, input.cid)
    const hit = await lookup(env, key, 'png')
    ev.cache = hit ? hit.cache : 'miss'
    const headers = mediaHeaders(scenario, 'image/png', input, ev.cache)
    if (hit) return sliceResponse(await hit.bytes(), request, headers)
    if (await limited(request, env)) throw new HttpError(429, 'too many renders from this address; try again in a minute')
    const png = await getEngine().poster(scenario, input.params)
    ctx.waitUntil(store(env, key, 'png', png, 'image/png').catch(() => {}))
    ev.bytes = png.length
    return sliceResponse(png, request, headers)
  }

  async function links(request, env, scenario, input) {
    const origin = new URL(request.url).origin
    const base = `${origin}/${scenario.id}`
    if (input.id) return { page: `${base}/${input.id}`, video: `${base}/${input.id}.mp4`, image: `${base}/${input.id}.png` }
    const search = new URL(request.url).search
    return { page: `${base}${search}`, video: `${base}.mp4${search}`, image: `${base}.png${search}` }
  }

  async function page(request, env, ctx, scenario, input) {
    const l = await links(request, env, scenario, input)
    const meta = scenario.meta(input.params) ?? {}
    const html = (o.page ?? sharePage)({ ...l, ...meta, width: scenario.video.width, height: scenario.video.height, siteName: o.siteName, scenario, params: input.params })
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': o.cacheControl, ...CORS } })
  }

  async function write(request, env, ctx, scenario, name, ev) {
    if (!o.store) throw new HttpError(404, 'stored params are not enabled')
    const auth = request.headers.get('authorization')
    const tokenOk = o.secret && auth === `Bearer ${secretOf(env)}`
    if (name || o.writes !== 'public') {
      if (!tokenOk) throw new HttpError(401, 'a bearer token is required')
    } else if (!tokenOk && (await limited(request, env))) throw new HttpError(429, 'too many writes from this address')
    const text = await request.text()
    if (text.length > 64 * 1024) throw new HttpError(413, 'params are limited to 64 KB')
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new ParamError('the body must be JSON params')
    }
    const params = await validate(scenario.params, body)
    const cid = await contentId(scenario.id, params)
    if (name && !isName(name)) throw new HttpError(400, 'a name is 1-64 of a-z 0-9 . _ - and not 22 characters long')
    const id = name ?? cid
    await o.store.put(env, scenario.id, id, { params, cid })
    ev.bytes = text.length
    const input = { params, cid, id, source: name ? 'named' : 'stored' }
    if (new URL(request.url).searchParams.has('warm')) ctx.waitUntil(warm(env, ctx, scenario, input).catch(() => {}))
    return json({ id, cid, ...(await links(request, env, scenario, input)) }, name ? 200 : 201)
  }

  /** Renders and stores a video (and its poster) ahead of the first viewer. */
  async function warm(env, ctx, scenario, input) {
    const key = renderKey(scenario, input.cid)
    if (await lookup(env, key, 'mp4')) return
    const eng = getEngine()
    const prefix = await getPrefix(env, ctx, scenario, input.params)
    await store(env, key, 'mp4', await eng.file(scenario, input.params, prefix), 'video/mp4')
    await store(env, key, 'png', await eng.poster(scenario, input.params), 'image/png')
  }

  function emit(env, ctx, ev, request) {
    if (!o.onEvent) return
    ev.ms = Date.now() - ev.start
    try {
      const r = o.onEvent(ev, { request, env, ctx })
      if (r && typeof r.then === 'function') ctx.waitUntil(r.catch(() => {}))
    } catch {}
  }

  const json = (value, status = 200) =>
    new Response(JSON.stringify(value, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } })

  // ---------------------------------------------------------------- routing

  const ROUTE = /^\/([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_-][A-Za-z0-9._-]*?))?(?:\.(mp4|png|json))?$/

  async function fetch(request, env, ctx) {
    const url = new URL(request.url)
    const method = request.method
    if (method === 'OPTIONS')
      return new Response(null, { headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, range' } })
    if (url.pathname === '/' && o.home) return o.home(request, env, ctx)
    if (url.pathname === '/')
      return json({ scenarios: [...scenarios.keys()].map((id) => ({ id, video: `${url.origin}/${id}.mp4`, page: `${url.origin}/${id}` })) })

    const m = url.pathname.match(ROUTE)
    const scenario = m && scenarios.get(m[1])
    if (!scenario) return o.notFound ? o.notFound(request, env, ctx) : json({ error: 'not found' }, 404)
    const [, , id, ext] = m
    const ev = { type: ext === 'mp4' ? 'video' : ext === 'png' ? 'poster' : ext === 'json' ? 'json' : 'page', scenario: scenario.id, method, status: 200, start: Date.now(), range: request.headers.has('range') }
    try {
      let res
      if (method === 'POST' && !id && !ext) {
        ev.type = 'write'
        res = await write(request, env, ctx, scenario, null, ev)
      } else if (method === 'PUT' && id && !ext) {
        ev.type = 'write'
        res = await write(request, env, ctx, scenario, id, ev)
      } else if (method === 'GET' || method === 'HEAD') {
        const input = await resolve(request, env, ctx, scenario, id)
        ev.source = input.source
        ev.cid = input.cid
        if (ext === 'mp4') res = await video(request, env, ctx, scenario, input, ev)
        else if (ext === 'png') res = await poster(request, env, ctx, scenario, input, ev)
        else if (ext === 'json') {
          const secret = o.signatures === 'required' ? secretOf(env) : null
          res = json({
            scenario: scenario.id,
            version: scenario.version,
            cid: input.cid,
            params: input.params,
            canonical: canonical(input.params),
            ...(await links(request, env, scenario, input)),
            packed: input.id ? undefined : `${url.origin}/${scenario.id}.mp4?s=${await pack(input.params)}${secret ? `&sig=${await sign(secret, scenario.id, input.params)}` : ''}`,
          })
        } else res = await page(request, env, ctx, scenario, input)
      } else res = json({ error: 'method not allowed' }, 405)
      ev.status = res.status
      return res
    } catch (error) {
      const status = error instanceof ParamError ? 400 : error instanceof HttpError ? error.status : 500
      ev.status = status
      ev.error = String(error?.message ?? error)
      if (status === 500) console.error(error)
      return json({ error: ev.error }, status)
    } finally {
      if (!ev.deferred) emit(env, ctx, ev, request)
    }
  }

  return { fetch }
}

/**
 * The URL of a scenario's video for `params`: plain query parameters when they are short and
 * flat, the packed `s=` form otherwise, signed when a secret is given.
 * @returns {Promise<{ video: string, image: string, page: string }>}
 */
export async function videoUrl(origin, scenario, params, { secret } = {}) {
  const valid = await validate(scenario.params, params)
  const flat = Object.values(valid).every((v) => typeof v !== 'object')
  const q = new URLSearchParams()
  if (flat) for (const [k, v] of Object.entries(valid)) q.set(k, String(v))
  if (!flat || q.toString().length > 600) {
    for (const k of [...q.keys()]) q.delete(k)
    q.set('s', await pack(valid))
  }
  if (secret) q.set('sig', await sign(secret, scenario.id, valid))
  const base = `${origin.replace(/\/$/, '')}/${scenario.id}`
  return { video: `${base}.mp4?${q}`, image: `${base}.png?${q}`, page: `${base}?${q}` }
}
