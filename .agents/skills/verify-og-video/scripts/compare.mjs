#!/usr/bin/env node
// Compare the base and head renders of a run and write <run>/report.json.
//
//   node compare.mjs --run .verify/runs/<id>
//
// Expects <run>/base/manifest.json and <run>/head/manifest.json from render.mjs. Renders are
// deterministic, so equal sha256 means no visual change. For a changed render it finds the first
// frame whose decoded pixels differ and writes, into <run>/compare/:
//   <id>.<set>.frame.png   base | head at that frame, side by side
//   <id>.<set>.diff.png    |base - head| of the two contact sheets, amplified 4x
// and checks the cache-key invariant: bytes that changed for the same content id need a new
// ENGINE_VERSION or scenario version, or caches keep serving the old video.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({ options: { run: { type: 'string' } } })
if (!args.run) {
  console.error('usage: compare.mjs --run <run-dir>')
  process.exit(2)
}
const run = path.resolve(args.run)
// No manifest means no scenario was affected, so nothing was rendered.
const load = (label) => {
  const file = path.join(run, label, 'manifest.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rev: null, engineVersion: null, entries: [] }
}
const base = load('base')
const head = load('head')
mkdirSync(path.join(run, 'compare'), { recursive: true })
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'pipe', 'pipe'] })

/** Per-frame md5 of a decoded MP4, with held (dropped) frames filled from the previous one. */
function frameHashes(file, frames) {
  const byPts = new Map()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const cols = line.split(',').map((s) => s.trim())
    byPts.set(Number(cols[2]), cols[5])
  }
  const out = []
  for (let i = 0; i < frames; i++) out.push(byPts.get(i) ?? out[i - 1])
  return out
}

const key = (e) => `${e.id}.${e.set}`
const baseBy = new Map(base.entries.map((e) => [key(e), e]))
const headBy = new Map(head.entries.map((e) => [key(e), e]))
const keys = [...new Set([...headBy.keys(), ...baseBy.keys()])]

const items = []
for (const k of keys) {
  const b = baseBy.get(k)
  const h = headBy.get(k)
  const item = { key: k, id: (h ?? b).id, set: (h ?? b).set, base: b ?? null, head: h ?? null, invariants: [] }
  items.push(item)
  if (!h || h.absent) item.status = 'removed'
  else if (!b || b.absent) item.status = 'added'
  else if (h.error || b.error) item.status = 'error'
  else item.status = h.sha256 === b.sha256 ? 'identical' : 'changed'

  for (const [label, e] of [['head', h], ['base', b]]) {
    if (!e?.checks) continue
    for (const [name, ok] of Object.entries(e.checks)) if (!ok) item.invariants.push(`FAIL ${label} ${name}`)
  }
  if (h?.error) item.invariants.push(`FAIL head render error: ${h.error}`)

  if (item.status !== 'changed') continue
  const { fps, frames } = h.video
  if (b.video.fps === fps && b.video.frames === frames && b.video.width === h.video.width && b.video.height === h.video.height) {
    const hb = frameHashes(path.join(run, 'base', `${k}.md5`), frames)
    const hh = frameHashes(path.join(run, 'head', `${k}.md5`), frames)
    const diff = hh.map((x, i) => x !== hb[i])
    item.firstDiff = diff.indexOf(true)
    item.framesChanged = diff.filter(Boolean).length
  } else {
    item.firstDiff = 0
    item.framesChanged = frames
    item.note = `video changed shape: ${JSON.stringify(b.video)} -> ${JSON.stringify(h.video)}`
  }
  if (item.firstDiff >= 0) {
    // Frame N as a player shows it: resample to fps (dropped frames are held), then pick N.
    const pick = `fps=${fps},select='eq(n\\,${item.firstDiff})',scale=600:-2`
    ffmpeg(
      '-i', path.join(run, 'base', `${k}.mp4`), '-i', path.join(run, 'head', `${k}.mp4`),
      '-filter_complex', `[0:v]${pick},pad=iw+8:ih:0:0:white[a];[1:v]${pick}[b];[a][b]hstack`,
      '-frames:v', '1', path.join(run, 'compare', `${k}.frame.png`),
    )
  }
  ffmpeg(
    '-i', path.join(run, 'base', `${k}.sheet.png`), '-i', path.join(run, 'head', `${k}.sheet.png`),
    '-filter_complex', `[0:v][1:v]blend=all_mode=difference,lutrgb=r='min(val*4,255)':g='min(val*4,255)':b='min(val*4,255)'`,
    '-frames:v', '1', path.join(run, 'compare', `${k}.diff.png`),
  )

  const sameKey = b.contentId === h.contentId
  const bumped = base.engineVersion !== head.engineVersion || b.scenarioVersion !== h.scenarioVersion
  if (sameKey && !bumped)
    item.invariants.push(`FAIL bytes changed under the same cache key (content id ${h.contentId}, ENGINE_VERSION ${head.engineVersion}, ${item.id} version ${h.scenarioVersion}): bump ENGINE_VERSION or the scenario's version`)
  item.cacheKey = sameKey ? (bumped ? 'version bumped' : 'NOT bumped') : 'params changed (new content id, so a new cache key)'
}

const affected = existsSync(path.join(run, 'affected.json')) ? JSON.parse(readFileSync(path.join(run, 'affected.json'), 'utf8')) : null
const report = {
  run: path.basename(run),
  base: { rev: base.rev ?? affected?.base, engineVersion: base.engineVersion },
  head: { rev: head.rev ?? affected?.head, engineVersion: head.engineVersion },
  affected,
  items,
  failures: items.flatMap((i) => i.invariants.map((x) => `${i.key}: ${x}`)),
}
writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
for (const i of items) console.error(`${i.key}: ${i.status}${i.firstDiff >= 0 ? `, first diff at frame ${i.firstDiff}, ${i.framesChanged} frames` : ''}${i.cacheKey ? `, cache key: ${i.cacheKey}` : ''}`)
for (const f of report.failures) console.error(f)
process.exitCode = report.failures.length ? 1 : 0
