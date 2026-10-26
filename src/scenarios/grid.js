// grid: a results grid (eval suites, test matrices, model-vs-task runs, daily-game scores). The
// title wipes on and empty outlined tiles pop in on a diagonal wave; then, like Wordle, each tile
// flips (squashes to nothing and opens with its result colour) left to right, top to bottom. Each
// row's tally lands as its last tile does, and the score in the corner counts the passes as they
// land, with a small pop when the last one is in.
//
// Cells are one character each: p pass, f fail, w warn (partial), - skipped, . empty (never
// flips, not counted). Wordle letters work too: g = pass, y = warn, x = fail. Short rows are
// padded with empty cells, so ragged rows read as unfinished. Every result also has a glyph
// (check, cross, '!', dash) so the grid does not depend on telling red from green.
//
// The first 72 frames (1.2 s: title, labels and the empty grid) depend only on accent, theme,
// kicker, title, the grid's dimensions and its labels, so a suite re-run daily with new results
// reuses its prefix.
//
// Each tile face (empty, pass, fail, warn, skip) is one sprite at the origin, placed with
// whole-pixel translations (cell positions are multiples of 5 layout units, whole pixels at the
// default 0.8 scale). Landed tiles are baked into a layer keyed by how many have landed (they land
// in order); only tiles mid-flip are drawn live, scaled vertically, over a patch of background
// that hides the outline beneath. The counter is assembled from tabular digit paths built once.
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, transform } from '../gfx.js'
import { W, H, THEMES, background, mix, hex, onColor, affine } from './showcase-kit.js'

const PAD_X = 80
const KICK_BASE = 92
const TITLE_BASE = 150
const GRID_TOP = 196
const GRID_BOTTOM = 590
const MAX_PITCH = 130
const INTRO_AT = 0.25
const FLIP_AT = 1.25
const FLIP_DUR = 0.45
const PREFIX_FRAMES = 72

const CELL = { p: 'pass', g: 'pass', f: 'fail', x: 'fail', w: 'warn', y: 'warn', '-': 'skip', '.': 'empty' }

