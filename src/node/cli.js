#!/usr/bin/env node
// sogv: render scenarios locally, check and build prefixes, and compare against references.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createNodeEngine, parseParams } from './index.js'
import { pack, contentId } from '../params.js'

const HELP = `sogv <command> <scenario> [options]

  <scenario> is a built-in id (title-card, diagram, ...) or path/to/module.js[#export]
  (default export, or the named export).

Commands
  render   Write the MP4 (and the poster PNG with --png).
  stills   Write PNGs of the frames at --at seconds (default 0.5,1.5,3,5,last).
  prefix   Check that frames [0, prefix.frames) do not depend on params outside prefix.key,
           using --params plus --vary (a JSON array of param objects), then report sizes.
  url      Print the query-string and packed URLs for --params on --origin.
  bench    Render the whole MP4 --runs times and report ms per render.

Options
  --params '<json>'   Params (validated with the scenario's schema; defaults applied)
  --out, -o <path>    Output file (render) or directory (stills). Default: out/<scenario>
  --at <list>         Seconds for stills, comma separated; 'last' for the final frame
  --png               Also write the poster frame (render)
  --vary '<json>'     Other params to compare against (prefix)
  --origin <url>      Base URL for 'url' (default https://og.video)
  --runs <n>          Iterations for bench (default 5)
`

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    params: { type: 'string', default: '{}' },
    out: { type: 'string', short: 'o' },
    at: { type: 'string' },
    png: { type: 'boolean' },
    vary: { type: 'string', default: '[]' },
    origin: { type: 'string', default: 'https://og.video' },
    runs: { type: 'string', default: '5' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [command, target] = positionals
if (opts.help || !command || !target) {
  process.stdout.write(HELP)
  process.exit(opts.help ? 0 : 1)
}

async function loadScenario(spec) {
  const builtins = await import('../scenarios/index.js')
  const found = Object.values(builtins).find((s) => s && s.id === spec)
  if (found) return found
  const [path, name = 'default'] = spec.split('#')
  const mod = await import(pathToFileURL(resolve(path)).href)
  if (!mod[name]) throw new Error(`${path} has no export "${name}"`)
  return mod[name]
}

const scenario = await loadScenario(target)
const params = await parseParams(scenario, JSON.parse(opts.params))
const engine = await createNodeEngine()
const now = () => performance.now()

if (command === 'render') {
  const out = opts.out ?? `out/${scenario.id}.mp4`
  await mkdir(resolve(out, '..'), { recursive: true })
  const t0 = now()
  const prefix = await engine.prefix(scenario, params)
  const t1 = now()
  const bytes = await engine.file(scenario, params, prefix)
  const t2 = now()
  await writeFile(out, bytes)
  console.log(`${out}: ${(bytes.length / 1024).toFixed(0)} KB, ${scenario.video.frames} frames; prefix ${prefix.frames} frames in ${(t1 - t0).toFixed(0)} ms, whole file ${(t2 - t1).toFixed(0)} ms`)
  if (opts.png) {
    const png = out.replace(/\.mp4$/, '') + '.png'
    await writeFile(png, await engine.poster(scenario, params))
    console.log(png)
  }
} else if (command === 'stills') {
  const dir = opts.out ?? `out/${scenario.id}`
  await mkdir(dir, { recursive: true })
  const { fps, frames } = scenario.video
  const at = (opts.at ?? '0.5,1.5,3,5,last').split(',').map((s) => (s === 'last' ? frames - 1 : Math.min(frames - 1, Math.round(Number(s) * fps))))
  for (const i of at) {
    const png = await engine.poster(scenario, params, i)
    const path = join(dir, `${String(i).padStart(3, '0')}.png`)
    await writeFile(path, png)
    console.log(`${path} (t=${(i / fps).toFixed(2)}s)`)
  }
} else if (command === 'prefix') {
  const variants = JSON.parse(opts.vary)
  const n = scenario.prefix.frames
  const hashes = async (p) => {
    const out = []
    await engine.frames(scenario, p, (i, rgba) => {
      let h = 2166136261
      for (let j = 0; j < rgba.length; j += 7) h = Math.imul(h ^ rgba[j], 16777619)
      out.push(h >>> 0)
    }, { to: n })
    return out
  }
  const base = await hashes(params)
  let ok = true
  for (const raw of variants) {
    const v = await parseParams(scenario, raw)
    const same = scenario.prefix.key(v) === scenario.prefix.key(params)
    const h = await hashes(v)
    const first = h.findIndex((x, i) => x !== base[i])
    if (same && first >= 0) {
      ok = false
      console.log(`FAIL ${JSON.stringify(raw)}: same prefix key, but frame ${first} differs`)
    } else console.log(`ok   ${JSON.stringify(raw)}${same ? '' : ' (different prefix key)'}`)
  }
  const prefix = await engine.prefix(scenario, params)
  console.log(`prefix: ${n} frames (${(n / scenario.video.fps).toFixed(2)} s), ${(prefix.bytes.length / 1024).toFixed(0)} KB, key "${scenario.prefix.key(params)}"`)
  process.exitCode = ok ? 0 : 1
} else if (command === 'url') {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  console.log(`${opts.origin}/${scenario.id}.mp4?${q}`)
  console.log(`${opts.origin}/${scenario.id}.mp4?s=${await pack(params)}`)
  console.log(`content id: ${await contentId(scenario.id, params)}`)
} else if (command === 'bench') {
  const runs = Number(opts.runs)
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    await engine.file(scenario, params)
    times.push(now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(`${scenario.id}: median ${times[runs >> 1].toFixed(0)} ms, min ${times[0].toFixed(0)} ms over ${runs} renders (${scenario.video.frames / scenario.video.fps} s of video)`)
} else {
  process.stdout.write(HELP)
  process.exit(1)
}

