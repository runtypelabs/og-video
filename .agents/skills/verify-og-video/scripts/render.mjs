#!/usr/bin/env node
// Render evidence for some scenarios from one checkout of the library, and check its invariants.
//
//   node render.mjs --checkout <dir> --out <dir> --scenarios title-card,diagram [--showcase showcase.json] [--runs 5]
//
// Imports the library from --checkout (not from this script's repo), so the same script renders
// the base and the head of a PR. For each scenario and param set (`default` = {}, `showcase` =
// its entry in showcase.json) it writes:
//   <id>.<set>.mp4        the whole file, prefix + tail
//   <id>.<set>.png        the poster frame (engine.poster, what og:image serves)
//   <id>.<set>.sheet.png  a 3x2 contact sheet decoded from the MP4 at SHEET_AT seconds
//   <id>.<set>.md5        ffmpeg framemd5 of the decoded frames, for finding the first change
// and records in manifest.json: sha256, size, cache-key parts (ENGINE_VERSION, scenario version,
// content id), `sogv bench` timings, and three invariants:
//   deterministic   the prefix path, a fresh in-process render and `sogv render` in a separate
//                   process give identical bytes
//   prefixIsStart   the prefix's bytes are the first bytes of the file
//   posterIsPng     the poster is a PNG of the video's size

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    checkout: { type: 'string' },
    out: { type: 'string' },
    scenarios: { type: 'string' },
    showcase: { type: 'string', default: path.join(import.meta.dirname, '..', 'showcase.json') },
    runs: { type: 'string', default: '5' },
  },
})
if (!args.checkout || !args.out || !args.scenarios) {
  console.error('usage: render.mjs --checkout <dir> --out <dir> --scenarios <id,id|all> [--showcase file] [--runs n]')
  process.exit(2)
}

const SHEET_AT = [0.5, 1.5, 3, 4.5, 6, 'last']
const checkout = path.resolve(args.checkout)
const out = path.resolve(args.out)
mkdirSync(out, { recursive: true })
const lib = (p) => import(pathToFileURL(path.join(checkout, p)).href)
const cli = path.join(checkout, 'src/node/cli.js')

const { createNodeEngine, parseParams, ENGINE_VERSION } = await lib('src/node/index.js')
const { contentId } = await lib('src/params.js')
const builtins = Object.values(await lib('src/scenarios/index.js')).filter((s) => s?.id)
const showcase = JSON.parse(readFileSync(args.showcase, 'utf8'))
const engine = await createNodeEngine()

const ids = args.scenarios === 'all' ? builtins.map((s) => s.id) : args.scenarios.split(',').filter(Boolean)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const run = (cmd, a) => execFileSync(cmd, a, { cwd: checkout, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const rev = (() => {
  try {
    return run('git', ['rev-parse', 'HEAD']).trim()
  } catch {
    return null
  }
})()

const entries = []
for (const id of ids) {
  const scenario = builtins.find((s) => s.id === id)
  if (!scenario) {
    entries.push({ id, set: 'default', absent: true })
    continue
  }
  const sets = [['default', {}], ...(showcase[id] ? [['showcase', showcase[id]]] : [])]
  for (const [set, raw] of sets) {
    const base = `${id}.${set}`
    const entry = { id, set, raw, scenarioVersion: scenario.version, video: scenario.video, prefixFrames: scenario.prefix.frames }
    entries.push(entry)
    try {
      const params = await parseParams(scenario, raw)
      entry.contentId = await contentId(id, params)

      const t0 = performance.now()
      const prefix = await engine.prefix(scenario, params)
      const a = await engine.file(scenario, params, prefix)
      entry.renderMs = Math.round(performance.now() - t0)
      const b = await engine.file(scenario, params)
      const poster = await engine.poster(scenario, params)

      const mp4 = path.join(out, `${base}.mp4`)
      writeFileSync(mp4, a)
      writeFileSync(path.join(out, `${base}.png`), poster)
      entry.sha256 = sha(a)
      entry.bytes = a.length
      entry.prefixBytes = prefix.bytes.length

      // The CLI in a fresh process, so module-level caches can't make two renders agree.
      const cliOut = path.join(out, `.${base}.cli.mp4`)
      run(process.execPath, [cli, 'render', id, '--params', JSON.stringify(raw), '-o', cliOut])
      const c = readFileSync(cliOut)
      const view = new DataView(poster.buffer, poster.byteOffset)
      entry.checks = {
        deterministic: Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0 && Buffer.compare(Buffer.from(a), c) === 0,
        prefixIsStart: Buffer.compare(Buffer.from(a.subarray(0, prefix.bytes.length)), Buffer.from(prefix.bytes)) === 0,
        posterIsPng:
          poster[1] === 80 && poster[2] === 78 && poster[3] === 71 && view.getUint32(16) === scenario.video.width && view.getUint32(20) === scenario.video.height,
      }
      execFileSync('rm', ['-f', cliOut])

      // `sogv bench`: median and min ms per whole render.
      const bench = run(process.execPath, [cli, 'bench', id, '--params', JSON.stringify(raw), '--runs', args.runs])
      const m = bench.match(/median (\d+) ms, min (\d+) ms over (\d+) renders/)
      entry.bench = m ? { median: +m[1], min: +m[2], runs: +m[3] } : { raw: bench.trim() }

      // Contact sheet from the decoded MP4: what a player shows, encoder artifacts included.
      const { fps, frames } = scenario.video
      const at = SHEET_AT.map((t) => (t === 'last' ? frames - 1 : Math.min(frames - 1, Math.round(t * fps))))
      entry.sheetFrames = at
      run('ffmpeg', [
        '-v', 'error', '-y', '-i', mp4,
        // The encoder drops unchanged frames (the previous one is held), so resample to the
        // scenario's fps before picking frames by index.
        '-vf', `fps=${fps},select='${at.map((i) => `eq(n\\,${i})`).join('+')}',scale=400:-2,tile=3x2:padding=4:color=white`,
        '-frames:v', '1', '-fps_mode', 'passthrough', path.join(out, `${base}.sheet.png`),
      ])
      run('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-f', 'framemd5', path.join(out, `${base}.md5`)])
    } catch (err) {
      entry.error = String(err?.stderr?.toString() || err?.message || err).trim().slice(0, 600)
    }
    console.error(`${checkout.split('/').pop()} ${base}: ${entry.error ? `ERROR ${entry.error}` : `${(entry.bytes / 1024).toFixed(0)} KB, bench ${entry.bench?.median} ms, ${Object.entries(entry.checks).filter(([, v]) => !v).map(([k]) => `FAIL ${k}`).join(' ') || 'checks ok'}`}`)
  }
}

const manifest = { checkout, rev, engineVersion: ENGINE_VERSION, node: process.version, entries }
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
