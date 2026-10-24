// metric: a big-number reveal. Chart gridlines draw in, the label wipes on, then the number rolls
// up like an odometer (each digit slot spins into place, left to right), the trend line draws
// across the bottom with a glowing head, and a delta pill pops in beside the number.
//
// The first 36 frames (0.6 s: gridlines and label) depend only on accent, theme and label, so a
// metric that is re-rendered daily with a new value reuses its prefix.
//
// Rolling digits are vector fills moving under a mask: the background bitmap is redrawn clipped
// to the bands above and below the number, then anything static in those bands (the label, the
// gridlines) is drawn again on top. The chart is two sprites (gradient area bitmap, line polygon)
// revealed with a clip wipe.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, ellipse } from '../gfx.js'
import { W, H, THEMES, background, onColor, hex, affine } from './showcase-kit.js'

const PAD_X = 80
const LABEL_BASE = 122
const NUM_BASE = 318
const CHART = { x0: PAD_X, x1: W - PAD_X, y0: 404, y1: 566 }
const ROLL_AT = 0.6

export const metric = defineScenario({
  id: 'metric',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  params: p.object({
    label: p.string({ max: 48, default: 'Videos rendered this month' }),
    value: p.number({ min: 0, max: 999999999, default: 48210 }),
    decimals: p.int({ min: 0, max: 2, default: 0 }),
    prefix: p.string({ max: 3, default: '' }),
    suffix: p.string({ max: 4, default: '' }),
    delta: p.string({ max: 40, default: '+32% vs last month' }),
    data: p.array(p.number({ min: -1e9, max: 1e9 }), { min: 2, max: 32, default: [14, 18, 16, 23, 21, 27, 26, 34, 31, 40, 46, 44, 53, 61] }),
    accent: p.color({ default: '#22c55e' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 36, key: (q) => `${q.accent}|${q.theme}|${q.label}` },
  meta: (q) => ({ title: `${q.label}: ${format(q)}`, description: q.delta || undefined }),
  setup,
})

/** '48210' -> '48,210' with prefix, suffix and fixed decimals; no Intl, so it is deterministic. */
function format(q) {
  const [int, frac] = q.value.toFixed(q.decimals).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${q.prefix}${grouped}${frac ? `.${frac}` : ''}${q.suffix}`
}

/** A closed ring (outer clockwise, inner reversed) so a winding fill leaves the middle empty. */
function ring(r0, r1) {
  const outer = ellipse(0, 0, r1)
  const inner = ellipse(0, 0, r0)
  // Reverse the inner circle: same points, walked the other way.
  const k = 0.5522847498 * r0
  const rev = [0, r0, 0, 3, r0, -k, k, -r0, 0, -r0, 3, -k, -r0, -r0, -k, -r0, 0, 3, -r0, k, -k, r0, 0, r0, 3, k, r0, r0, k, r0, 0, 4]
  return inner.length ? [...outer, ...rev] : outer
}

/** Catmull-Rom through the points, sampled densely: [[x, y], ...]. */
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

/** A polyline as a filled outline `w` px wide (there is no stroke API). */
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
  // Round caps.
  return [...cmds, ...ellipse(pts[0][0], pts[0][1], h), ...ellipse(pts[pts.length - 1][0], pts[pts.length - 1][1], h)]
}

function setup(ctx, q) {
  const { text } = ctx
  const theme = THEMES[q.theme]
  const accent = hex(q.accent)
  const bg = background(ctx, theme, accent, { glowAt: [W * 0.85, H + 60], radius: 820 })

  // ---------------------------------------------------------------- label
  const labelRun = q.label ? text.fit('semibold', q.label, 28, W - 2 * PAD_X - 40, { letterSpacing: -0.2 }) : null
  const marker = ctx.path(rrect(-7, -7, 14, 14, 3))
  const markerAt = [PAD_X + 7, LABEL_BASE - 10]
  const label = labelRun ? ctx.sprite([{ cmds: labelRun.cmds(PAD_X + 28, LABEL_BASE), color: theme.muted }], { margin: 4 }) : null

  // ---------------------------------------------------------------- number
  const str = format(q)
  const deltaStr = q.delta.trim()
  const sign = deltaStr.startsWith('-') || deltaStr.startsWith('−') ? -1 : 1
  const [pillText, ...rest] = deltaStr.replace(/^[+\-−]/, '').split(/\s+/)
  const note = rest.join(' ')
  const pillSize = 30
  const pillRun = pillText ? text.run('semibold', pillText, pillSize) : null
  const pillW = pillRun ? Math.ceil(18 + 18 + 10 + pillRun.advance + 20) : 0
  const pillH = 54

  let size = 176
  let run
  for (size of [176, 160, 144, 128, 112, 96, 84]) {
    run = text.run('semibold', str, size, { features: { tnum: true }, letterSpacing: -0.035 * size })
    if (run.advance + (pillW ? pillW + 32 : 0) <= W - 2 * PAD_X) break
  }
  const chars = [...str]
  const xs = chars.map((_, i) => Math.round((PAD_X + (i ? run.rightOf(i - 1) : 0)) * 4) / 4)
  const digitPaths = [...'0123456789'].map((d) => ctx.path(text.run('semibold', d, size, { features: { tnum: true } }).cmds(0, 0)))
  const slots = []
  const statics = []
  chars.forEach((c, i) => {
    if (c >= '0' && c <= '9') slots.push({ x: xs[i], d: +c })
    else statics.push(i)
  })
  const numSprite = ctx.sprite([{ cmds: run.cmds(PAD_X, NUM_BASE), color: theme.fg }], { margin: 4 })
  const staticSprite = statics.length
    ? ctx.sprite(statics.map((i) => ({ cmds: run.cmds(PAD_X, NUM_BASE, i), color: theme.fg })), { margin: 4 })
    : null
  // The rolling window: digits show between these lines and are masked outside them.
  const winTop = Math.floor(NUM_BASE - size * 0.79)
  const winBot = Math.ceil(NUM_BASE + size * 0.06)
  const band = Math.ceil(size * 0.8) + 6
  const numX0 = PAD_X - 12
  const numX1 = Math.ceil(PAD_X + run.advance + 12)

  // ---------------------------------------------------------------- delta pill + note
  const pillX = Math.round(PAD_X + run.advance + 32)
  const pillY = Math.round(NUM_BASE - pillH - 4)
  const pillCx = pillX + pillW / 2
  const pillCy = pillY + pillH / 2
  const ink = onColor(accent)
  // Pill parts in local coordinates around its centre, so it can scale in as live fills.
  const pillParts = pillRun
    ? [
        { path: ctx.path(rrect(-pillW / 2, -pillH / 2, pillW, pillH, pillH / 2)), color: accent },
        { path: ctx.path(triPath(-pillW / 2 + 18 + 9, 0, sign)), color: ink },
        { path: ctx.path(pillRun.cmds(-pillW / 2 + 18 + 18 + 10, text.baselineIn('semibold', pillSize, pillH) - pillH / 2)), color: ink },
      ]
    : []
  const noteRoom = W - PAD_X - (pillX + pillW + 18)
  const noteRun = note && noteRoom > 120 ? text.fit('regular', note, 28, noteRoom) : null
  const noteSprite = noteRun ? ctx.sprite([{ cmds: noteRun.cmds(pillX + pillW + 18, pillCy + 10), color: theme.muted }], { margin: 4 }) : null

  // ---------------------------------------------------------------- chart
  const data = q.data
  let lo = Math.min(...data)
  let hi = Math.max(...data)
  if (hi - lo < 1e-9) {
    hi += 1
    lo -= 1
  }
  const span = hi - lo
  const yOf = (v) => CHART.y1 - 10 - ((v - lo) / span) * (CHART.y1 - CHART.y0 - 26)
  const pts = data.map((v, i) => [CHART.x0 + ((CHART.x1 - CHART.x0) * i) / (data.length - 1), yOf(v)])
  const curve = spline(pts, Math.max(8, Math.round(480 / data.length)))
  // Curve height at each integer x, for the area fill and the moving head.
  const colY = new Float32Array(CHART.x1 - CHART.x0 + 1)
  {
    let j = 0
    for (let x = CHART.x0; x <= CHART.x1; x++) {
      while (j < curve.length - 2 && curve[j + 1][0] < x) j++
      const [ax, ay] = curve[j]
      const [bx, by] = curve[j + 1]
      colY[x - CHART.x0] = ay + (by - ay) * (bx > ax ? Math.min(1, Math.max(0, (x - ax) / (bx - ax))) : 0)
    }
  }
  const areaTop = Math.floor(Math.min(...colY)) - 2
  const areaH = CHART.y1 - areaTop
  const [ar, ag, ab] = [(accent >> 16) & 255, (accent >> 8) & 255, accent & 255]
  const area = ctx.bitmap(CHART.x0, areaTop, CHART.x1 - CHART.x0 + 1, areaH, (px, bw, bh) => {
    for (let x = 0; x < bw; x++) {
      const top = colY[x] - areaTop
      for (let y = 0; y < bh; y++) {
        const cover = Math.max(0, Math.min(1, y + 1 - top))
        if (cover <= 0) continue
        const t = (y - top) / (bh - top)
        const a = cover * 0.3 * Math.max(0, 1 - t) ** 1.6
        const o = (y * bw + x) * 4
        px[o] = Math.round(ar * a)
        px[o + 1] = Math.round(ag * a)
        px[o + 2] = Math.round(ab * a)
        px[o + 3] = Math.round(255 * a)
      }
    }
  })
  const line = ctx.sprite([{ cmds: strokePolygon(curve, 3.5), color: accent }], { margin: 4 })
  const grids = [CHART.y0, (CHART.y0 + CHART.y1) / 2, CHART.y1].map((y, i) =>
    ctx.sprite([{ cmds: rect(CHART.x0, Math.round(y), CHART.x1, Math.round(y) + 1), color: i === 2 ? theme.muted : theme.faint, alpha: i === 2 ? 0.5 : 1 }], { margin: 1 }),
  )
  const dot = ctx.path(ellipse(0, 0, 6))
  const dotRing = ctx.path(ellipse(0, 0, 11))
  const halo = ctx.path(ellipse(0, 0, 20))
  const pulse = ctx.path(ring(9, 12))
  const headAt = (pr) => {
    const x = CHART.x0 + (CHART.x1 - CHART.x0) * pr
    return [x, colY[Math.round(x - CHART.x0)]]
  }

  // ---------------------------------------------------------------- timeline
  const s = {
    grid: grids.map(() => ({ p: 0 })),
    marker: { k: 0 },
    label: { p: 0 },
    slots: slots.map(() => ({ pos: -1 })),
    statics: { o: 0 },
    chart: { p: 0 },
    head: { o: 0 },
    pulse: { p: 0 },
    pill: { k: 0 },
    note: { p: 0 },
  }
  const tl = gsap.timeline({ paused: true })
  s.grid.forEach((o, i) => tl.fromTo(o, { p: 0 }, { p: 1, duration: 0.55, ease: 'expo.inOut' }, 0.04 + i * 0.07))
  if (labelRun) {
    tl.fromTo(s.marker, { k: 0 }, { k: 1, duration: 0.45, ease: 'back.out(2.2)' }, 0.42)
    tl.fromTo(s.label, { p: 0 }, { p: 1, duration: 0.6, ease: 'expo.out' }, 0.5)
  }
  // Each slot rolls up from blank into its digit; the last two make one extra full turn, like
  // the fast wheels of an odometer.
  slots.forEach((sl, i) => {
    sl.target = sl.d + (i >= slots.length - 2 ? 10 : 0)
    tl.fromTo(s.slots[i], { pos: -1 }, { pos: sl.target, duration: 1.5, ease: 'power3.out' }, ROLL_AT + i * 0.08)
  })
  if (staticSprite) tl.fromTo(s.statics, { o: 0 }, { o: 1, duration: 0.4, ease: 'power2.out' }, ROLL_AT + 0.3)
  const rollEnd = ROLL_AT + (slots.length - 1) * 0.08 + 1.5
  tl.fromTo(s.chart, { p: 0 }, { p: 1, duration: 1.9, ease: 'power2.inOut' }, 0.95)
  tl.fromTo(s.head, { o: 0 }, { o: 1, duration: 0.2, ease: 'power2.out' }, 0.95)
  tl.fromTo(s.pulse, { p: 0 }, { p: 1, duration: 0.9, ease: 'power2.out' }, 2.85)
  if (pillRun) tl.fromTo(s.pill, { k: 0 }, { k: 1, duration: 0.5, ease: 'back.out(1.8)' }, Math.min(rollEnd - 0.5, 2.2))
  if (noteSprite) tl.fromTo(s.note, { p: 0 }, { p: 1, duration: 0.6, ease: 'expo.out' }, Math.min(rollEnd - 0.5, 2.2) + 0.15)
  tl.seek(0)

  // ---------------------------------------------------------------- frames
  const labelDone = () => !labelRun || (s.label.p >= 1 && s.marker.k >= 1)
  const drawLabel = () => {
    g_.fill(marker, accent, { transform: affine(...markerAt) })
    g_.draw(label)
  }
  let g_ = null
  return {
    state(i) {
      tl.seek(i / ctx.fps, false)
      return s
    },
    draw(g) {
      g_ = g
      const gridDone = s.grid.map((o) => o.p >= 1)
      const numDone = s.slots.every((o, i) => o.pos >= slots[i].target) && (!staticSprite || s.statics.o >= 1)
      const chartDone = s.chart.p >= 1
      const pillDone = !pillRun || s.pill.k >= 1
      const noteDone = !noteSprite || s.note.p >= 1

      g.layer(['bg', gridDone, labelDone(), chartDone, numDone, pillDone, noteDone].join(), () => {
        g.draw(bg)
        grids.forEach((sp, i) => gridDone[i] && g.draw(sp))
        if (labelRun && labelDone()) drawLabel()
        if (chartDone) {
          g.draw(area)
          g.draw(line)
        }
        if (numDone) g.draw(numSprite)
        if (pillRun && pillDone) for (const part of pillParts) g.fill(part.path, part.color, { transform: affine(pillCx, pillCy) })
        if (noteDone && noteSprite) g.draw(noteSprite)
      })

      // Rolling digits first, masked to the number's window: the mask bands repaint the
      // background, so every other overlay is drawn after them.
      if (!numDone) {
        let any = false
        slots.forEach((sl, i) => {
          const pos = s.slots[i].pos
          const base = Math.floor(pos)
          const frac = pos - base
          for (const [n, off] of [
            [base, -frac],
            [base + 1, 1 - frac],
          ]) {
            if (n < 0 || off >= 0.8 || off <= -0.8) continue
            any = true
            g.fill(digitPaths[n % 10], theme.fg, { transform: affine(sl.x, NUM_BASE + off * size) })
          }
        })
        if (any) {
          g.draw(bg, { clip: [numX0, winTop - band, numX1, winTop] })
          g.draw(bg, { clip: [numX0, winBot, numX1, winBot + band] })
          // Put back what the mask bands covered.
          const inBand = (y) => y >= winTop - band && y < winBot + band
          if (labelRun && labelDone() && inBand(LABEL_BASE)) drawLabel()
          grids.forEach((sp, i) => {
            const y = [CHART.y0, (CHART.y0 + CHART.y1) / 2, CHART.y1][i]
            if (gridDone[i] && inBand(y)) g.draw(sp, { clip: [numX0, winBot, numX1, winBot + band] })
          })
          if (chartDone) {
            g.draw(area, { clip: [numX0, winBot, numX1, winBot + band] })
            g.draw(line, { clip: [numX0, winBot, numX1, winBot + band] })
          } else if (s.chart.p > 0) {
            const [hx] = headAt(s.chart.p)
            g.draw(area, { clip: [numX0, winBot, Math.min(numX1, hx), winBot + band] })
            g.draw(line, { clip: [numX0, winBot, Math.min(numX1, hx), winBot + band] })
          }
        }
      }

      if (!numDone && staticSprite && s.statics.o > 0) g.draw(staticSprite, { opacity: s.statics.o })

      // Gridlines drawing in.
      grids.forEach((sp, i) => {
        const pr = s.grid[i].p
        if (pr > 0 && !gridDone[i]) g.draw(sp, { clip: [CHART.x0, 0, CHART.x0 + (CHART.x1 - CHART.x0) * pr, H] })
      })

      // Label.
      if (labelRun && !labelDone()) {
        const mk = s.marker.k
        if (mk > 0) g.fill(marker, accent, { transform: affine(markerAt[0], markerAt[1], 90 * (1 - mk), mk) })
        if (s.label.p > 0) g.draw(label, { opacity: Math.min(1, s.label.p * 2), clip: [0, 0, PAD_X + 28 + (labelRun.advance + 8) * s.label.p, H] })
      }

      // Chart wipe and head.
      if (s.chart.p > 0 && !chartDone) {
        const [hx] = headAt(s.chart.p)
        g.draw(area, { clip: [0, 0, hx, H] })
        g.draw(line, { clip: [0, 0, hx, H] })
      }
      if (s.head.o > 0) {
        const [hx, hy] = headAt(s.chart.p)
        g.fill(halo, accent, { alpha: 0.18 * s.head.o, transform: affine(hx, hy) })
        g.fill(dotRing, theme.bg, { alpha: s.head.o, transform: affine(hx, hy) })
        g.fill(dot, accent, { alpha: s.head.o, transform: affine(hx, hy) })
        const pp = s.pulse.p
        if (pp > 0 && pp < 1) g.fill(pulse, accent, { alpha: 0.7 * (1 - pp), transform: affine(hx, hy, 0, 1 + pp * 2.6) })
      }

      // Delta pill and note.
      if (pillRun && !pillDone && s.pill.k > 0) {
        const k = s.pill.k
        for (const part of pillParts) g.fill(part.path, part.color, { alpha: Math.min(1, k * 2), transform: affine(pillCx, pillCy, 0, 0.6 + 0.4 * k) })
      }
      if (noteSprite && !noteDone && s.note.p > 0) {
        g.draw(noteSprite, { opacity: s.note.p, clip: [0, 0, pillX + pillW + 18 + (noteRun.advance + 8) * s.note.p, H] })
      }
    },
    dispose: () => tl.kill(),
  }
}

/** A small solid triangle pointing up (sign > 0) or down, centred on (cx, cy). */
function triPath(cx, cy, sign) {
  const h = 7 * sign
  return [0, cx, cy - h, 1, cx + 8, cy + h, 1, cx - 8, cy + h, 4]
}
