// createHandler: a Worker that serves scenarios as streaming MP4s, posters and share pages,
// renders each distinct video once, and caches it.
//
//   GET  /:scenario.mp4?<params>          video (params inline; &sig= when signatures are on)
//   GET  /:scenario/:id.mp4               video from stored params (content id or name)
//   GET  /:scenario.av1.mp4?…, /:scenario/:id.av1.mp4   AV1 variant (with the `av1` option)
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
//
// The AV1 variant is not streamed: it renders whole (several times slower than H.264), then is
// cached under its own keys. On a miss it redirects to the H.264 video and renders in the
// background, so nobody waits for it; `Prefer: wait` renders it in the request instead. Link
// unfurlers asking for it are redirected to H.264 too. The .mp4 URL is always H.264.
//
// With `basePath` (e.g. '/v1') every route above lives under it, and links use it.
// `legacyPaths` keeps serving the unprefixed routes too.
import ogfxModule from '../../wasm/ogfx.wasm'
import x264Module from '../../wasm/x264.wasm'
import aomModule from '../../wasm/aom.wasm'
import interRegular from '../../fonts/Inter-Regular.ttf.bin'
import interSemiBold from '../../fonts/Inter-SemiBold.ttf.bin'
import { createEngine, ENGINE_VERSION, concat } from '../engine/engine.js'
import { readPrefix } from '../engine/encode.js'
import { AV1_VERSION, AV1_DEFAULTS, av1Codec } from '../engine/av1.js'
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
  'access-control-expose-headers': 'content-length, content-range, server-timing, x-sogv-cache, x-sogv-id, x-sogv-duration, x-sogv-codec, x-sogv-fps, x-sogv-render-ms',
}

