// node scripts/bench-av1.mjs [fps] [scenario...]: AV1 vs H.264 render time and size per built-in
// scenario at one frame rate (whole file, best of 3, after a warm-up render). Writes out/av1/.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createNodeEngine, parseParams } from '../src/node/index.js'
import { atFps } from '../src/engine/av1.js'
import * as builtins from '../src/scenarios/index.js'

const [fpsArg, ...ids] = process.argv.slice(2)
const fps = Number(fpsArg ?? 120)
const engine = await createNodeEngine()
const all = Object.values(builtins).filter((s) => s?.id)
const best = async (fn) => {
  await fn()
  let ms = Infinity
  let out
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    out = await fn()
    ms = Math.min(ms, performance.now() - t)
  }
  return { ms: Math.round(ms), out }
}
mkdirSync('out/av1', { recursive: true })
const rows = []
for (const scenario of ids.length ? all.filter((s) => ids.includes(s.id)) : all) {
  const params = await parseParams(scenario, {})
  const h = await best(() => engine.file(atFps(scenario, fps), params))
  const a = await best(() => engine.av1(scenario, params, { fps }))
  writeFileSync(`out/av1/${scenario.id}-${fps}.h264.mp4`, h.out)
  writeFileSync(`out/av1/${scenario.id}-${fps}.av1.mp4`, a.out.bytes)
  const row = { scenario: scenario.id, fps, frames: a.out.frames, av1Encoded: a.out.encoded, h264Ms: h.ms, av1Ms: a.ms, ratio: +(a.ms / h.ms).toFixed(1), h264KB: Math.round(h.out.length / 1024), av1KB: Math.round(a.out.bytes.length / 1024), codec: a.out.codec }
  rows.push(row)
  console.log(JSON.stringify(row))
}
console.log(`\n| scenario | frames (AV1 encoded) | H.264 ms | AV1 ms | AV1 / H.264 | H.264 KB | AV1 KB |\n|---|---|---|---|---|---|---|`)
for (const r of rows) console.log(`| ${r.scenario} | ${r.frames} (${r.av1Encoded}) | ${r.h264Ms} | ${r.av1Ms} | ${r.ratio}x | ${r.h264KB} | ${r.av1KB} |`)