export const grid = defineScenario({
  id: 'grid',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  params: p.object({
    title: p.string({ max: 60, default: 'Agent eval: 5 configs × 6 tasks' }),
    kicker: p.string({ max: 32, default: 'Nightly run' }),
    rows: p.array(p.string({ max: 16, pattern: /^[pfwgyx.-]*$/i }), {
      min: 1,
      max: 10,
      default: ['pwfpfp', 'ppfppw', 'pppwpp', 'pppppw', 'pppppp'],
    }),
    rowLabels: p.array(p.string({ max: 32 }), { max: 10, default: ['Baseline', 'With retrieval', 'With planner', 'With tools', 'All features'] }),
    cols: p.array(p.string({ max: 16 }), { max: 16, default: ['Search', 'Refactor', 'SQL', 'Tests', 'Browse', 'Deploy'] }),
    score: p.string({ max: 10, default: '' }),
    tally: p.bool({ default: true }),
    glyphs: p.bool({ default: true }),
    accent: p.color({ default: '#22c55e' }),
    fail: p.color({ optional: true }),
    warn: p.color({ optional: true }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: {
    frames: PREFIX_FRAMES,
    key: (q) => JSON.stringify([q.accent, q.theme, q.kicker, q.title, q.rows.length, cols(q), q.rowLabels, q.cols, q.tally]),
  },
  meta: (q) => {
    const { pass, total } = count(cells(q))
    return { title: q.title || 'Results', description: q.score || (total ? `${pass}/${total} passed` : undefined) }
  },
  setup,
})

/** Columns: the longest row (at least 1). */
const cols = (q) => Math.max(1, ...q.rows.map((r) => r.length))

/** The grid as kinds, padded with empty cells to a rectangle. */
const cells = (q) => q.rows.map((r) => Array.from({ length: cols(q) }, (_, c) => CELL[(r[c] ?? '.').toLowerCase()]))

function count(rows) {
  let pass = 0
  let total = 0
  for (const row of rows)
    for (const k of row) {
      if (k === 'pass') pass++
      if (k === 'pass' || k === 'fail' || k === 'warn') total++
    }
  return { pass, total }
}

/** Applies an affine [a, b, c, d, e, f] to every point of a command buffer. */
function mapCmds(cmds, [a, b, c, d, e, f]) {
  const ARGS = [2, 2, 4, 6, 0]
  const out = []
  for (let i = 0; i < cmds.length; ) {
    const op = cmds[i++]
    out.push(op)
    for (let j = 0; j < ARGS[op]; j += 2, i += 2) {
      const x = cmds[i]
      const y = cmds[i + 1]
      out.push(a * x + c * y + e, b * x + d * y + f)
    }
  }
  return out
}

/** A round-capped bar from (x0, y0) to (x1, y1), `w` wide: there is no stroke primitive. */
function bar(x0, y0, x1, y1, w) {
  const len = Math.hypot(x1 - x0, y1 - y0)
  const ang = Math.atan2(y1 - y0, x1 - x0)
  const [cs, sn] = [Math.cos(ang), Math.sin(ang)]
  return mapCmds(rrect(-w / 2, -w / 2, len + w, w, w / 2), [cs, sn, -sn, cs, x0, y0])
}

/** Glyph outlines for a tile of side t at the origin. Bars share a winding, so they union. */
function glyph(kind, t) {
  const w = Math.max(2, t * 0.095)
  const at = (u) => u * t
  if (kind === 'pass') return [...bar(at(0.29), at(0.52), at(0.44), at(0.66), w), ...bar(at(0.44), at(0.66), at(0.72), at(0.36), w)]
  if (kind === 'fail') return [...bar(at(0.34), at(0.34), at(0.66), at(0.66), w), ...bar(at(0.66), at(0.34), at(0.34), at(0.66), w)]
  if (kind === 'warn') {
    const d = Math.max(2.5, t * 0.11)
    return [...bar(at(0.5), at(0.28), at(0.5), at(0.54), w), ...rrect(at(0.5) - d / 2, at(0.7) - d / 2, d, d, d * 0.3)]
  }
  if (kind === 'skip') return bar(at(0.38), at(0.5), at(0.62), at(0.5), Math.max(2, t * 0.075))
  return []
}

const clamp01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x)
const r3 = (x) => Math.round(x * 1000) / 1000
const expoOut = (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x))
const backOut = (x, s = 1.8) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2
const inOut = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)
/** Progress of a tween starting at `at` lasting `dur`, eased. */
const tw = (t, at, dur, ease) => ease(clamp01((t - at) / dur))

const round5 = (n) => Math.round(n / 5) * 5
const floor5 = (n) => Math.floor(n / 5) * 5

