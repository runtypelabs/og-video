// The per-isolate render engine: one compositor + encoder pair, a FIFO queue in front of it, and
// the operations the runtimes build on (prefix, live tail, whole file, poster).
//
// One pair is about 38 MB of wasm memory, which never shrinks. Workers cap an isolate at 128 MB
// and often run concurrent requests in the same isolate, so renders take turns on a single pair
// instead of each instantiating their own. Workers also expose no clock that advances during
// compute, so queue depth is the load signal: with k renders queued or running, live tails render
// every ceil(k / tailsAtFullRate)-th frame. A burst gets choppier animation, never a stall.
import * as fontkit from 'fontkit'
import { createCompositor, createRun } from '../gfx.js'
import { createTextEngine } from '../text.js'
import { createEncoder } from './x264.js'
import { buildPrefix, streamTail, encodeFrames, codecString } from './encode.js'
import { encodePng } from './png.js'

/** Bump whenever the bytes a render produces change: cache keys include it. */
export const ENGINE_VERSION = '2'

/** Fonts every scenario gets unless it overrides the name. */
export const DEFAULT_FONTS = { regular: 'inter-regular', semibold: 'inter-semibold' }

/**
 * @param {{
 *   modules: { ogfx: WebAssembly.Module, x264: WebAssembly.Module },
 *   fonts: Record<string, ArrayBuffer | Uint8Array | (() => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>)>,
 *   tailsAtFullRate?: number,
 * }} options `fonts` resolves the built-in font names (inter-regular, inter-semibold).
 */
export function createEngine({ modules, fonts: builtins, tailsAtFullRate = 3 }) {
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

  const run = async (scenario, params, compositor) =>
    createRun(compositor, await text(scenario), scenario.video, (ctx) => scenario.setup(ctx, params))

  const withRun = (scenario, params, fn) =>
    exclusive(async ({ compositor, encoder }) => {
      const r = await run(scenario, params, compositor)
      try {
        return await fn(r, encoder)
      } finally {
        r.dispose()
      }
    })

  return {
    exclusive,
    frameStep,
    get queued() {
      return queued
    },
    /** Encodes the scenario's prefix for these params: a complete fMP4 head. */
    prefix: (scenario, params) => withRun(scenario, params, (r, encoder) => buildPrefix(encoder, r, scenario.prefix.frames)),
    /**
     * Encodes the live tail after `prefix`, passing each fragment to `write`. Pass `frameStep`
     * to degrade under load; without it every frame is rendered (deterministic bytes).
     */
    tail: (scenario, params, prefix, { write, frameStep: step, yieldToNetwork }) =>
      withRun(scenario, params, (r, encoder) => streamTail(encoder, r, prefix, { write, frameStep: step, yieldToNetwork })),
    /** The whole MP4 (prefix + tail, every frame), as one buffer. */
    async file(scenario, params, prefix) {
      prefix ??= await this.prefix(scenario, params)
      const parts = [prefix.bytes]
      await this.tail(scenario, params, prefix, { write: (b) => parts.push(b) })
      return concat(parts)
    },
    /** A frame as PNG: the scenario's poster frame by default. */
    poster: (scenario, params, frame) =>
      withRun(scenario, params, async (r) => {
        const i = frame ?? (scenario.poster === 'last' ? r.frames - 1 : scenario.poster)
        r.frame(i)
        return encodePng(r.rgba(), r.width, r.height)
      }),
    /** Raw RGBA frames, for tests and tools. `onFrame(i, rgba)` gets a view into wasm memory. */
    frames: (scenario, params, onFrame, { from = 0, to } = {}) =>
      withRun(scenario, params, async (r) => {
        for (let i = from; i < (to ?? r.frames); i++) {
          r.frame(i)
          await onFrame(i, r.rgba(), r)
        }
        return r.frames
      }),
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
