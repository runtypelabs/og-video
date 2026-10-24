#!/usr/bin/env node
// Which built-in scenarios a diff can change, and why.
//
//   node affected.mjs --base <rev> --head <rev>     # prints JSON
//
// A scenario is affected when a changed file is in its static import closure under src/ (its own
// file, showcase-kit.js, gfx.js, text.js, twemoji.json, ...). Files that every render goes through
// without being imported by a scenario (the engine, the Node entry, the wasm, fonts, the Rust and
// x264 sources, the lockfile that pins gsap) affect all of them. Reads both revisions from git, so
// it needs no checkout of either.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } })
if (!args.base || !args.head) {
  console.error('usage: affected.mjs --base <rev> --head <rev>')
  process.exit(2)
}

const git = (...a) => execFileSync('git', a, { maxBuffer: 64 * 1024 * 1024 }).toString()
const changed = git('diff', '--name-only', `${args.base}...${args.head}`).split('\n').filter(Boolean)

// Paths every render depends on, with the reason shown in the PR comment.
const GLOBAL = [
  [/^src\/engine\//, 'engine'],
  [/^src\/node\//, 'Node engine / sogv'],
  [/^wasm\//, 'wasm build'],
  [/^fonts\//, 'fonts'],
  [/^crates\//, 'compositor source'],
  [/^x264\//, 'x264 build'],
  [/^package(-lock)?\.json$/, 'dependencies'],
]

/** Scenario files at a revision: { id, file, closure: Set<path> }. */
function scenariosAt(rev) {
  const files = git('ls-tree', '-r', '--name-only', rev, 'src').split('\n').filter(Boolean)
  const exists = new Set(files)
  const source = new Map()
  const read = (f) => {
    if (!source.has(f)) source.set(f, exists.has(f) && /\.m?js$/.test(f) ? git('show', `${rev}:${f}`) : '')
    return source.get(f)
  }
  const deps = (f) =>
    [...read(f).matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])))
  const closure = (f) => {
    const seen = new Set()
    const walk = (x) => {
      if (seen.has(x) || !exists.has(x)) return
      seen.add(x)
      for (const d of deps(x)) walk(d)
    }
    walk(f)
    return seen
  }
  const out = []
  for (const f of files.filter((f) => /^src\/scenarios\/[^/]+\.js$/.test(f))) {
    const m = read(f).match(/defineScenario\(\{\s*id:\s*['"]([a-z0-9-]+)['"]/)
    if (m) out.push({ id: m[1], file: f, closure: closure(f) })
  }
  return out
}

const head = scenariosAt(args.head)
const base = scenariosAt(args.base)
const affected = new Map()
const add = (id, reason) => {
  if (!affected.has(id)) affected.set(id, new Set())
  affected.get(id).add(reason)
}

// One reason per category, naming the first file and counting the rest.
const globalHits = GLOBAL.map(([re, why]) => [why, changed.filter((f) => re.test(f))])
  .filter(([, files]) => files.length)
  .map(([why, files]) => `${why}: ${files[0]}${files.length > 1 ? ` +${files.length - 1} more` : ''}`)
for (const s of [...head, ...base]) {
  for (const why of globalHits) add(s.id, why)
  for (const f of changed) if (s.closure.has(f)) add(s.id, f === s.file ? `its source (${f})` : `imports ${f}`)
}

const warnings = []
const rust = changed.some((f) => /^crates\/ogfx\/src\//.test(f))
if (rust && !changed.includes('wasm/ogfx.wasm'))
  warnings.push('crates/ogfx changed but wasm/ogfx.wasm did not: renders use the committed wasm, so they cannot show the Rust change. Run `npm run build:ogfx` and commit the wasm.')
if (changed.some((f) => /^x264\//.test(f)) && !changed.includes('wasm/x264.wasm'))
  warnings.push('x264/ changed but wasm/x264.wasm did not: renders use the committed encoder.')
if (changed.some((f) => f.startsWith('src/worker/'))) warnings.push('src/worker/ changed: it does not affect rendered bytes. Drive the Worker routes too (features/worker.md).')

const headIds = new Set(head.map((s) => s.id))
const baseIds = new Set(base.map((s) => s.id))
const result = {
  base: args.base,
  head: args.head,
  changed,
  scenarios: [...affected]
    .map(([id, why]) => ({ id, reasons: [...why], ...(headIds.has(id) ? {} : { removed: true }), ...(baseIds.has(id) ? {} : { added: true }) }))
    .sort((a, b) => a.id.localeCompare(b.id)),
  all: head.length > 0 && head.every((s) => affected.has(s.id)),
  warnings,
}
console.log(JSON.stringify(result, null, 2))
