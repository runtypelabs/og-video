// Node entry: the same engine as the Worker, with wasm and fonts read from the package on disk.
// For local renders, tests, prefix builds and tools.
import { readFile } from 'node:fs/promises'
import { createEngine } from '../engine/engine.js'
import { validate } from '../schema.js'

const root = new URL('../../', import.meta.url)
const file = (path) => readFile(new URL(path, root))

/** The engine, loaded from this package's wasm/ and fonts/. */
export async function createNodeEngine(options = {}) {
  const [ogfx, x264, aom] = await Promise.all([file('wasm/ogfx.wasm'), file('wasm/x264.wasm'), file('wasm/aom.wasm')].map(async (b) => WebAssembly.compile(await b)))
  return createEngine({
    modules: { ogfx, x264, aom },
    fonts: {
      'inter-regular': () => file('fonts/Inter-Regular.ttf.bin'),
      'inter-semibold': () => file('fonts/Inter-SemiBold.ttf.bin'),
    },
    ...options,
  })
}

/** Validates raw params against a scenario's schema (defaults applied). */
export const parseParams = (scenario, raw = {}) => validate(scenario.params, raw)

export { createEngine, ENGINE_VERSION, concat } from '../engine/engine.js'
