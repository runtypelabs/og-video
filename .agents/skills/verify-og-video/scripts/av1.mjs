#!/usr/bin/env node
// Render the AV1 variant of each scenario at one revision, next to H.264 at the same frame rate,
// and check the files with ffprobe (and AVFoundation on macOS). post.mjs adds them to the comment.
//
//   node av1.mjs --checkout <dir> --out <run>/av1 --scenarios <id,id|all> [--fps 120,gallery=30]
//
// Writes <id>.av1.mp4 and manifest.json: fps, frames encoded, size and render ms for AV1 and for
// H.264 retimed to the same fps (best of 2, after a warm-up), the codec string, ffprobe's stream
// summary, and AVFoundation's verdict. Default params only.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    checkout: { type: 'string' },
    out: { type: 'string' },
    scenarios: { type: 'string' },
    fps: { type: 'string', default: '120' },
  },
})
if (!args.checkout || !args.out || !args.scenarios) {
  console.error('usage: av1.mjs --checkout <dir> --out <dir> --scenarios <id,id|all> [--fps 120,gallery=30]')
  process.exit(2)
}
const checkout = path.resolve(args.checkout)
const out = path.resolve(args.out)
if (!existsSync(path.join(checkout, 'src/engine/av1.js'))) {
  console.error('av1: this revision has no AV1 variant; skipping')
  process.exit(0)
}
mkdirSync(out, { recursive: true })
const lib = (p) => import(pathToFileURL(path.join(checkout, p)).href)
const { createNodeEngine, parseParams } = await lib('src/node/index.js')
const { atFps } = await lib('src/engine/av1.js')
const builtins = Object.values(await lib('src/scenarios/index.js')).filter((s) => s?.id)
const engine = await createNodeEngine()

// "120,gallery=30": a default and per-scenario overrides.
const fpsSpec = Object.fromEntries(args.fps.split(',').map((p) => (p.includes('=') ? p.split('=') : ['*', p])))
const fpsOf = (id) => Number(fpsSpec[id] ?? fpsSpec['*'] ?? 120)
const ids = args.scenarios === 'all' ? builtins.map((s) => s.id) : args.scenarios.split(',').filter(Boolean)
const has = (cmd, a) => {
  try {
    execFileSync(cmd, a, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const ffprobe = has('ffprobe', ['-version'])
const avcheck = process.platform === 'darwin' && has('swift', ['--version']) ? path.join(checkout, 'scripts/avcheck.swift') : null

const best = async (fn) => {
  let result = await fn()
  let ms = Infinity
  for (let i = 0; i < 2; i++) {
    const t = performance.now()
    result = await fn()
    ms = Math.min(ms, performance.now() - t)
  }
  return { result, ms: Math.round(ms) }
}

const entries = []
for (const id of ids) {
  const scenario = builtins.find((s) => s.id === id)
  if (!scenario) continue
  const fps = fpsOf(id)
  const entry = { id, fps, nativeFps: scenario.video.fps }
  entries.push(entry)
  try {
    const params = await parseParams(scenario, {})
    const a = await best(() => engine.av1(scenario, params, { fps }))
    const h = await best(() => engine.file(atFps(scenario, fps), params))
    const file = path.join(out, `${id}.av1.mp4`)
    writeFileSync(file, a.result.bytes)
    Object.assign(entry, {
      file: `${id}.av1.mp4`,
      codec: a.result.codec,
      frames: a.result.frames,
      encoded: a.result.encoded,
      av1: { bytes: a.result.bytes.length, ms: a.ms },
      h264: { bytes: h.result.length, ms: h.ms },
    })
    if (ffprobe) {
      const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,nb_read_frames,color_primaries:format=duration', '-of', 'json', file]).toString())
      const s = p.streams[0]
      entry.ffprobe = `${s.codec_name} ${s.profile} ${s.width}x${s.height} r_frame_rate=${s.r_frame_rate} frames=${s.nb_read_frames} ${s.color_primaries} duration=${p.format.duration}s`
    }
    if (avcheck) entry.avfoundation = execFileSync('swift', [avcheck, file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    console.error(`${id}: AV1 ${fps} fps ${a.ms} ms ${(a.result.bytes.length / 1024).toFixed(0)} KB; H.264 ${fps} fps ${h.ms} ms ${(h.result.length / 1024).toFixed(0)} KB`)
  } catch (err) {
    entry.error = String(err?.stack ?? err)
    console.error(`${id}: ${entry.error}`)
  }
}
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ checkout, node: process.version, entries }, null, 2))
