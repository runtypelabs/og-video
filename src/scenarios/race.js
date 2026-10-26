// race: a bar chart race. A ranking evolves over a few periods (years, quarters, releases): the
// axis draws down, the title wipes on, the bars grow in at the first period's values, then the
// race runs through every period. Values interpolate continuously and their labels count with
// them, rows slide between rank slots whenever one entry overtakes another, the scale (and its
// fading gridlines) follows the current leader, and a big period counter flips in the corner.
// It ends holding on the final ranking with the leader's row lit, which is also the poster.
//
// The first 30 frames (0.5 s, the axis) depend only on accent and theme: the label column has a
// fixed width, so the axis sits in the same place for every dataset.
//
// Everything the race does is precomputed in setup, per frame, from frame 0 (values, the eased
// rank positions, the smoothed scale), so state(i) is a lookup that gives the same answer
// whatever frame a render starts from. Positions and lengths are whole pixels, so a row that
// only slides is a copy and a finished race gives identical hold frames that are skipped.
// Nearly everything live is a sprite drawn at a whole-pixel offset, which is a copy: a bar is a
// full-length body clipped to its length plus its rounded end moved to the tip, value and tick
// labels are tabular-figure glyph sprites (four quarter-pixel phases each) built once, and names
// slide as whole sprites. The backdrop, title, track and rank column settle into a cached layer.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p, ParamError } from '../schema.js'
import { rrect, rect } from '../gfx.js'
import { W, H, THEMES, background, mix, hex, affine } from './showcase-kit.js'

const PAD_X = 72
const TITLE_BASE = 92
const COUNTER_SIZE = 72
const COUNTER_BASE = 104
const Y0 = 150 // rows region
const Y1 = 566
const TICK_GAP = 28 // tick value baselines below the last row
const RANK_R = PAD_X + 26 // right edge of the rank numbers
const LABEL_W = 200
const X0 = RANK_R + 18 + LABEL_W + 14 // the axis; bars start here
const GROW_AT = 0.6
const RACE_AT = 1.7
const SEG_MAX = 1.6 // seconds per period at most
const RACE_MAX = 4.4
const SLIDE = 0.5 // seconds for a row to move to its new rank
const FLIP = 0.3 // seconds for the period counter to flip

// Muted tones for the entries that are not highlighted, mixed towards the theme's bar grey.
const TINTS = [0x38bdf8, 0xa78bfa, 0xfbbf24, 0xfb7185, 0x34d399, 0xf97316, 0x818cf8, 0xa3e635, 0xf472b6, 0x22d3ee, 0xe879f9, 0xfacc15]