function setup(ctx, q) {
  const { text } = ctx
  const theme = THEMES[q.theme]
  const dark = q.theme === 'dark'
  const accent = hex(q.accent)
  const bg = background(ctx, theme, accent, { glowAt: [W * 0.5, H + 180], radius: 900 })
  const grid = cells(q)
  const nr = grid.length
  const nc = cols(q)
  const { pass: passTotal, total } = count(grid)

  // ---------------------------------------------------------------- header
  // The score column is sized for the largest count this grid could show, so the title's width
  // depends only on the grid's dimensions (prefix params), not on its results.
  const SCORE_SIZE = 56
  const scoreRight = W - PAD_X
  const scoreW = Math.max(180, Math.ceil(text.run('semibold', `${nr * nc}/${nr * nc}`, SCORE_SIZE, { features: { tnum: true } }).advance))
  const marker = ctx.path(rrect(-7, -7, 14, 14, 3))
  const markerAt = [PAD_X + 7, KICK_BASE - 8]
  const kickRun = q.kicker ? text.fit('semibold', q.kicker, 22, W - 2 * PAD_X - scoreW - 40) : null
  const kicker = kickRun ? ctx.sprite([{ cmds: kickRun.cmds(PAD_X + 26, KICK_BASE), color: theme.muted }], { margin: 4 }) : null
  const titleRun = q.title ? text.fit('semibold', q.title, 44, W - 2 * PAD_X - scoreW - 32, { letterSpacing: -0.9 }) : null
  const title = titleRun ? ctx.sprite([{ cmds: titleRun.cmds(PAD_X, TITLE_BASE), color: theme.fg }], { margin: 4 }) : null

  // ---------------------------------------------------------------- layout
  // Everything here depends only on the prefix key's params (dimensions and labels).
  const fitLabels = (labels, size, max) => labels.map((s) => (s ? text.fit('regular', s, size, max) : null))
  const widest = (runs) => Math.max(0, ...runs.map((r) => (r ? r.advance : 0)))
  const colTexts = q.cols.slice(0, nc)
  const hasCols = colTexts.some(Boolean)
  const tallyW = q.tally ? Math.ceil(text.run('semibold', `${nc}/${nc}`, 22, { features: { tnum: true } }).advance) + 24 : 0
  // Row labels are sized to the row pitch, so measure them at the largest size they could take.
  const labelW0 = q.rowLabels.slice(0, nr).some(Boolean) ? Math.ceil(widest(fitLabels(q.rowLabels.slice(0, nr), 22, 240))) + 24 : 0
  const pitchFor = (band) => Math.max(10, floor5(Math.min((W - 2 * PAD_X - labelW0 - tallyW) / nc, (GRID_BOTTOM - GRID_TOP - band) / nr, MAX_PITCH)))
  // Column labels sit level above their columns at one shared size (18 down to 12). If they do
  // not fit even at 12, they turn 45 degrees, which costs vertical room instead.
  let band = hasCols ? 30 : 0
  let pitch = pitchFor(band)
  let colSize = Math.max(12, Math.min(18, Math.round(pitch * 0.34)))
  const tooWide = (size) => colTexts.some((s) => s && text.run('regular', s, size).advance > pitch - 4)
  while (colSize > 12 && tooWide(colSize)) colSize--
  const diagonal = hasCols && tooWide(colSize)
  let colRuns = hasCols ? fitLabels(colTexts, colSize, pitch - 4) : []
  if (diagonal) {
    colSize = 14
    colRuns = fitLabels(colTexts, colSize, 100)
    band = Math.ceil(widest(colRuns) * Math.SQRT1_2) + 20
    pitch = pitchFor(band)
  }
  const top = GRID_TOP + band
  const availH = GRID_BOTTOM - top
  const gap = Math.max(4, Math.round(pitch * 0.12))
  const t = pitch - gap
  const labelSize = Math.max(14, Math.min(22, Math.round(pitch * 0.5)))
  const labelRuns = fitLabels(q.rowLabels.slice(0, nr), labelSize, 240)
  const labelW = labelRuns.some(Boolean) ? Math.ceil(widest(labelRuns)) + 24 : 0
  const gridW = nc * pitch - gap
  const gridH = nr * pitch - gap
  const blockW = labelW + gridW + tallyW
  const bx = round5(PAD_X + (W - 2 * PAD_X - blockW) / 2)
  const gx = bx + labelW
  const gy = round5(top + (availH - gridH) / 2)
  const cellX = (c) => gx + c * pitch
  const cellY = (r) => gy + r * pitch

  const rowLabels = labelRuns.some(Boolean)
    ? ctx.sprite(
        labelRuns.flatMap((run, r) => (run ? [{ cmds: run.cmds(bx, Math.round(cellY(r) + t / 2 + labelSize * 0.36)), color: theme.fg }] : [])),
        { margin: 4 },
      )
    : null
  const colCmds = (run, c) => {
    if (!diagonal) return run.cmds(Math.round(cellX(c) + t / 2 - run.advance / 2), gy - 14)
    const k = Math.SQRT1_2
    return mapCmds(run.cmds(0, 0), [k, -k, k, k, cellX(c) + t / 2 - 3, gy - 10])
  }
  const colLabels = colRuns.some(Boolean)
    ? ctx.sprite(
        colRuns.flatMap((run, c) => (run ? [{ cmds: colCmds(run, c), color: theme.muted }] : [])),
        { margin: 4 },
      )
    : null

  // ---------------------------------------------------------------- tiles
  const radius = Math.max(2, Math.round(t * 0.12))
  const edge = Math.max(1.5, Math.min(3, t * 0.045))
  const outlineColor = dark ? mix(theme.bg, theme.fg, 0.22) : mix(theme.bg, theme.fg, 0.2)
  const ring = [...rrect(0, 0, t, t, radius), ...rrect(edge, edge, t - 2 * edge, t - 2 * edge, Math.max(0, radius - edge))]
  const faces = {
    pass: accent,
    fail: q.fail ? hex(q.fail) : dark ? 0xef4444 : 0xdc2626,
    warn: q.warn ? hex(q.warn) : dark ? 0xf59e0b : 0xd97706,
    skip: dark ? mix(theme.bg, theme.fg, 0.1) : mix(theme.bg, theme.fg, 0.08),
  }
  const sprites = { empty: ctx.sprite([{ cmds: ring, color: outlineColor, evenodd: true }], { margin: 2 }) }
  for (const [kind, color] of Object.entries(faces)) {
    const ink = kind === 'skip' ? theme.muted : onColor(color)
    const layers = [{ cmds: rrect(0, 0, t, t, radius), color }]
    if (q.glyphs) layers.push({ cmds: glyph(kind, t), color: ink })
    sprites[kind] = ctx.sprite(layers, { margin: 2 })
  }
  // The whole empty grid as one sprite, for the settled backdrop.
  const outlines = ctx.sprite(
    [{ cmds: grid.flatMap((row, r) => row.flatMap((_, c) => transform(ring, 1, cellX(c), cellY(r)))), color: outlineColor, evenodd: true }],
    { margin: 2 },
  )

  // ---------------------------------------------------------------- timing
  // Empty tiles pop in on a diagonal wave; results flip in reading order with a beat between rows.
  const introStep = Math.min(0.035, 0.6 / (nr + nc))
  const introEnd = INTRO_AT + (nr + nc - 2) * introStep + 0.35
  const seq = []
  const flipCount = grid.flat().filter((k) => k !== 'empty').length
  const cellStep = Math.min(0.14, 2.6 / Math.max(1, flipCount))
  const rowPause = Math.min(0.18, cellStep * 1.2)
  const rowEnd = grid.map(() => -1)
  const rowTally = grid.map((row) => {
    const n = row.filter((k) => k === 'pass').length
    const of = row.filter((k) => k === 'pass' || k === 'fail' || k === 'warn').length
    return { n, of }
  })
  grid.forEach((row, r) =>
    row.forEach((kind, c) => {
      if (kind === 'empty') return
      const at = FLIP_AT + seq.length * cellStep + r * rowPause
      seq.push({ r, c, kind, at, x: cellX(c), y: cellY(r) })
      rowEnd[r] = at + FLIP_DUR
    }),
  )
  /** Seq tiles in the rows that are complete once `done` tiles have landed (seq is row-major). */
  const rowsBefore = (done) => {
    if (done >= seq.length) return seq.length
    let j = done
    while (j > 0 && seq[j - 1].r === seq[done].r) j--
    return j
  }
  const flipEnd = seq.length ? seq[seq.length - 1].at + FLIP_DUR : FLIP_AT
  // Passes landed by the time each tile lands (cumulative), for the counter.
  const passesAt = []
  seq.forEach((s, i) => passesAt.push((passesAt[i - 1] ?? 0) + (s.kind === 'pass' ? 1 : 0)))

  // ---------------------------------------------------------------- tallies and score
  const tallies = rowTally.map(({ n, of }, r) => {
    if (!q.tally || !of) return null
    const run = text.run('semibold', `${n}/${of}`, labelSize, { features: { tnum: true } })
    const color = n === of ? theme.fg : theme.muted
    return ctx.sprite([{ cmds: run.cmds(gx + gridW + 20, Math.round(cellY(r) + t / 2 + labelSize * 0.36)), color }], { margin: 4 })
  })

  const digits = new Map()
  const digit = (ch) => {
    if (!digits.has(ch)) {
      const run = text.run('semibold', ch, SCORE_SIZE, { features: { tnum: true } })
      digits.set(ch, { path: ctx.path(run.cmds(0, 0)), adv: run.advance })
    }
    return digits.get(ch)
  }
  /** Digit paths for the live counter, right-aligned to the score column. */
  const counter = (n) => {
    const parts = [...`${n}/${total}`].map(digit)
    let x = scoreRight - parts.reduce((a, d) => a + d.adv, 0)
    return parts.map((d) => {
      const at = x
      x += d.adv
      return { path: d.path, x: at }
    })
  }
  // A custom score shrinks to fit the score column (down to 36), then truncates.
  let customSize = SCORE_SIZE
  while (q.score && customSize > 36 && text.run('semibold', q.score, customSize, { letterSpacing: -1 }).advance > scoreW) customSize -= 4
  const custom = q.score ? text.fit('semibold', q.score, customSize, scoreW, { letterSpacing: -1 }) : null
  const customSprite = custom ? ctx.sprite([{ cmds: custom.cmds(scoreRight - custom.advance, TITLE_BASE), color: theme.fg }], { margin: 4 }) : null
  const showScore = custom || total > 0
  const passedRun = !custom && total > 0 ? text.run('semibold', 'passed', 22) : null
  const passed = passedRun ? ctx.sprite([{ cmds: passedRun.cmds(scoreRight - passedRun.advance, KICK_BASE), color: theme.muted }], { margin: 4 }) : null
  const scoreX0 = scoreRight - scoreW - 8

  // ---------------------------------------------------------------- frames
  return {
    state(i) {
      const time = i / ctx.fps
      const done = seq.reduce((n, s) => n + (time >= s.at + FLIP_DUR ? 1 : 0), 0)
      const flips = []
      for (let j = done; j < seq.length && time > seq[j].at; j++) flips.push([j, r3(inOut(clamp01((time - seq[j].at) / FLIP_DUR)))])
      return {
        mk: r3(tw(time, 0.05, 0.45, backOut)),
        kick: r3(tw(time, 0.1, 0.6, expoOut)),
        title: r3(tw(time, 0.18, 0.75, expoOut)),
        labels: r3(tw(time, 0.45, 0.4, inOut)),
        // Intro time, frozen once every outline has landed.
        intro: time >= introEnd ? -1 : r3(time),
        done,
        flips,
        tallies: rowEnd.map((e) => (e < 0 ? 0 : r3(tw(time, e - 0.1, 0.35, inOut)))),
        score: r3(tw(time, FLIP_AT, 0.4, inOut)),
        pop: r3(clamp01((time - flipEnd) / 0.4)),
      }
    },
    draw(g, s) {
      const headerDone = (!kicker || (s.kick >= 1 && s.mk >= 1)) && (!title || s.title >= 1)
      const labelsDone = s.labels >= 1
      const introDone = s.intro < 0
      const talliesDone = s.tallies.map((o) => o >= 1)
      const scoreDone = !showScore || (s.score >= 1 && s.pop >= 1)

      g.layer('bg', () => g.draw(bg))
      g.layer(['static', headerDone, labelsDone, introDone].join(), () => {
        if (headerDone) {
          if (kicker) {
            g.fill(marker, accent, { transform: affine(...markerAt) })
            g.draw(kicker)
          }
          if (title) g.draw(title)
        }
        if (labelsDone) {
          if (rowLabels) g.draw(rowLabels)
          if (colLabels) g.draw(colLabels)
        }
        if (introDone) g.draw(outlines)
      })
      // Landed tiles in two layers: whole rows (with their tallies and the final score), then the
      // landed part of the row in progress, so each landing repaints one row, not the grid.
      const landed = rowsBefore(s.done)
      const paintTiles = (from, to) => {
        for (let j = from; j < to; j++) {
          const c = seq[j]
          g.draw(bg, { clip: [c.x - 1, c.y - 1, c.x + t + 1, c.y + t + 1] })
          g.draw(sprites[c.kind], { transform: affine(c.x, c.y) })
        }
      }
      g.layer(['rows', landed, talliesDone, scoreDone].join(), () => {
        paintTiles(0, landed)
        tallies.forEach((sp, r) => sp && talliesDone[r] && g.draw(sp))
        if (scoreDone) {
          if (customSprite) g.draw(customSprite)
          else if (passed) {
            g.draw(passed)
            for (const d of counter(passTotal)) g.fill(d.path, theme.fg, { transform: affine(d.x, TITLE_BASE) })
          }
        }
      })
      g.layer(['row', s.done].join(), () => paintTiles(landed, s.done))

      // Header.
      if (!headerDone) {
        if (kicker && s.mk > 0) g.fill(marker, accent, { transform: affine(markerAt[0], markerAt[1], 90 * (1 - s.mk), s.mk) })
        if (kicker && s.kick > 0) g.draw(kicker, { opacity: Math.min(1, s.kick * 2), clip: [0, 0, PAD_X + 26 + (kickRun.advance + 8) * s.kick, H] })
        if (title && s.title > 0) g.draw(title, { opacity: Math.min(1, s.title * 1.6), clip: [0, 0, PAD_X + (titleRun.advance + 12) * s.title, H] })
      }
      if (!labelsDone && s.labels > 0) {
        if (rowLabels) g.draw(rowLabels, { opacity: s.labels })
        if (colLabels) g.draw(colLabels, { opacity: s.labels })
      }

      // Empty tiles popping in.
      if (!introDone) {
        grid.forEach((row, r) =>
          row.forEach((_, c) => {
            const k = tw(s.intro, INTRO_AT + (r + c) * introStep, 0.35, backOut)
            if (k <= 0) return
            const x = cellX(c)
            const y = cellY(r)
            const sc = 0.5 + 0.5 * k
            g.draw(sprites.empty, { opacity: Math.min(1, k * 1.5), transform: [sc, 0, 0, sc, x + (t / 2) * (1 - sc), y + (t / 2) * (1 - sc)] })
          }),
        )
      }

      // Tiles mid-flip: hide the outline beneath, then squash through zero, swapping faces.
      for (const [j, k] of s.flips) {
        const c = seq[j]
        g.draw(bg, { clip: [c.x - 1, c.y - 1, c.x + t + 1, c.y + t + 1] })
        const sy = Math.abs(Math.cos(Math.PI * k))
        if (sy < 0.02) continue
        g.draw(k < 0.5 ? sprites.empty : sprites[c.kind], { transform: [1, 0, 0, sy, c.x, c.y + (t / 2) * (1 - sy)] })
      }

      // Row tallies.
      tallies.forEach((sp, r) => {
        if (sp && !talliesDone[r] && s.tallies[r] > 0) g.draw(sp, { opacity: s.tallies[r] })
      })

      // Score: the counter follows the passes that have landed, then pops once all are in.
      if (showScore && !scoreDone && s.score > 0) {
        if (customSprite) {
          const pr = s.pop
          g.draw(customSprite, { opacity: Math.min(1, pr * 1.5), clip: [scoreX0 + (1 - pr) * (scoreW + 8), 0, W, H] })
        } else {
          if (passed) g.draw(passed, { opacity: s.score })
          const n = s.done ? passesAt[s.done - 1] : 0
          const bump = s.pop > 0 && s.pop < 1 ? 1 + 0.08 * Math.sin(Math.PI * s.pop) : 1
          const cy = TITLE_BASE - SCORE_SIZE * 0.36
          for (const d of counter(n)) {
            const x = scoreRight - (scoreRight - d.x) * bump
            g.fill(d.path, theme.fg, { alpha: s.score, transform: [bump, 0, 0, bump, x, cy + (TITLE_BASE - cy) * bump] })
          }
        }
      }
    },
  }
}
