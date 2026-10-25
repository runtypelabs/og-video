// The per-isolate render engine: one compositor + encoder pair, a FIFO queue in front of it, and
// the operations the runtimes build on (prefix, live tail, whole file, poster).
//
// One pair is about 38 MB of wasm memory, which never shrinks. Workers cap an isolate at 128 MB
// and often run concurrent requests in the same isolate, so renders take turns on a single pair
// instead of each instantiating their own. Workers also expose no clock that advances during
// compute, so queue depth is the load signal: with k renders queued or running, live tails render
// every ceil(k / tailsAtFullRate)-th frame. A burst gets choppier animation, never a stall.
import * as fontkit from 'fontkit'
import { createCompositor, createRun, scaledSize } from '../gfx.js'
import { createTextEngine } from '../text.js'
import { createEncoder } from './x264.js'
import { buildPrefix, streamTail, encodeFrames, codecString } from './encode.js'
import { encodePng } from './png.js'
import { createImageLoader } from './images.js'
import { imageUrls } from '../schema.js'

/** Bump whenever the bytes a render produces change: cache keys include it. */
export const ENGINE_VERSION = '4'

/**
 * Output pixels per scene pixel. Scenes lay out on their declared size (1200x630 by default) and
 * render natively at 0.8 of it (960x504): about a third less CPU and a quarter fewer bytes, with
 * text and edges no softer than a 1200x630 frame shown at preview size.
 */
export const DEFAULT_SCALE = 0.8

/** Fonts every scenario gets unless it overrides the name. */
export const DEFAULT_FONTS = { regular: 'inter-regular', semibold: 'inter-semibold' }

/**
 * @param {{
 *   modules: { ogfx: WebAssembly.Module, x264: WebAssembly.Module },
 *   fonts: Record<string, ArrayBuffer | Uint8Array | (() => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>)>,
 *   tailsAtFullRate?: number,
 *   images?: import('./images.js').ImageLoaderOptions,
 *   scale?: number,
 * }} options `fonts` resolves the built-in font names (inter-regular, inter-semibold).
 *   `images` configures fetching image params (fetch, allow, maxBytes, maxImages, cacheBytes).
 *   `scale` renders every scenario at about that fraction of its size, composited natively
 *   (default DEFAULT_SCALE, 0.8: 1200x630 -> 960x504; 1 renders at the declared size).
 */
export function createEngine({ modules, fonts: builtins, tailsAtFullRate = 3, images: imageOptions, scale = DEFAULT_SCALE }) {
  const loader = createImageLoader(imageOptions)
  let instances = null
  let chain = Promise.resolve()
  let queued = 0

  /** Runs `job` with the isolate's compositor + encoder, after every job queued before it. */
  function exclusive(job) {
    queued++
    const run = chain.then(async () => {
      try {
        instances ??= await Promise.all([createCompositor(modules.ogfx), createEncoder(modules.x264)]).then(([compositor, encoder]) => ({ compositor, encoder }))
        return await job(instances)
      } catch (error) {
        instances = null // a failed instance may be in a bad state; start the next job fresh
        throw error
      } finally {
        queued--
      }
    })
    chain = run.catch(() => {})
    return run
  }

  const frameStep = () => Math.max(1, Math.ceil(queued / tailsAtFullRate))

  const resolveFont = async (source) => {
    if (typeof source === 'string') {
      if (!(source in builtins)) throw new Error(`unknown built-in font "${source}"`)
      source = builtins[source]
    }
    if (typeof source === 'function') source = await source()
    return source instanceof Uint8Array ? source : new Uint8Array(source)
  }
  const texts = new Map()
  /** The scenario's text engine (fonts parsed once per isolate). */
  function text(scenario) {
    const key = `${scenario.id}@${scenario.version}`
    if (!texts.has(key)) {
      const promise = (async () => {
        const named = { ...DEFAULT_FONTS, ...scenario.fonts }
        const bytes = {}
        for (const [name, source] of Object.entries(named)) bytes[name] = await resolveFont(source)
        return createTextEngine(fontkit, bytes)
      })()
      promise.catch(() => texts.delete(key))
      texts.set(key, promise)
    }
    return texts.get(key)
  }

  /**
   * Fetches the scenario's images for these params: p.image fields plus scenario.images(params).
   * Done before a render queues for the engine, so slow image hosts never hold it.
   */
  const assets = (scenario, params) => loader.load([...imageUrls(scenario.params, params), ...(scenario.images?.(params) ?? [])])

  const run = async (scenario, params, compositor, a) =>
    createRun(compositor, await text(scenario), scenario.video, (ctx) => scenario.setup(ctx, params), { images: a.images, decoded: loader.decoded }, scale)

  const withRun = async (scenario, params, fn, a) => {
    a ??= await assets(scenario, params)
    return exclusive(async ({ compositor, encoder }) => {
      const r = await run(scenario, params, compositor, a)
      try {
        return await fn(r, encoder)
      } finally {
        r.dispose()
      }
    })
  }

  return {
    scale,
    /** The output size of a scenario's videos and posters at this engine's scale. */
    size: (scenario) => {
      const { width, height } = scaledSize(scenario.video, scale)
      return { width, height }
    },
    exclusive,
    frameStep,
    get queued() {
      return queued
    },
    /**
     * Fetches the images a render of these params needs. `missing` lists those that failed: a
     * render without them must not be cached. Pass the result as `assets` to the calls below so
     * they use exactly these bytes (they fetch on their own otherwise).
     */
    assets,
    /** Encodes the scenario's prefix for these params: a complete fMP4 head. */
    prefix: (scenario, params, { assets: a } = {}) => withRun(scenario, params, (r, encoder) => buildPrefix(encoder, r, scenario.prefix.frames), a),
    /**
     * Encodes the live tail after `prefix`, passing each fragment to `write`. Pass `frameStep`
     * to degrade under load; without it every frame is rendered (deterministic bytes).
     */
    tail: (scenario, params, prefix, { write, frameStep: step, yieldToNetwork, assets: a }) =>
      withRun(scenario, params, (r, encoder) => streamTail(encoder, r, prefix, { write, frameStep: step, yieldToNetwork }), a),
    /** The whole MP4 (prefix + tail, every frame), as one buffer. */
    async file(scenario, params, prefix, { assets: a } = {}) {
      a ??= await assets(scenario, params)
      prefix ??= await this.prefix(scenario, params, { assets: a })
      const parts = [prefix.bytes]
      await this.tail(scenario, params, prefix, { write: (b) => parts.push(b), assets: a })
      return concat(parts)
    },
    /** A frame as PNG: the scenario's poster frame by default. */
    poster: (scenario, params, frame, { assets: a } = {}) =>
      withRun(scenario, params, async (r) => {
        const i = frame ?? (scenario.poster === 'last' ? r.frames - 1 : scenario.poster)
        r.frame(i)
        return encodePng(r.rgba(), r.width, r.height)
      }, a),
    /** Raw RGBA frames, for tests and tools. `onFrame(i, rgba)` gets a view into wasm memory. */
    frames: (scenario, params, onFrame, { from = 0, to, assets: a } = {}) =>
      withRun(scenario, params, async (r) => {
        for (let i = from; i < (to ?? r.frames); i++) {
          r.frame(i)
          await onFrame(i, r.rgba(), r)
        }
        return r.frames
      }, a),
    /** Frame count and duration for headers, without rendering. */
    describe: (scenario) => ({ frames: scenario.video.frames, fps: scenario.video.fps, duration: scenario.video.frames / scenario.video.fps }),
    encodeFrames,
    codecString,
  }
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
