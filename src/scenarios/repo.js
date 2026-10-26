// repo: an animated repository card, the moving version of a code host's social card. owner/name
// lands first, the version pill pops and the description wipes on line by line. Then the star
// count rolls up like an odometer (12400 shows as 12.4k), forks and downloads follow, the
// language bar fills left to right with its legend, and topic pills pop in on a beat. With a
// `series` of star counts, a growth line draws across the right with a glowing head, and each
// milestone it passes (5k, 10k) flashes and leaves a tick. Without one, the stats spread out.
//
// Every number is a param: nothing is fetched. An agent reads the repo and passes the counts.
//
// The first 40 frames (0.67 s, the header) depend only on owner, name, accent and theme, so a card
// re-rendered as the stars grow reuses its prefix. The header always leaves room for the version
// pill so its layout never depends on the version.
//
// Rolling digits are vector fills clipped to the number's window. Every element is an item with a
// "done" test: settled items are drawn into one cached layer keyed by which are done, and only the
// moving ones are drawn live, so after ~4 s every frame is identical and skipped.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, ellipse, transform } from '../gfx.js'
import { W, H, THEMES, background, mix, hex, onColor, affine, prng } from './showcase-kit.js'

const PAD_X = 80
const NAME_BASE = 124
const PILL_ROOM = 230 // kept free right of the name whether or not there is a version
const LABEL_BASE = 350
const NUM_BASE = 472
const BAR = { y: 538, h: 12 }
const LEGEND_BASE = 588
const CHART = { y0: 376, y1: 490 }

/**
 * A comma-separated list as a string param (URL-friendly); a JSON array of strings or numbers is
 * joined first. Any other array goes through as-is, so the string schema rejects it cleanly.
 */