/** Link unfurlers and crawlers: they read og:video (always H.264) and must never get AV1. */
export const CRAWLER = /bot\b|crawler|spider|facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|discordbot|whatsapp|telegrambot|linkedinbot|skypeuripreview|embedly|redditbot|pinterest|vkshare|iframely|bluesky|mastodon/i

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
  const basePath = normalizeBase(o.basePath)
  const av1 = o.av1 ? { ...AV1_DEFAULTS, miss: 'fallback', ...(o.av1 === true ? {} : o.av1) } : null
  /** The AV1 frame rate for a scenario: `av1.fps` may be a number or a function of the scenario. */
  const av1Fps = (scenario) => {
    const fps = typeof av1.fps === 'function' ? av1.fps(scenario) : av1.fps
    if (![24, 25, 30, 48, 50, 60, 90, 120].includes(fps)) throw new Error(`av1.fps must be one of 24, 25, 30, 48, 50, 60, 90, 120 (got ${fps} for ${scenario.id})`)
    return fps
  }
  if (av1) for (const s of scenarios.values()) av1Fps(s)
  /** Background AV1 renders in flight in this isolate, by key. */
  const av1Pending = new Map()
  const R2 = o.bucket
  const prefixes = new Map()

  const getEngine = () =>
    (engine ??= createEngine({
      modules: { ogfx: ogfxModule, x264: x264Module, aom: aomModule },
      fonts: { 'inter-regular': interRegular, 'inter-semibold': interSemiBold, ...o.fonts },
      tailsAtFullRate: o.tailsAtFullRate,
      images: o.images,
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
  // AV1 renders live under their own top-level prefix, keyed by every setting that changes bytes.
  const av1Key = (scenario, cid) =>
    `av1/${AV1_VERSION}/${av1Fps(scenario)}-${av1.speed}-${av1.cq}${av1.screen ? 's' : ''}/${ENGINE_VERSION}/${scenario.id}/${scenario.version}/${cid}`
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

  /**
   * The scenario's prefix for these params: memory, then R2, then encoded now (and stored, unless
   * an image it needs could not be fetched).
   */
  function getPrefix(env, ctx, scenario, params, assets) {
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
      const a = await assets
      const built = await getEngine().prefix(scenario, params, { assets: a })
      if (a.missing.length) {
        prefixes.delete(id)
        return { ...built, source: 'built' }
      }
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
    let assets = null
    if (!hit) {
      // On an R2 miss the prefix (and any images) are needed next, so fetch them all at once.
      assets = getEngine().assets(scenario, input.params)
      assets.catch(() => {})
      prefixPromise = getPrefix(env, ctx, scenario, input.params, assets)
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
    const a = await assets
    // A render missing an image is served but never stored; the next request tries again.
    const complete = a.missing.length === 0
    if (!complete) ev.missingImages = a.missing.length
    const headers = mediaHeaders(scenario, 'video/mp4', input, 'miss', { 'server-timing': [...timing, `prefix-source;desc=${prefix.source}`].join(', ') })

    if (wantsRange) {
      // Safari probes with `bytes=0-1`, needs the total size, then fetches ranges: render the
      // whole file (every frame, so the bytes match any other render), store it, slice it.
      const t0 = Date.now()
      const bytes = await eng.file(scenario, input.params, prefix, { assets: a })
      await yieldToNetwork() // so Date.now() covers the render
      if (complete) ctx.waitUntil(store(env, key, 'mp4', bytes, 'video/mp4').catch(() => {}))
      ev.bytes = bytes.length
      return sliceResponse(bytes, request, { ...headers, 'x-sogv-render-ms': String(Date.now() - t0) })
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
        assets: a,
      }))
      .then(async (r) => {
        await writer.close()
        ev.frames = r.encoded
        ev.degraded = degraded
        const bytes = concat(parts)
        ev.bytes = bytes.length
        // A degraded render skipped frames; never store it, the next request renders in full.
        if (!degraded && complete) await store(env, key, 'mp4', bytes, 'video/mp4')
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

  /** Renders the AV1 file and stores it with its stats (R2 metadata, edge headers). */
  async function renderAv1(env, scenario, input, key, a) {
    a ??= await getEngine().assets(scenario, input.params)
    const t0 = Date.now()
    const r = await getEngine().av1(scenario, input.params, { ...av1, fps: av1Fps(scenario), assets: a })
    // Date.now() only advances across I/O in Workers: yield once so it covers the render.
    await yieldToNetwork()
    const meta = { codec: r.codec, fps: String(r.fps), encoded: String(r.encoded), renderMs: String(Date.now() - t0) }
    if (!a.missing.length)
      await Promise.all([
        R2 && env[R2].put(`renders/${key}.mp4`, r.bytes, { httpMetadata: { contentType: 'video/mp4' }, customMetadata: meta }),
        o.edgeCache && caches.default.put(cacheUrl(key, 'mp4'), new Response(r.bytes, { headers: { 'content-type': 'video/mp4', 'cache-control': 'public, max-age=31536000, immutable', ...av1Headers(meta) } })),
      ]).catch(() => {})
    return { bytes: r.bytes, meta }
  }

  const av1Headers = (meta) => ({
    'x-sogv-codec': meta.codec,
    'x-sogv-fps': meta.fps,
    ...(meta.renderMs ? { 'x-sogv-render-ms': meta.renderMs } : {}),
  })

  async function videoAv1(request, env, ctx, scenario, input, ev) {
    ev.codec = 'av1'
    const fallback = () => {
      const url = new URL(request.url)
      url.pathname = url.pathname.replace(/\.av1\.mp4$/, '.mp4')
      return new Response(null, { status: 307, headers: { location: url.toString(), 'cache-control': 'no-store', 'x-sogv-codec': 'h264', ...CORS } })
    }
    // Unfurlers never get AV1, whatever URL they were handed.
    if (CRAWLER.test(request.headers.get('user-agent') ?? '')) {
      ev.cache = 'crawler'
      return fallback()
    }
    const key = av1Key(scenario, input.cid)
    const headers = (cache, meta) => mediaHeaders(scenario, 'video/mp4', input, cache, { ...av1Headers(meta), vary: 'prefer' })
    const edge = o.edgeCache && (await caches.default.match(cacheUrl(key, 'mp4')))
    if (edge) {
      ev.cache = 'edge'
      const meta = { codec: edge.headers.get('x-sogv-codec'), fps: edge.headers.get('x-sogv-fps'), renderMs: edge.headers.get('x-sogv-render-ms') }
      return sliceResponse(new Uint8Array(await edge.arrayBuffer()), request, headers('edge', meta))
    }
    const obj = R2 && (await env[R2].get(`renders/${key}.mp4`))
    if (obj) {
      ev.cache = 'r2'
      const bytes = new Uint8Array(await obj.arrayBuffer())
      const meta = obj.customMetadata ?? {}
      if (o.edgeCache)
        ctx.waitUntil(caches.default.put(cacheUrl(key, 'mp4'), new Response(bytes, { headers: { 'content-type': 'video/mp4', 'cache-control': 'public, max-age=31536000, immutable', ...av1Headers(meta) } })).catch(() => {}))
      return sliceResponse(bytes, request, headers('r2', meta))
    }
    ev.cache = 'miss'
    const wait = av1.miss === 'render' || /\bwait\b/i.test(request.headers.get('prefer') ?? '')
    if (!wait) {
      // Play H.264 now; render AV1 for the next viewer (once per key per isolate).
      if (!av1Pending.has(key) && !(await limited(request, env))) {
        const job = renderAv1(env, scenario, input, key).finally(() => av1Pending.delete(key))
        av1Pending.set(key, job)
        ctx.waitUntil(job.catch((error) => console.error(error)))
        ev.av1 = 'started'
      } else ev.av1 = av1Pending.has(key) ? 'pending' : 'limited'
      return fallback()
    }
    if (await limited(request, env)) throw new HttpError(429, 'too many renders from this address; try again in a minute')
    const { bytes, meta } = await (av1Pending.get(key) ?? renderAv1(env, scenario, input, key))
    ev.bytes = bytes.length
    return sliceResponse(bytes, request, headers('miss', meta))
  }

  async function poster(request, env, ctx, scenario, input, ev) {
    const key = renderKey(scenario, input.cid)
    const hit = await lookup(env, key, 'png')
    ev.cache = hit ? hit.cache : 'miss'
    const headers = mediaHeaders(scenario, 'image/png', input, ev.cache)
    if (hit) return sliceResponse(await hit.bytes(), request, headers)
    if (await limited(request, env)) throw new HttpError(429, 'too many renders from this address; try again in a minute')
    const a = await getEngine().assets(scenario, input.params)
    const png = await getEngine().poster(scenario, input.params, undefined, { assets: a })
    if (!a.missing.length) ctx.waitUntil(store(env, key, 'png', png, 'image/png').catch(() => {}))
    ev.bytes = png.length
    return sliceResponse(png, request, headers)
  }

  async function links(request, env, scenario, input) {
    const origin = new URL(request.url).origin
    const base = `${origin}${basePath}/${scenario.id}`
    const at = input.id ? `${base}/${input.id}` : base
    const search = input.id ? '' : new URL(request.url).search
    const l = { page: `${at}${search}`, video: `${at}.mp4${search}`, image: `${at}.png${search}` }
    if (av1) l.av1 = `${at}.av1.mp4${search}`
    return l
  }

  async function page(request, env, ctx, scenario, input) {
    const l = await links(request, env, scenario, input)
    const meta = scenario.meta(input.params) ?? {}
    const v = scenario.video
    const html = (o.page ?? sharePage)({ ...l, ...meta, width: v.width, height: v.height, ...(av1 && { av1Codec: av1Codec(v.width, v.height, av1Fps(scenario)), av1Fps: av1Fps(scenario), fps: v.fps }), siteName: o.siteName, scenario, params: input.params })
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

  const ROUTE = /^\/([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_-][A-Za-z0-9._-]*?))?(?:\.(av1\.mp4|mp4|png|json))?$/

  async function fetch(request, env, ctx) {
    const url = new URL(request.url)
    const method = request.method
    if (method === 'OPTIONS')
      return new Response(null, { headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, range' } })
    if (url.pathname === '/' && o.home) return o.home(request, env, ctx)
    let path = url.pathname
    if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || '/'
    else if (basePath && !o.legacyPaths && path !== '/') path = null
    if (path === '/') {
      const root = `${url.origin}${basePath}`
      return json({ scenarios: [...scenarios.keys()].map((id) => ({ id, video: `${root}/${id}.mp4`, page: `${root}/${id}` })) })
    }

    const m = path?.match(ROUTE)
    const scenario = m && scenarios.get(m[1])
    if (!scenario) return o.notFound ? o.notFound(request, env, ctx) : json({ error: 'not found' }, 404)
    const [, , id, ext] = m
    if (ext === 'av1.mp4' && !av1) return o.notFound ? o.notFound(request, env, ctx) : json({ error: 'not found' }, 404)
    const ev = { type: ext === 'mp4' || ext === 'av1.mp4' ? 'video' : ext === 'png' ? 'poster' : ext === 'json' ? 'json' : 'page', scenario: scenario.id, method, status: 200, start: Date.now(), range: request.headers.has('range') }
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
        else if (ext === 'av1.mp4') res = await videoAv1(request, env, ctx, scenario, input, ev)
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
            packed: input.id ? undefined : `${url.origin}${basePath}/${scenario.id}.mp4?s=${await pack(input.params)}${secret ? `&sig=${await sign(secret, scenario.id, input.params)}` : ''}`,
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
 * `av1` is the AV1 variant's URL (served when the handler has the `av1` option).
 * @returns {Promise<{ video: string, image: string, page: string, av1: string }>}
 */
export async function videoUrl(origin, scenario, params, { secret, basePath } = {}) {
  const valid = await validate(scenario.params, params)
  const flat = Object.values(valid).every((v) => typeof v !== 'object')
  const q = new URLSearchParams()
  if (flat) for (const [k, v] of Object.entries(valid)) q.set(k, String(v))
  if (!flat || q.toString().length > 600) {
    for (const k of [...q.keys()]) q.delete(k)
    q.set('s', await pack(valid))
  }
  if (secret) q.set('sig', await sign(secret, scenario.id, valid))
  const base = `${origin.replace(/\/$/, '')}${normalizeBase(basePath)}/${scenario.id}`
  return { video: `${base}.mp4?${q}`, image: `${base}.png?${q}`, page: `${base}?${q}`, av1: `${base}.av1.mp4?${q}` }
}

/** '' or '/segment[/segment]' with no trailing slash. */
function normalizeBase(path) {
  if (!path || path === '/') return ''
  const p = `/${path.replace(/^\/+|\/+$/g, '')}`
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(p)) throw new Error(`basePath must look like '/v1', got ${path}`)
  return p
}