/** One entry's values, one per period: a JSON array, or a comma-separated string ("12,40,95"). */
function series() {
  const s = p.array(p.number({ min: 0, max: 1e12 }), { min: 2, max: 8 })
  const parse = s.parse
  s.parse = (v, path) => parse(typeof v === 'string' && !/^\s*\[/.test(v) ? v.split(',') : v, path)
  return s
}

/** Cross-field checks a field schema cannot make: every row has one value per period. */
function checked(schema) {
  const parse = schema.parse
  schema.parse = (v, path = []) => {
    const q = parse(v, path)
    if (q.values.length !== q.labels.length) throw new ParamError(`expected ${q.labels.length} rows, one per label (got ${q.values.length})`, [...path, 'values'])
    q.values.forEach((row, i) => {
      if (row.length !== q.periods.length) throw new ParamError(`expected ${q.periods.length} numbers, one per period (got ${row.length})`, [...path, 'values', i])
    })
    if (q.highlight && q.highlight !== 'none' && !q.labels.includes(q.highlight)) throw new ParamError('expected one of labels, "none" or empty', [...path, 'highlight'])
    return q
  }
  return schema
}

export const race = defineScenario({
  id: 'race',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  params: checked(
    p.object({
      title: p.string({ max: 60, default: 'Most-starred web frameworks' }),
      labels: p.array(p.string({ min: 1, max: 32 }), { min: 2, max: 12, default: ['Arbor', 'Kestrel', 'Lumen', 'Quill', 'Helix', 'Tidal', 'Nimbus'] }),
      periods: p.array(p.string({ min: 1, max: 10 }), { min: 2, max: 8, default: ['2021', '2022', '2023', '2024', '2025', '2026'] }),
      // One row per label (spreadsheet layout: entries down, periods across).
      values: p.array(series(), {
        min: 2,
        max: 12,
        default: [
          [92400, 108100, 121300, 129800, 135200, 139600],
          [63800, 86200, 111900, 138400, 161700, 180900],
          [8200, 21900, 50600, 96300, 147800, 204300],
          [71200, 80300, 86100, 90200, 92800, 94600],
          [44900, 57600, 73800, 84100, 101300, 118200],
          [51700, 60400, 66200, 69800, 72100, 73400],
          [29800, 40700, 47300, 62900, 79400, 88600],
        ],
      }),
      prefix: p.string({ max: 2, default: '' }),
      unit: p.string({ max: 4, default: '' }),
      decimals: p.int({ min: 0, max: 2, optional: true }),
      top: p.int({ min: 2, max: 10, default: 8 }),
      // A label to draw in the accent colour; empty means the final leader, "none" means nobody.
      highlight: p.string({ max: 32, default: '' }),
      lowerIsBetter: p.bool({ default: false }),
      accent: p.color({ default: '#3b82f6' }),
      theme: p.enum(['dark', 'light'], { default: 'dark' }),
    }),
  ),
  prefix: { frames: 30, key: (q) => `${q.accent}|${q.theme}` },
  meta: (q) => {
    const last = q.values.map((r) => r[r.length - 1])
    const lead = last.indexOf(q.lowerIsBetter ? Math.min(...last) : Math.max(...last))
    return { title: q.title || 'Bar chart race', description: `${q.labels[lead]} leads in ${q.periods[q.periods.length - 1]}` }
  },
  setup,
})

/** Number formatting without Intl (deterministic across runtimes). */
function fmt(v, decimals) {
  const [int, frac] = v.toFixed(decimals).split('.')
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '')
}

const SUFFIXES = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
]
/** The fewest decimals (up to 2) that show `v` exactly. */
const minDecimals = (v) => [0, 1, 2].find((d) => Math.abs(v * 10 ** d - Math.round(v * 10 ** d)) < 1e-6) ?? 2
const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t)
const smooth = (t) => t * t * (3 - 2 * t)
const q3 = (n) => Math.round(n * 1000) / 1000