function list(opts) {
  const schema = p.string(opts)
  const parse = schema.parse
  schema.parse = (v, path) => parse(Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number') ? v.join(',') : v, path)
  return schema
}

export const repo = defineScenario({
  id: 'repo',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  fonts: { mono: 'jetbrains-mono-semibold' },
  params: p.object({
    owner: p.string({ max: 39, default: 'acme' }),
    name: p.string({ max: 100, min: 1, default: 'fastq' }),
    desc: p.string({ max: 200, default: 'A fast, typed job queue for Node, Bun and the edge. Retries, cron and rate limits in 4 kB.' }),
    stars: p.int({ min: 0, max: 999999999, default: 12400 }),
    // 0 hides forks.
    forks: p.int({ min: 0, max: 999999999, default: 860 }),
    version: p.string({ max: 16, default: '2.4.0' }),
    downloads: p.string({ max: 16, default: '48k/week' }),
    // One language (wins over langs when set), or a breakdown: "TypeScript:72,Rust:20,Other:8",
    // optionally with a colour per entry: "Zig:80:f7a41d".
    lang: p.string({ max: 24, default: '' }),
    langColor: p.color({ optional: true }),
    langs: list({ max: 240, default: 'TypeScript:72,Rust:20,Other:8' }),
    topics: list({ max: 240, default: 'job-queue,workers,edge,typescript,cron' }),
    // Star history, oldest first: "0,40,90,...". Empty for no chart.
    series: list({ max: 800, pattern: /^\[?[-\d.,\s]*\]?$/, default: '0,40,90,160,260,2100,2900,3500,4100,4800,5600,6900,8200,9600,11000,12400' }),
    accent: p.color({ default: '#f59e0b' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 40, key: (q) => JSON.stringify([q.accent, q.theme, q.owner, q.name]) },
  meta: (q) => ({
    title: q.owner ? `${q.owner}/${q.name}` : q.name,
    description: [q.desc, `${compact(q.stars)} stars`, q.version && `v${q.version.replace(/^v/i, '')}`].filter(Boolean).join(' · '),
  }),
  setup,
})

/** 860 -> '860', 12400 -> '12.4k', 124000 -> '124k', 1250000 -> '1.3M'. No Intl: deterministic. */
export function compact(n) {
  if (n < 1000) return String(n)
  for (const [u, s, next] of [
    [1e3, 'k', 1e6],
    [1e6, 'M', 1e9],
    [1e9, 'B', Infinity],
  ]) {
    if (n >= next) continue
    const v = n / u
    const str = v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(v))
    if (+str >= 1000 && next !== Infinity) continue // 999,950 rounds to 1M, not 1000k
    return str + s
  }
}

// Common languages' usual swatches; anything else gets a stable colour from its name.
const LANG_COLORS = {
  typescript: 0x3178c6, javascript: 0xf1e05a, rust: 0xdea584, python: 0x3572a5, go: 0x00add8, c: 0x555555,
  'c++': 0xf34b7d, 'c#': 0x178600, java: 0xb07219, kotlin: 0xa97bff, swift: 0xf05138, ruby: 0x701516,
  php: 0x4f5d95, zig: 0xec915c, elixir: 0x6e4a7e, dart: 0x00b4ab, scala: 0xc22d40, haskell: 0x5e5086,
  ocaml: 0xef7a08, lua: 0x000080, html: 0xe34c26, css: 0x563d7c, scss: 0xc6538c, shell: 0x89e051,
  vue: 0x41b883, svelte: 0xff3e00, mdx: 0xfcb32c, nix: 0x7e7eff, julia: 0xa270ba, r: 0x198ce7,
  'objective-c': 0x438eff, solidity: 0xaa6746, astro: 0xff5a03, gleam: 0xffaff3, wasm: 0x04133b,
}
const SPARE = [0x8b5cf6, 0x14b8a6, 0xec4899, 0x84cc16, 0xf97316, 0x06b6d4, 0xeab308, 0x6366f1]

/** "TypeScript:72,Rust:20" -> [{ name, share (0..1), color }], at most 8, shares normalized. */
function parseLangs(q, theme) {
  const raw = q.lang ? [{ name: q.lang, v: 100, color: q.langColor ? hex(q.langColor) : null }] : []
  if (!raw.length)
    for (const part of q.langs.split(',').slice(0, 8)) {
      const [name, v, c] = part.split(':').map((x) => x.trim())
      if (!name) continue
      const n = Number(v)
      raw.push({ name: name.slice(0, 24), v: v && Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : v ? 0 : 1, color: /^#?[0-9a-f]{6}$/i.test(c ?? '') ? hex(c) : null })
    }
  const items = raw.filter((l) => l.v > 0)
  const sum = items.reduce((a, l) => a + l.v, 0)
  return items.map((l) => {
    const key = l.name.toLowerCase()
    const color = l.color ?? (key === 'other' ? mix(theme.muted, theme.bg, 0.25) : LANG_COLORS[key] ?? SPARE[Math.floor(prng(key)() * SPARE.length)])
    return { name: l.name, share: l.v / sum, color }
  })
}

/** '2.4%', '72%', '0.4%'. */
const pct = (share) => {
  const v = share * 100
  return `${v >= 10 || Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1)}%`
}

/** Catmull-Rom through the points, sampled densely: [[x, y], ...]. (As in metric.) */
function spline(pts, perSeg = 40) {
  const out = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg
      const t2 = t * t
      const t3 = t2 * t
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** A polyline as a filled outline `w` px wide with round caps (there is no stroke API). */
function strokePolygon(pts, w) {
  const h = w / 2
  const left = []
  const right = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    let nx = -(b[1] - a[1])
    let ny = b[0] - a[0]
    const l = Math.hypot(nx, ny) || 1
    nx /= l
    ny /= l
    left.push([pts[i][0] + nx * h, pts[i][1] + ny * h])
    right.push([pts[i][0] - nx * h, pts[i][1] - ny * h])
  }
  const cmds = [0, left[0][0], left[0][1]]
  for (const [x, y] of left.slice(1)) cmds.push(1, x, y)
  for (const [x, y] of right.reverse()) cmds.push(1, x, y)
  cmds.push(4)
  return [...cmds, ...ellipse(pts[0][0], pts[0][1], h), ...ellipse(pts[pts.length - 1][0], pts[pts.length - 1][1], h)]
}

/** A five-point star centred on (0, 0). */
function starPath(r) {
  const out = []
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    const rr = i % 2 ? r * 0.48 : r
    out.push(i ? 1 : 0, Math.cos(a) * rr, Math.sin(a) * rr)
  }
  out.push(4)
  return out
}

/**
 * Line icons in a 20 px box centred on (0, 0), as sprite layers (one per stroke, so overlapping
 * strokes never cancel under the winding rule). Rings are even-odd circle pairs.
 */
function iconLayers(kind, color, cx, cy) {
  const w = 1.7
  const at = (cmds) => transform(cmds, 1, cx, cy)
  const ringAt = (x, y, r) => ({ cmds: at([...ellipse(x, y, r + w / 2), ...ellipse(x, y, r - w / 2)]), color, evenodd: true })
  const line = (pts) => ({ cmds: at(strokePolygon(pts, w)), color })
  if (kind === 'fork')
    return [ringAt(-5, -6.5, 2.4), ringAt(5, -6.5, 2.4), ringAt(0, 6.5, 2.4), line([[-5, -4.1], [-5, -1.6], [0, 1.4]]), line([[5, -4.1], [5, -1.6], [0, 1.4]]), line([[0, 1.4], [0, 4.1]])]
  if (kind === 'download')
    return [line([[0, -8], [0, 3]]), line([[-4.5, -1.5], [0, 3]]), line([[4.5, -1.5], [0, 3]]), line([[-8, 3.5], [-8, 7.5]]), line([[-8, 7.5], [8, 7.5]]), line([[8, 7.5], [8, 3.5]])]
  if (kind === 'trend')
    return [line([[-8, 5], [-3, -0.5], [1, 2.5], [8, -5]]), line([[3.5, -5], [8, -5]]), line([[8, -5], [8, -0.5]])]
  return [{ cmds: at(starPath(9.5)), color }]
}

function setup(ctx, q) {
  const { text } = ctx
  const theme = THEMES[q.theme]
  const dark = q.theme === 'dark'
  const accent = hex(q.accent)
  const bg = background(ctx, theme, accent, { glowAt: [W * 0.9, -60], radius: 820 })
  const soft = mix(theme.fg, theme.muted, 0.4) // description
  const ease = (name) => gsap.parseEase(name)
  const items = [] // { done(): bool, still(g), live(g) }: drawn in this order

  // ---------------------------------------------------------------- header
  const avail = W - 2 * PAD_X - PILL_ROOM
  const ls = (size) => ({ letterSpacing: -0.025 * size })
  let hs = 64
  let ownerRun = null
  let slashRun = null
  let nameRun = null
  for (hs of [64, 56, 48, 42]) {
    ownerRun = q.owner ? text.run('regular', q.owner, hs, ls(hs)) : null
    slashRun = q.owner ? text.run('regular', '/', hs, ls(hs)) : null
    nameRun = text.run('semibold', q.name, hs, ls(hs))
    if ((ownerRun ? ownerRun.advance + slashRun.advance + 2 : 0) + nameRun.advance <= avail) break
  }
  if ((ownerRun ? ownerRun.advance + slashRun.advance + 2 : 0) + nameRun.advance > avail) {
    // Still too long at the smallest size: the owner gets at most 40%, the name the rest.
    if (ownerRun) ownerRun = text.fit('regular', q.owner, hs, Math.max(avail * 0.4, avail - nameRun.advance - slashRun.advance - 2), ls(hs))
    nameRun = text.fit('semibold', q.name, hs, avail - (ownerRun ? ownerRun.advance + slashRun.advance + 2 : 0), ls(hs))
  }
  const slashX = PAD_X + (ownerRun ? ownerRun.advance + 1 : 0)
  const nameX = Math.round((ownerRun ? slashX + slashRun.advance + 1 : PAD_X) * 4) / 4
  const owner = ownerRun
    ? ctx.sprite(
        [
          { cmds: ownerRun.cmds(PAD_X, NAME_BASE), color: theme.muted },
          { cmds: slashRun.cmds(slashX, NAME_BASE), color: mix(theme.muted, theme.bg, 0.35) },
        ],
        { margin: 4 },
      )
    : null
  const name = ctx.sprite([{ cmds: nameRun.cmds(nameX, NAME_BASE), color: theme.fg }], { margin: 4 })
  const headTop = Math.floor(NAME_BASE - hs * 0.95)
  const headBot = Math.ceil(NAME_BASE + hs * 0.3)
  const s = { owner: { p: 0 }, name: { y: 1, o: 0 } }
  const tl = gsap.timeline({ paused: true })
  if (owner) {
    tl.fromTo(s.owner, { p: 0 }, { p: 1, duration: 0.55, ease: 'expo.out' }, 0.05)
    items.push({
      done: () => s.owner.p >= 1,
      still: (g) => g.draw(owner),
      live: (g) => s.owner.p > 0 && g.draw(owner, { opacity: Math.min(1, s.owner.p * 1.5), clip: [0, 0, PAD_X + (nameX - PAD_X + 8) * s.owner.p, H] }),
    })
  }
  tl.fromTo(s.name, { y: 1 }, { y: 0, duration: 0.6, ease: 'expo.out' }, 0.16)
  tl.fromTo(s.name, { o: 0 }, { o: 1, duration: 0.3, ease: 'power2.out' }, 0.16)
  items.push({
    done: () => s.name.y <= 0 && s.name.o >= 1,
    still: (g) => g.draw(name),
    // Rises out of the header band by whole pixels, so each frame is a copy.
    live: (g) => s.name.o > 0 && g.draw(name, { opacity: s.name.o, transform: [1, 0, 0, 1, 0, Math.round(s.name.y * hs * 0.6)], clip: [0, headTop, W, headBot] }),
  })

  // ---------------------------------------------------------------- version pill
  const ver = q.version.replace(/^v/i, '')
  if (ver) {
    const vs = 21
    const vRun = text.fit('mono', `v${ver}`, vs, PILL_ROOM - 40)
    const pw = Math.ceil(vRun.advance + 30)
    const ph = 40
    const cx = W - PAD_X - pw / 2
    const cy = Math.round(NAME_BASE - hs * 0.36)
    const parts = [
      { path: ctx.path(rrect(-pw / 2, -ph / 2, pw, ph, ph / 2)), color: accent },
      { path: ctx.path(vRun.cmds(-pw / 2 + 15, text.baselineIn('mono', vs, ph) - ph / 2)), color: onColor(accent) },
    ]
    s.ver = { k: 0 }
    tl.fromTo(s.ver, { k: 0 }, { k: 1, duration: 0.5, ease: 'back.out(2)' }, 0.72)
    items.push({
      done: () => s.ver.k >= 1,
      still: (g) => parts.forEach((pt) => g.fill(pt.path, pt.color, { transform: affine(cx, cy) })),
      live: (g) => s.ver.k > 0 && parts.forEach((pt) => g.fill(pt.path, pt.color, { alpha: Math.min(1, s.ver.k * 2), transform: affine(cx, cy, 0, 0.6 + 0.4 * s.ver.k) })),
    })
  }

  // ---------------------------------------------------------------- description
  const ds = 30
  const dWidth = W - 2 * PAD_X - 60
  const dLines = q.desc
    ? text.wrap('regular', q.desc, ds, dWidth, { maxLines: 2 }).map((line) => {
        // A word longer than the line (a URL, a hash) is cut with an ellipsis rather than overflowing.
        if (line.width <= dWidth + 1) return line.words.map((w) => ({ run: w.run, x: w.x }))
        const str = line.words.map((w) => w.text).join(' ')
        return [{ run: text.fit('regular', str, ds, dWidth), x: 0 }]
      })
    : []
  let y = NAME_BASE + 66
  dLines.forEach((words, i) => {
    const base = y + i * 40
    const right = Math.max(...words.map((w) => w.x + w.run.advance))
    const sp = ctx.sprite(words.map((w) => ({ cmds: w.run.cmds(PAD_X + w.x, base), color: soft })), { margin: 4 })
    const st = (s[`d${i}`] = { p: 0 })
    tl.fromTo(st, { p: 0 }, { p: 1, duration: 0.7, ease: 'expo.out' }, 0.68 + i * 0.1)
    items.push({
      done: () => st.p >= 1,
      still: (g) => g.draw(sp),
      live: (g) => st.p > 0 && g.draw(sp, { opacity: Math.min(1, st.p * 1.6), clip: [0, 0, PAD_X + (right + 12) * st.p, H] }),
    })
  })
  const descEnd = dLines.length ? y + (dLines.length - 1) * 40 : NAME_BASE

  // ---------------------------------------------------------------- topics
  const topics = q.topics
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12)
  const tsz = 18
  const th = 34
  const tTop = descEnd + 30
  const tFill = mix(theme.bg, accent, dark ? 0.16 : 0.14)
  const tInk = dark ? mix(accent, theme.fg, 0.35) : mix(accent, theme.fg, 0.55)
  const pills = []
  {
    let x = PAD_X
    const more = (n) => text.run('semibold', `+${n}`, tsz)
    for (let i = 0; i < topics.length; i++) {
      const run = text.fit('semibold', topics[i], tsz, 260)
      const w = Math.ceil(run.advance + 28)
      const rest = topics.length - i - 1
      const reserve = rest ? Math.ceil(more(rest).advance + 28) + 10 : 0
      if (x + w + reserve > W - PAD_X) {
        pills.push({ run: more(topics.length - i), w: Math.ceil(more(topics.length - i).advance + 28), x, muted: true })
        break
      }
      pills.push({ run, w, x })
      x += w + 10
    }
  }
  pills.forEach((pl, i) => {
    const cx = pl.x + pl.w / 2
    const cy = tTop + th / 2
    const parts = [
      { path: ctx.path(rrect(-pl.w / 2, -th / 2, pl.w, th, th / 2)), color: pl.muted ? mix(theme.bg, theme.muted, 0.18) : tFill },
      { path: ctx.path(pl.run.cmds(-pl.w / 2 + 14, text.baselineIn('semibold', tsz, th) - th / 2)), color: pl.muted ? theme.muted : tInk },
    ]
    const st = (s[`t${i}`] = { k: 0 })
    tl.fromTo(st, { k: 0 }, { k: 1, duration: 0.5, ease: 'back.out(2.2)' }, 1.55 + i * 0.07)
    items.push({
      done: () => st.k >= 1,
      still: (g) => parts.forEach((pt) => g.fill(pt.path, pt.color, { transform: affine(cx, cy) })),
      live: (g) => st.k > 0 && parts.forEach((pt) => g.fill(pt.path, pt.color, { alpha: Math.min(1, st.k * 2), transform: affine(cx, cy, 0, 0.5 + 0.5 * st.k) })),
    })
  })

  // The lower block (stats, chart, languages) moves up by half of whatever a short description or
  // missing topics leave free, so a sparse card stays balanced. The header never moves.
  const contentEnd = pills.length ? tTop + th : dLines.length ? descEnd : NAME_BASE
  const lift = Math.max(0, Math.round((NAME_BASE + 66 + 40 + 30 + th - contentEnd) / 2))
  const LB = LABEL_BASE - lift
  const NB = NUM_BASE - lift
  const barY = BAR.y - lift
  const LG = LEGEND_BASE - lift

  // ---------------------------------------------------------------- stats
  const series = q.series
    .replace(/[[\]]/g, '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite)
    .map((v) => Math.min(Math.max(v, 0), 1e12)) // keeps the milestone maths exact
    .slice(-64)
  const hasChart = series.length >= 2
  const lsz = 18
  const labelOf = (kind, str, x, base, color = theme.muted) => {
    const run = text.run('semibold', str, lsz)
    return { sprite: ctx.sprite([...iconLayers(kind, kind === 'star' ? accent : color, x + 10, base - 6.5), { cmds: run.cmds(x + 28, base), color }], { margin: 3 }), w: 28 + run.advance }
  }
  const digitCache = new Map()
  const digits = (size) => {
    if (!digitCache.has(size)) digitCache.set(size, [...'0123456789'].map((d) => ctx.path(text.run('semibold', d, size, { features: { tnum: true } }).cmds(0, 0))))
    return digitCache.get(size)
  }
  /** An odometer for `str` at (x, base): digit slots that roll into place, the rest fades in. */
  const odometer = (str, size) => {
    const run = text.run('semibold', str, size, { features: { tnum: true }, letterSpacing: -0.03 * size })
    return { str, size, run, w: run.advance }
  }
  const placeOdometer = (od, x, base, at, key) => {
    const { run, size } = od
    const chars = [...od.str]
    const xs = chars.map((_, i) => Math.round((x + (i ? run.rightOf(i - 1) : 0)) * 4) / 4)
    const slots = []
    const statics = []
    chars.forEach((c, i) => (c >= '0' && c <= '9' ? slots.push({ x: xs[i], d: +c }) : statics.push(i)))
    const full = ctx.sprite([{ cmds: run.cmds(x, base), color: theme.fg }], { margin: 4 })
    const rest = statics.length ? ctx.sprite(statics.map((i) => ({ cmds: run.cmds(x, base, i), color: theme.fg })), { margin: 4 }) : null
    const paths = digits(size)
    const win = [x - 10, Math.floor(base - size * 0.8), Math.ceil(x + run.advance + 10), Math.ceil(base + size * 0.08)]
    const st = (s[key] = { pos: slots.map(() => ({ p: -1 })), o: 0 })
    // Each slot rolls up from blank; the last two make an extra full turn, like an odometer's fast wheels.
    slots.forEach((sl, i) => {
      sl.target = sl.d + (i >= slots.length - 2 ? 10 : 0)
      tl.fromTo(st.pos[i], { p: -1 }, { p: sl.target, duration: 1.5, ease: 'power3.out' }, at + i * 0.08)
    })
    if (rest) tl.fromTo(st, { o: 0 }, { o: 1, duration: 0.4, ease: 'power2.out' }, at + 0.3)
    items.push({
      done: () => slots.every((sl, i) => st.pos[i].p >= sl.target) && (!rest || st.o >= 1),
      still: (g) => g.draw(full),
      live: (g) => {
        slots.forEach((sl, i) => {
          const pos = st.pos[i].p
          const n = Math.floor(pos)
          const frac = pos - n
          for (const [d, off] of [
            [n, -frac],
            [n + 1, 1 - frac],
          ]) {
            if (d < 0 || off >= 0.8 || off <= -0.8) continue
            g.fill(paths[d % 10], theme.fg, { transform: affine(sl.x, base + off * size), clip: win })
          }
        })
        if (rest && st.o > 0) g.draw(rest, { opacity: st.o })
      },
    })
  }
  const placeText = (str, size, x, base, at, key) => {
    const run = text.run('semibold', str, size, { letterSpacing: -0.02 * size })
    const sp = ctx.sprite([{ cmds: run.cmds(x, base), color: theme.fg }], { margin: 4 })
    const st = (s[key] = { p: 0 })
    tl.fromTo(st, { p: 0 }, { p: 1, duration: 0.8, ease: 'expo.out' }, at)
    items.push({
      done: () => st.p >= 1,
      still: (g) => g.draw(sp),
      live: (g) => st.p > 0 && g.draw(sp, { opacity: Math.min(1, st.p * 1.5), clip: [0, 0, x + (run.advance + 10) * st.p, H] }),
    })
  }
  const placeLabel = (lb, at, key) => {
    const st = (s[key] = { o: 0 })
    tl.fromTo(st, { o: 0 }, { o: 1, duration: 0.45, ease: 'power2.out' }, at)
    items.push({ done: () => st.o >= 1, still: (g) => g.draw(lb.sprite), live: (g) => st.o > 0 && g.draw(lb.sprite, { opacity: st.o }) })
  }

  // Secondary stats: forks (hidden at 0) and downloads.
  const extras = []
  if (q.forks > 0) extras.push({ kind: 'fork', label: 'Forks', str: compact(q.forks), odo: true })
  if (q.downloads) extras.push({ kind: 'download', label: 'Downloads', str: q.downloads, odo: false })

  // Layout: with a chart the extras stack in one column and the chart takes the rest of the row;
  // without, everything sits in one row. The star count shrinks until it fits.
  const starStr = compact(q.stars)
  let hero
  let layout
  for (const size of [112, 100, 88, 76]) {
    hero = odometer(starStr, size)
    const heroW = Math.max(hero.w, 90)
    if (hasChart) {
      const ev = 36
      const colW = Math.max(0, ...extras.map((e) => Math.max(text.run('semibold', e.str, ev).advance, 28 + text.run('semibold', e.label, lsz).advance)))
      const colX = Math.round(PAD_X + heroW + 64)
      const chartX = Math.round(extras.length ? colX + colW + 64 : colX)
      layout = { colX, ev, chartX }
      if (W - PAD_X - chartX >= 300) break
    } else {
      const ev = Math.round(size * 0.57)
      let x = Math.round(PAD_X + heroW + 72)
      const xs = extras.map((e) => {
        const at = x
        x = Math.round(x + Math.max(text.run('semibold', e.str, ev).advance, 28 + text.run('semibold', e.label, lsz).advance) + 72)
        return at
      })
      layout = { xs, ev }
      if (x - 72 <= W - PAD_X) break
    }
  }
  placeLabel(labelOf('star', 'Stars', PAD_X, LB), 0.9, 'lStars')
  placeOdometer(hero, PAD_X, NB, 0.95, 'stars')
  extras.forEach((e, i) => {
    const x = hasChart ? layout.colX : layout.xs[i]
    const lb = hasChart ? LB + i * 82 : LB
    const vb = hasChart ? LB + 46 + i * 76 : NB
    const at = 1.05 + i * 0.12
    placeLabel(labelOf(e.kind, e.label, x, lb), at, `l${i}`)
    if (e.odo) placeOdometer(odometer(e.str, layout.ev), x, vb, at + 0.1, `v${i}`)
    else placeText(e.str, layout.ev, x, vb, at + 0.15, `v${i}`)
  })

  // ---------------------------------------------------------------- star history chart
  let chartItems = null
  if (hasChart) chartItems = chart(ctx, q, { theme, accent, x0: layout.chartX, x1: W - PAD_X, y0: CHART.y0 - lift, y1: CHART.y1 - lift, labelBase: LB, series, s, tl, labelOf, placeLabel })

  // ---------------------------------------------------------------- language bar + legend
  const langs = parseLangs(q, theme)
  if (langs.length) {
    const bx0 = PAD_X
    const bx1 = W - PAD_X
    const bw = bx1 - bx0
    const gap = 3
    const segs = []
    let acc = 0
    langs.forEach((l, i) => {
      const a = bx0 + bw * acc
      acc += l.share
      const b = i === langs.length - 1 ? bx1 : bx0 + bw * acc
      segs.push({ a, b, color: l.color })
    })
    const barLayers = segs.map((sg, i) => ({ cmds: rect(sg.a + (i ? gap / 2 : 0), barY, Math.max(sg.a + (i ? gap / 2 : 0) + 3, sg.b - (i < segs.length - 1 ? gap / 2 : 0)), barY + BAR.h), color: sg.color }))
    const barSprite = ctx.clip(ctx.sprite(barLayers, { margin: 1 }), rrect(bx0, barY, bw, BAR.h, BAR.h / 2))
    const track = ctx.sprite([{ cmds: rrect(bx0, barY, bw, BAR.h, BAR.h / 2), color: dark ? mix(theme.bg, 0xffffff, 0.07) : mix(theme.bg, 0x000000, 0.07) }], { margin: 1 })
    const BAR_AT = 1.15
    const BAR_DUR = 1.4
    const st = (s.bar = { p: 0 })
    tl.fromTo(st, { p: 0 }, { p: 1, duration: BAR_DUR, ease: 'expo.inOut' }, BAR_AT)
    items.push({
      done: () => st.p >= 1,
      still: (g) => {
        g.draw(track)
        g.draw(barSprite)
      },
      live: (g) => {
        if (st.p <= 0) return
        g.draw(track, { opacity: Math.min(1, st.p * 6) })
        g.draw(barSprite, { clip: [0, 0, bx0 + bw * st.p, H] })
      },
    })

    // Legend: each entry fades in as the fill reaches its segment.
    const fill = ease('expo.inOut')
    const timeAt = (frac) => {
      let lo = 0
      let hi = 1
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2
        if (fill(mid) < frac) lo = mid
        else hi = mid
      }
      return BAR_AT + lo * BAR_DUR
    }
    let x = PAD_X
    let start = 0
    langs.forEach((l, i) => {
      const nRun = text.run('semibold', l.name, 18)
      const pRun = text.run('regular', pct(l.share), 18)
      const w = 18 + nRun.advance + 8 + pRun.advance
      const segStart = start
      start += l.share
      if (x + w > W - PAD_X) return
      const sp = ctx.sprite(
        [
          { cmds: rrect(x, LG - 13, 11, 11, 3), color: l.color },
          { cmds: nRun.cmds(x + 18, LG), color: theme.fg },
          { cmds: pRun.cmds(x + 18 + nRun.advance + 8, LG), color: theme.muted },
        ],
        { margin: 3 },
      )
      const lx = x
      x = Math.round(x + w + 28)
      const ls = (s[`g${i}`] = { o: 0 })
      tl.fromTo(ls, { o: 0 }, { o: 1, duration: 0.5, ease: 'power2.out' }, timeAt(Math.min(0.98, segStart + 0.01)) + 0.05)
      items.push({
        done: () => ls.o >= 1,
        still: (g) => g.draw(sp),
        live: (g) => ls.o > 0 && g.draw(sp, { opacity: ls.o, clip: [lx - 4, 0, lx + 8 + (w + 8) * ls.o, H] }),
      })
    })
  }

  if (chartItems) items.push(...chartItems)
  tl.seek(0)

  // ---------------------------------------------------------------- frames
  return {
    state(i) {
      tl.seek(i / ctx.fps, false)
      return s
    },
    draw(g) {
      const done = items.map((it) => it.done())
      g.layer('bg', () => g.draw(bg))
      g.layer(done.map((d) => (d ? 1 : 0)).join(''), () => items.forEach((it, i) => done[i] && it.still(g)))
      items.forEach((it, i) => !done[i] && it.live(g))
    },
    dispose: () => tl.kill(),
  }
}

/**
 * The star history: a growth line with a gradient area, drawn left to right with a glowing head.
 * Round-number milestones the line crosses get a tick and a label that flash as the head passes.
 * Returns its items; the label goes through placeLabel like the stats'.
 */
function chart(ctx, q, { theme, accent, x0, x1, y0, y1, labelBase, series, s, tl, labelOf, placeLabel }) {
  const { text } = ctx

  const C_AT = 1.2
  const C_DUR = 2.0
  const out = []
  placeLabel(labelOf('trend', 'Star history', x0, labelBase), 1.15, 'lChart')

  let hi = Math.max(...series)
  let lo = Math.min(...series)
  if (lo >= 0 && lo < hi * 0.3) lo = 0
  if (hi - lo < 1e-9) {
    hi += 1
    lo -= 1
  }
  const yOf = (v) => y1 - 4 - ((v - lo) / (hi - lo)) * (y1 - y0 - 14)
  const pts = series.map((v, i) => [x0 + ((x1 - x0) * i) / (series.length - 1), yOf(v)])
  const curve = spline(pts, Math.max(6, Math.round(400 / series.length))).map(([x, y]) => [x, Math.min(y1 - 2, Math.max(y0 - 4, y))]) // no overshoot past the axis
  const colY = new Float32Array(x1 - x0 + 1)
  {
    let j = 0
    for (let x = x0; x <= x1; x++) {
      while (j < curve.length - 2 && curve[j + 1][0] < x) j++
      const [ax, ay] = curve[j]
      const [bx, by] = curve[j + 1]
      colY[x - x0] = ay + (by - ay) * (bx > ax ? Math.min(1, Math.max(0, (x - ax) / (bx - ax))) : 0)
    }
  }
  const areaTop = Math.floor(Math.min(...colY)) - 2
  const areaH = y1 - areaTop
  const [ar, ag, ab] = [(accent >> 16) & 255, (accent >> 8) & 255, accent & 255]
  const area = ctx.bitmap(x0, areaTop, x1 - x0 + 1, areaH, (px, bw, bh) => {
    for (let x = 0; x < bw; x++) {
      const top = colY[x] - areaTop
      for (let y = 0; y < bh; y++) {
        const cover = Math.max(0, Math.min(1, y + 1 - top))
        if (cover <= 0) continue
        const t = (y - top) / (bh - top)
        const a = cover * 0.28 * Math.max(0, 1 - t) ** 1.5
        const o = (y * bw + x) * 4
        px[o] = Math.round(ar * a)
        px[o + 1] = Math.round(ag * a)
        px[o + 2] = Math.round(ab * a)
        px[o + 3] = Math.round(255 * a)
      }
    }
  })
  const line = ctx.sprite([{ cmds: strokePolygon(curve, 3.5), color: accent }], { margin: 4 })
  const base = ctx.sprite([{ cmds: rect(x0, y1, x1, y1 + 1), color: theme.muted, alpha: 0.45 }], { margin: 1 })
  const yAt = (x) => colY[Math.max(0, Math.min(x1 - x0, Math.round(x - x0)))]

  // When the head reaches x: invert the wipe's ease.
  const wipe = gsap.parseEase('power2.inOut')
  const timeAt = (x) => {
    const frac = (x - x0) / (x1 - x0)
    let a = 0
    let b = 1
    for (let k = 0; k < 24; k++) {
      const m = (a + b) / 2
      if (wipe(m) < frac) a = m
      else b = m
    }
    return C_AT + a * C_DUR
  }

  const st = (s.chart = { p: 0, head: 0, pulse: 0 })
  tl.fromTo(st, { p: 0 }, { p: 1, duration: C_DUR, ease: 'power2.inOut' }, C_AT)
  tl.fromTo(st, { head: 0 }, { head: 1, duration: 0.25, ease: 'power2.out' }, C_AT)
  tl.fromTo(st, { pulse: 0 }, { pulse: 1, duration: 0.9, ease: 'power2.out' }, C_AT + C_DUR)
  const headX = () => x0 + (x1 - x0) * st.p
  out.push({
    done: () => st.p >= 1,
    still: (g) => {
      g.draw(base)
      g.draw(area)
      g.draw(line)
    },
    live: (g) => {
      g.draw(base, { opacity: Math.min(1, st.p * 8), clip: [0, 0, x0 + (x1 - x0) * Math.min(1, st.p * 3), H] })
      if (st.p <= 0) return
      g.draw(area, { clip: [0, 0, headX(), H] })
      g.draw(line, { clip: [0, 0, headX(), H] })
    },
  })

  // Milestones: multiples of a round step (1, 2, 2.5 or 5 x 10^n) giving at least two inside the
  // range; the top three the line actually crosses, spaced so their labels never collide.
  let step = 1
  for (let e = 0; e < 10; e++) for (const f of e ? [1, 2, 2.5, 5] : [1, 2, 5]) if (Math.floor(hi / (f * 10 ** e)) >= 2) step = f * 10 ** e
  const marks = []
  for (let m = Math.floor(hi / step) * step, n = 0; m > lo + (hi - lo) * 0.1 && marks.length < 3 && n < 64; m -= step, n++) {
    const target = yOf(m)
    let cx = -1
    for (let x = 0; x < colY.length; x++)
      if (colY[x] <= target) {
        cx = x0 + x
        break
      }
    if (cx < 0 || cx > x1 - 6 || marks.some((mk) => Math.abs(mk.x - cx) < 84)) continue
    marks.push({ v: m, x: cx, y: yAt(cx) })
  }
  const ring = ctx.path([...ellipse(0, 0, 7), ...ellipse(0, 0, 4.5)])
  const dot = ctx.path(ellipse(0, 0, 3.2))
  const flash = ctx.path([...ellipse(0, 0, 12), ...ellipse(0, 0, 9.5)])
  const halo = ctx.path(ellipse(0, 0, 18))
  const lblFill = mix(theme.bg, accent, q.theme === 'dark' ? 0.2 : 0.16)
  const lblInk = q.theme === 'dark' ? mix(accent, theme.fg, 0.3) : mix(accent, theme.fg, 0.55)
  marks
    .sort((a, b) => a.x - b.x)
    .forEach((mk, i) => {
      const run = text.run('semibold', compact(mk.v), 16)
      const lw = Math.ceil(run.advance + 18)
      const lh = 24
      // Above and left of the crossing, where a rising line leaves room.
      const lx = Math.round(Math.max(x0, mk.x - 10 - lw))
      const ly = Math.round(Math.max(y0 - 12, mk.y - 12 - lh))
      const sprite = ctx.sprite(
        [
          { cmds: rect(Math.round(mk.x), Math.round(mk.y + 8), Math.round(mk.x) + 1, y1), color: accent, alpha: 0.4 },
          { cmds: rrect(lx, ly, lw, lh, lh / 2), color: lblFill },
          { cmds: run.cmds(lx + 9, ly + text.baselineIn('semibold', 16, lh)), color: lblInk },
        ],
        { margin: 2 },
      )
      const ms = (s[`m${i}`] = { k: 0, f: 0 })
      const at = timeAt(mk.x)
      tl.fromTo(ms, { k: 0 }, { k: 1, duration: 0.45, ease: 'back.out(2.4)' }, at)
      tl.fromTo(ms, { f: 0 }, { f: 1, duration: 0.7, ease: 'power2.out' }, at)
      const pin = (g, k = 1, alpha = 1) => {
        g.fill(ring, accent, { alpha, transform: affine(mk.x, mk.y, 0, k), evenodd: true })
        g.fill(dot, theme.bg, { alpha, transform: affine(mk.x, mk.y, 0, k) })
      }
      out.push({
        done: () => ms.k >= 1 && ms.f >= 1,
        still: (g) => {
          g.draw(sprite)
          pin(g)
        },
        live: (g) => {
          if (ms.k <= 0) return
          g.draw(sprite, { opacity: Math.min(1, ms.k * 1.5), transform: [1, 0, 0, 1, 0, Math.round((1 - Math.min(1, ms.k)) * 10)] })
          pin(g, 0.4 + 0.6 * ms.k, Math.min(1, ms.k * 2))
          if (ms.f < 1) {
            g.fill(halo, accent, { alpha: 0.35 * (1 - ms.f), transform: affine(mk.x, mk.y, 0, 0.6 + ms.f) })
            g.fill(flash, accent, { alpha: 0.9 * (1 - ms.f), transform: affine(mk.x, mk.y, 0, 0.6 + ms.f * 1.8), evenodd: true })
          }
        },
      })
    })

  // The head: glow, ring and dot riding the line; one pulse when it lands, then baked.
  const hRing = ctx.path(ellipse(0, 0, 10))
  const hDot = ctx.path(ellipse(0, 0, 5.5))
  const hHalo = ctx.path(ellipse(0, 0, 22))
  const pulse = ctx.path([...ellipse(0, 0, 12), ...ellipse(0, 0, 9)])
  const head = (g, x, o) => {
    const y = yAt(x)
    g.fill(hHalo, accent, { alpha: 0.2 * o, transform: affine(x, y) })
    g.fill(hRing, theme.bg, { alpha: o, transform: affine(x, y) })
    g.fill(hDot, accent, { alpha: o, transform: affine(x, y) })
  }
  out.push({
    done: () => st.p >= 1 && st.pulse >= 1,
    still: (g) => head(g, x1, 1),
    live: (g) => {
      if (st.head <= 0) return
      head(g, headX(), st.head)
      const pp = st.pulse
      if (pp > 0 && pp < 1) g.fill(pulse, accent, { alpha: 0.7 * (1 - pp), transform: affine(x1, yAt(x1), 0, 1 + pp * 2.4), evenodd: true })
    },
  })
  return out
}