function setup(ctx, q) {
  const { text, fps, frames } = ctx
  const theme = THEMES[q.theme]
  const accent = hex(q.accent)
  const barGrey = q.theme === 'dark' ? mix(theme.bg, 0xffffff, 0.2) : mix(theme.bg, 0x000000, 0.16)
  const bg = background(ctx, theme, accent, { glowAt: [W * 0.95, -80], radius: 820 })

  const n = q.labels.length
  const P = q.periods.length
  const shown = Math.min(q.top, n)
  const lower = q.lowerIsBetter
  const better = (a, b) => (lower ? a < b : a > b)

  const data = q.values
  // Without a unit, each value is shown compact on its own (8,200 -> 8.2k, 4.1e10 -> 41.0B), so
  // entries of wildly different sizes all stay readable. A unit shows plain grouped numbers.
  const compact = !q.unit
  const decimals = q.decimals ?? (data.flat().some((v) => !Number.isInteger(v)) ? 1 : 0)
  const compactDecimals = q.decimals ?? 1
  /** [number, suffix or unit] for a value; ticks use as few decimals as their step needs. */
  const format = (v, tick) => {
    if (compact) {
      for (const [d, sfx] of SUFFIXES) if (v >= d) return [fmt(v / d, tick ? minDecimals(v / d) : compactDecimals), sfx]
      return [fmt(v, tick ? minDecimals(v) : decimals), '']
    }
    return [fmt(v, tick ? minDecimals(v) : decimals), q.unit]
  }
  const finalRank = order(data.map((r) => r[P - 1]))
  const hi = q.highlight === 'none' ? -1 : q.highlight ? q.labels.indexOf(q.highlight) : finalRank[0]

  /** Entry indices, best first; ties keep the given order. */
  function order(vals) {
    return vals.map((_, i) => i).sort((a, b) => (vals[a] === vals[b] ? a - b : better(vals[a], vals[b]) ? -1 : 1))
  }

  // ---------------------------------------------------------------- rows
  const slot = Math.min(100, (Y1 - Y0) / shown)
  const rowsTop = Math.round(Y0 + (Y1 - Y0 - slot * shown) / 2)
  const rowsBot = Math.round(rowsTop + slot * shown)
  const bh = Math.round(Math.min(52, slot * 0.66))
  const barOff = Math.round((slot - bh) / 2)
  const r = Math.min(8, Math.floor(bh / 3))
  const size = Math.max(15, Math.min(24, Math.round(bh * 0.52)))
  const baseOff = Math.round(slot / 2 + size * 0.36) // baseline below a row's top

  // Counting labels are tabular-figure glyph sprites, one per character, colour and quarter-pixel
  // phase, drawn at whole-pixel offsets (a copy, where a vector fill per glyph cost 5x more).
  const glyphs = new Map()
  const glyphSet = (sz, color) => {
    const runs = new Map()
    const at = (ch) => {
      if (!runs.has(ch)) {
        const run = text.run('semibold', ch, sz, { features: { tnum: true } })
        runs.set(ch, { adv: run.advance, phases: [0, 0.25, 0.5, 0.75].map((ph) => ctx.sprite([{ cmds: run.cmds(ph, 0), color }], { margin: 2 })) })
      }
      return runs.get(ch)
    }
    for (const ch of `0123456789,.${q.prefix}`) at(ch)
    for (const sfx of compact ? SUFFIXES.map(([, x]) => x) : [q.unit]) at(sfx)
    return at
  }
  const glyphsFor = (sz, color) => {
    const key = `${sz}|${color}`
    if (!glyphs.has(key)) glyphs.set(key, glyphSet(sz, color))
    return glyphs.get(key)
  }
  /** Sprites and offsets for a formatted value: prefix, digits, then its suffix or unit. */
  const labelParts = ([num, tail], sz, color) => {
    const at = glyphsFor(sz, color)
    const parts = []
    let x = 0
    const put = (gl) => {
      parts.push({ gl, x })
      x += gl.adv
    }
    for (const ch of `${q.prefix}${num}`) put(at(ch))
    if (tail) {
      x += 1
      put(at(tail))
    }
    return { parts, w: x }
  }
  /** Draws labelParts at (x, baseline): whole pixels plus the nearest quarter-pixel phase. */
  const drawParts = (g, parts, x, y, opacity, clip) => {
    for (const { gl, x: dx } of parts) {
      const px = Math.round((x + dx) * 4) / 4
      const ix = Math.floor(px)
      g.draw(gl.phases[Math.round((px - ix) * 4) & 3], { opacity, clip, transform: [1, 0, 0, 1, ix, y] })
    }
  }
  // Room for the widest value label, plus a digit for values in between.
  const valueW = Math.ceil(Math.max(...data.flat().map((v) => labelParts(format(v), size, theme.muted).w)) + glyphsFor(size, theme.muted)('0').adv)
  const L = W - PAD_X - valueW - 12 - X0 // bar length at the scale's maximum

  const items = q.labels.map((label, i) => {
    const name = text.fit('semibold', label, size, LABEL_W)
    const isHi = i === hi
    const color = isHi ? accent : mix(barGrey, TINTS[i % TINTS.length], q.theme === 'dark' ? 0.32 : 0.38)
    const by = rowsTop + barOff
    return {
      // A bar is a full-length body clipped to its length plus its rounded end moved to the tip:
      // both are whole-pixel sprite copies.
      body: ctx.sprite([{ cmds: rect(X0 + 1, by, X0 + 1 + L, by + bh), color }], { margin: 1 }),
      cap: ctx.sprite([{ cmds: rrect(0, by, 2 * r, bh, r), color }], { margin: 1 }),
      valueColor: isHi ? theme.fg : theme.muted,
      name: ctx.sprite([{ cmds: name.cmds(Math.round(X0 - 14 - name.advance), rowsTop + baseOff), color: isHi ? theme.fg : mix(theme.fg, theme.muted, 0.25) }], { margin: 3 }),
    }
  })
  const ranks = Array.from({ length: shown }, (_, k) => {
    const run = text.run('regular', String(k + 1), size, { features: { tnum: true } })
    const cmds = run.cmds(Math.round(RANK_R - run.advance), Math.round(rowsTop + k * slot) + baseOff)
    return { muted: ctx.sprite([{ cmds, color: theme.muted, alpha: 0.75 }], { margin: 3 }), lit: k === 0 ? ctx.sprite([{ cmds, color: accent }], { margin: 3 }) : null }
  })
  const tickLine = ctx.sprite([{ cmds: rect(0, rowsTop - 4, 1, rowsBot + 4), color: theme.muted, alpha: 0.28 }], { margin: 1 })
  const band = ctx.path(rrect(PAD_X - 14, 0, W - 2 * PAD_X + 28, Math.round(slot - 4), Math.min(12, slot / 4)))
  const axis = ctx.sprite([{ cmds: rect(X0, Y0 - 6, X0 + 1, Y1 + 6), color: theme.muted, alpha: 0.6 }], { margin: 1 })

  // ---------------------------------------------------------------- title + period counter
  const counterRuns = q.periods.map((s) => text.run('semibold', s, COUNTER_SIZE, { features: { tnum: true }, letterSpacing: -0.03 * COUNTER_SIZE }))
  const counterW = Math.ceil(Math.max(...counterRuns.map((run) => run.advance)))
  const counters = counterRuns.map((run) =>
    ctx.sprite([{ cmds: run.cmds(Math.round(W - PAD_X - run.advance), COUNTER_BASE), color: theme.fg }], { margin: 4 }),
  )
  const cBox = [W - PAD_X - counterW - 8, COUNTER_BASE - Math.round(COUNTER_SIZE * 0.78), W, COUNTER_BASE + Math.round(COUNTER_SIZE * 0.08)]
  const trackW = Math.max(160, counterW)
  const trackX = W - PAD_X - trackW
  const trackY = COUNTER_BASE + 16
  const track = ctx.sprite([{ cmds: rrect(trackX, trackY, trackW, 3, 1.5), color: theme.muted, alpha: 0.3 }], { margin: 1 })
  const trackFill = ctx.path(rrect(0, 0, 3, 3, 1.5))
  const titleRun = q.title ? text.fit('semibold', q.title, 40, W - 2 * PAD_X - counterW - 40, { letterSpacing: -0.8 }) : null
  const title = titleRun ? ctx.sprite([{ cmds: titleRun.cmds(PAD_X, TITLE_BASE), color: theme.fg }], { margin: 4 }) : null

  // ---------------------------------------------------------------- the race, per frame
  const seg = Math.min(SEG_MAX, RACE_MAX / (P - 1))
  const raceEnd = RACE_AT + seg * (P - 1)
  const segEase = gsap.parseEase('power1.inOut')
  const growEase = gsap.parseEase('expo.out')
  const slideEase = gsap.parseEase('power2.inOut')
  const rank0 = order(data.map((r) => r[0]))
  const rankOf0 = new Array(n)
  rank0.forEach((e, k) => (rankOf0[e] = k))
  const stagger = Math.min(0.06, 0.4 / n)

  const vals = new Float64Array(frames * n)
  const pos = new Float64Array(frames * n)
  const scale = new Float64Array(frames)
  const progress = new Float64Array(frames) // race position in periods, 0..P-1 (not eased)
  const slides = rankOf0.map((k) => ({ from: k, to: k, at: 0 }))
  let sc = 0
  for (let f = 0; f < frames; f++) {
    const t = f / fps
    const v = vals.subarray(f * n, (f + 1) * n)
    const u = clamp01((t - RACE_AT) / (raceEnd - RACE_AT)) * (P - 1)
    progress[f] = u
    if (t < RACE_AT) for (let e = 0; e < n; e++) v[e] = data[e][0] * growEase(clamp01((t - GROW_AT - rankOf0[e] * stagger) / 0.9))
    else {
      const s = Math.min(P - 2, Math.floor(u))
      const k = segEase(u - s)
      for (let e = 0; e < n; e++) v[e] = data[e][s] + (data[e][s + 1] - data[e][s]) * k
    }
    // Ranks from the live values (the first period's while growing); rows ease to new slots.
    const rk = t < RACE_AT ? rank0 : order(v)
    let target = 0
    rk.forEach((e, k) => {
      const sl = slides[e]
      if (sl.to !== k) {
        const cur = sl.from + (sl.to - sl.from) * slideEase(clamp01((t - sl.at) / SLIDE))
        Object.assign(sl, { from: cur, to: k, at: t })
      }
      pos[f * n + e] = sl.from + (sl.to - sl.from) * slideEase(clamp01((t - sl.at) / SLIDE))
      if (k < shown) target = Math.max(target, t < RACE_AT ? data[e][0] : v[e])
    })
    // The scale jumps up with a growing leader and eases down, so no bar ever overflows.
    target = target || 1
    sc = f === 0 || target > sc ? target : sc + (target - sc) * 0.12
    scale[f] = sc
  }

  /** Gridlines for a scale: two neighbouring 1-2-5 steps crossfaded, about four lines across. */
  function ticks(max) {
    const want = max / 3.5
    let lo = 10 ** Math.floor(Math.log10(want))
    const steps = [1, 2, 5, 10].map((m) => m * lo)
    let i = 0
    while (steps[i + 1] <= want) i++
    lo = steps[i]
    const up = steps[i + 1]
    const k = smooth(clamp01(Math.log(want / lo) / Math.log(up / lo)))
    const on = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-6
    const out = []
    // Every multiple of the finer step (fading out as the scale grows) and of the coarser one
    // (fading in); lines on both stay solid.
    const grain = up % lo === 0 ? lo : lo / 2
    for (let m = 1; m * grain <= max * 1.0001; m++) {
      const value = m * grain
      const a = on(value, lo) && on(value, up) ? 1 : on(value, lo) ? 1 - k : on(value, up) ? k : 0
      if (a < 0.02) continue
      out.push([X0 + Math.round((value / max) * L), q3(a), q3(value)])
    }
    return out
  }

  // ---------------------------------------------------------------- intro + outro timeline
  const s = {
    axis: { p: 0 },
    title: { p: 0 },
    head: { o: 0 },
    end: { o: 0 },
    rows: [],
    ticks: [],
    counter: [0, -1, 1],
    fill: 0,
  }
  const tl = gsap.timeline({ paused: true })
  tl.fromTo(s.axis, { p: 0 }, { p: 1, duration: 0.45, ease: 'expo.inOut' }, 0.05)
  if (title) tl.fromTo(s.title, { p: 0 }, { p: 1, duration: 0.7, ease: 'expo.out' }, 0.5)
  tl.fromTo(s.head, { o: 0 }, { o: 1, duration: 0.45, ease: 'power2.out' }, 0.55)
  tl.fromTo(s.end, { o: 0 }, { o: 1, duration: 0.5, ease: 'power2.out' }, raceEnd + 0.1)
  tl.seek(0)

  // ---------------------------------------------------------------- frames
  return {
    state(i) {
      tl.seek(i / fps, false)
      const max = scale[i]
      // [row top, bar length, shown value] per entry; null when it is off the chart.
      s.rows = items.map((_, e) => {
        const ps = pos[i * n + e]
        if (ps >= shown) return null
        const v = vals[i * n + e]
        const len = v > 0 ? Math.max(2, Math.round((v / max) * L)) : 0
        // Rising rows draw over the rows they pass, and the highlight over everything.
        const z = e === hi ? 2 : i > 0 && ps < pos[(i - 1) * n + e] - 1e-6 ? 1 : 0
        return [Math.round(rowsTop + ps * slot), len, format(v), z]
      })
      s.ticks = i / fps >= GROW_AT ? ticks(max) : []
      // The counter shows the nearest period and flips half way between two.
      const u = progress[i]
      const cur = Math.round(u)
      const flip = cur === 0 ? 1 : q3(clamp01(((u - cur + 0.5) * seg) / FLIP))
      s.counter = [cur, cur - 1, flip]
      s.fill = Math.round((trackW - 3) * (u / (P - 1)))
      return s
    },
    draw(g) {
      const axisDone = s.axis.p >= 1
      const titleDone = !title || s.title.p >= 1
      const headDone = s.head.o >= 1
      const endDone = s.end.o >= 1
      g.layer('bg', () => g.draw(bg))
      g.layer([axisDone, titleDone, headDone, endDone].join(), () => {
        if (titleDone && title) g.draw(title)
        if (headDone) {
          g.draw(track)
          ranks.forEach((rk) => g.draw(endDone && rk.lit ? rk.lit : rk.muted))
        }
      })

      const ho = s.head.o
      if (title && !titleDone && s.title.p > 0) {
        g.draw(title, { opacity: Math.min(1, s.title.p * 1.5), clip: [0, 0, PAD_X + (titleRun.advance + 8) * s.title.p, H] })
      }
      if (!headDone && ho > 0) {
        g.draw(track, { opacity: ho })
        ranks.forEach((rk) => g.draw(rk.muted, { opacity: ho }))
      }
      if (headDone && !endDone && s.end.o > 0 && ranks[0].lit) g.draw(ranks[0].lit, { opacity: s.end.o })

      // Gridlines and their values, behind the bars.
      for (const [x, a, value] of s.ticks) {
        g.draw(tickLine, { opacity: a * ho, transform: [1, 0, 0, 1, x, 0] })
        const { parts, w } = labelParts(format(value, true), 15, theme.muted)
        // Values fade in and out over the far half of their line's fade, so two never overlap.
        if (a > 0.5) drawParts(g, parts, x - w / 2, rowsBot + TICK_GAP, smooth((a - 0.5) * 2) * ho)
      }

      // The leader's row lights up once the race is over.
      const leader = s.rows[finalRank[0]]
      if (s.end.o > 0 && leader) g.fill(band, accent, { alpha: 0.12 * s.end.o, transform: affine(0, leader[0] + 2) })

      // Rows: sliding out of the chart, they are clipped at its bottom edge.
      const clip = [0, rowsTop - 2, W, rowsBot]
      const drawRow = (row, e) => {
        const [y, len, value] = row
        const it = items[e]
        const dy = y - rowsTop
        const tip = X0 + 1 + len
        if (len > 2 * r) g.draw(it.body, { clip: [0, clip[1], tip - r, clip[3]], transform: [1, 0, 0, 1, 0, dy] })
        if (len > 0) g.draw(it.cap, { clip: [X0 + 1, clip[1], tip, clip[3]], transform: [1, 0, 0, 1, Math.max(X0 + 1, tip - 2 * r), dy] })
        g.draw(it.name, { opacity: ho, clip, transform: [1, 0, 0, 1, 0, dy] })
        if (len > 0) {
          const { parts } = labelParts(value, size, it.valueColor)
          drawParts(g, parts, tip + 10, y + baseOff, ho, clip)
        }
      }
      for (const z of [0, 1, 2]) s.rows.forEach((row, e) => row && row[3] === z && drawRow(row, e))

      if (s.axis.p > 0) g.draw(axis, axisDone ? undefined : { clip: [0, Y0 - 6, W, Y0 - 6 + (Y1 - Y0 + 12) * s.axis.p] })

      // Period counter and progress track.
      if (ho > 0) {
        const [cur, prev, flip] = s.counter
        const D = Math.round(COUNTER_SIZE * 0.8) // a full glyph height: the two never overlap
        if (flip < 1 && prev >= 0) g.draw(counters[prev], { opacity: ho * (1 - flip), clip: cBox, transform: [1, 0, 0, 1, 0, -Math.round(flip * D)] })
        g.draw(counters[cur], { opacity: ho * flip, clip: cBox, transform: [1, 0, 0, 1, 0, Math.round((1 - flip) * D)] })
        if (s.fill > 0) g.fill(trackFill, accent, { alpha: ho, transform: [(s.fill + 3) / 3, 0, 0, 1, trackX, trackY] })
      }
    },
    dispose: () => tl.kill(),
  }
}
