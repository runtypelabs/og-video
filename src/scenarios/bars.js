// bars: an animated bar chart from a short data array. Gridlines draw in, the title wipes on, the
// bars grow in a staggered wave with their values counting up as they ride the bar tops, the
// highlighted bar lands in the accent colour, and a dashed average line sweeps across last.
//
// The first 15 frames (0.5 s, the gridlines) depend only on accent and theme.
//
// Growing bars are two live fills (a body rect scaled vertically and a rounded cap moved to the
// top), so the rounded corners never squash. Counting labels are assembled from tabular-figure
// digit paths built once in setup, so nothing is shaped per frame. Settled bars and labels are
// sprites in a cached layer.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, transform } from '../gfx.js'
import { W, H, THEMES, background, mix, hex, affine } from './showcase-kit.js'

const PAD_X = 80
const TITLE_BASE = 112
const BASE_Y = 540
const TOP_Y = 206
const BARS_AT = 0.5

export const bars = defineScenario({
  id: 'bars',
  version: 1,
  video: { width: W, height: H, fps: 30, frames: 210 },
  params: p.object({
    title: p.string({ max: 60, default: 'Renders by region, this week' }),
    data: p.array(p.number({ min: 0, max: 1e9 }), { min: 1, max: 12, default: [18240, 42610, 31420, 27930, 12310, 15840, 9620, 6110] }),
    labels: p.array(p.string({ max: 10 }), { max: 12, default: ['SFO', 'IAD', 'LHR', 'FRA', 'NRT', 'SIN', 'SYD', 'GRU'] }),
    unit: p.string({ max: 4, default: '' }),
    highlight: p.enum(['max', 'min', 'last', 'none'], { default: 'max' }),
    average: p.bool({ default: true }),
    accent: p.color({ default: '#3b82f6' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 15, key: (q) => `${q.accent}|${q.theme}` },
  meta: (q) => ({ title: q.title || 'Bar chart' }),
  setup,
})

/** Number formatting without Intl (deterministic across runtimes). */
function fmt(v, decimals) {
  const [int, frac] = v.toFixed(decimals).split('.')
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '')
}

/** Dashes along a horizontal line, as one path, leaving out the x ranges in `skip`. */
function dashes(x0, x1, y, on = 8, off = 7, h = 2, skip = []) {
  const out = []
  for (let x = x0; x < x1; x += on + off) {
    const e = Math.min(x + on, x1)
    if (skip.some(([a, b]) => e > a && x < b)) continue
    out.push(...rect(x, y, e, y + h))
  }
  return out
}

function setup(ctx, q) {
  const { text } = ctx
  const theme = THEMES[q.theme]
  const accent = hex(q.accent)
  const barColor = q.theme === 'dark' ? mix(theme.bg, 0xffffff, 0.16) : mix(theme.bg, 0x000000, 0.13)
  const bg = background(ctx, theme, accent, { glowAt: [W * 0.5, H + 160], radius: 900 })

  // Big values are shown compact (42,610 -> 42.6k) unless a unit is given.
  const peak = Math.max(...q.data)
  const [scale, compact] = q.unit ? [1, ''] : peak >= 1e7 ? [1e6, 'M'] : peak >= 1e4 ? [1e3, 'k'] : [1, '']
  const unit = q.unit || compact
  const data = q.data.map((v) => v / scale)
  const n = data.length
  const max = Math.max(...data) || 1
  const decimals = data.some((v) => !Number.isInteger(v)) ? 1 : 0
  const hi =
    q.highlight === 'none' ? -1 : q.highlight === 'last' ? n - 1 : data.indexOf(q.highlight === 'max' ? Math.max(...data) : Math.min(...data))

  // ---------------------------------------------------------------- title + grid
  const titleRun = q.title ? text.fit('semibold', q.title, 44, W - 2 * PAD_X, { letterSpacing: -0.9 }) : null
  const title = titleRun ? ctx.sprite([{ cmds: titleRun.cmds(PAD_X, TITLE_BASE), color: theme.fg }], { margin: 4 }) : null
  const gridYs = [0, 1, 2, 3].map((i) => Math.round(TOP_Y + ((BASE_Y - TOP_Y) * i) / 4))
  const grids = gridYs.map((y) => ctx.sprite([{ cmds: dashes(PAD_X, W - PAD_X, y, 2, 6, 1), color: theme.muted, alpha: 0.35 }], { margin: 1 }))
  const axis = ctx.sprite([{ cmds: rect(PAD_X, BASE_Y, W - PAD_X, BASE_Y + 1), color: theme.muted, alpha: 0.6 }], { margin: 1 })

  // ---------------------------------------------------------------- bars
  const slot = (W - 2 * PAD_X) / n
  const bw = Math.round(Math.min(104, slot * 0.6))
  const r = Math.min(10, Math.floor(bw / 4))
  const maxH = BASE_Y - TOP_Y - 8
  const LABEL = 24
  const glyphs = new Map()
  const glyph = (ch, size) => {
    const key = `${ch}@${size}`
    if (!glyphs.has(key)) {
      const run = text.run('semibold', ch, size, { features: { tnum: true } })
      const cmds = run.cmds(0, 0)
      glyphs.set(key, { cmds, path: ctx.path(cmds), adv: run.advance })
    }
    return glyphs.get(key)
  }
  const unitRun = unit ? text.run('semibold', unit, LABEL) : null
  const unitCmds = unitRun ? unitRun.cmds(0, 0) : null
  const unitPath = unitRun ? ctx.path(unitCmds) : null
  /** Paths for a value label centred on cx with its baseline at y. */
  const labelParts = (v) => {
    const parts = []
    let x = 0
    for (const ch of fmt(v, decimals)) {
      const gl = glyph(ch, LABEL)
      parts.push({ path: gl.path, cmds: gl.cmds, x })
      x += gl.adv
    }
    if (unitRun) {
      x += 1
      parts.push({ path: unitPath, cmds: unitCmds, x })
      x += unitRun.advance
    }
    return { parts, w: x }
  }

  const items = data.map((v, i) => {
    const cx = PAD_X + slot * (i + 0.5)
    const x = Math.round(cx - bw / 2)
    const h = Math.max(2, Math.round((v / max) * maxH))
    const color = i === hi ? accent : barColor
    const labelColor = i === hi ? theme.fg : theme.muted
    const final = labelParts(v)
    const lx = Math.round((cx - final.w / 2) * 4) / 4
    const ly = BASE_Y - h - 14
    const cat = q.labels[i] ? text.fit('regular', q.labels[i], 22, slot - 8) : null
    return {
      cx,
      x,
      h,
      color,
      labelColor,
      sprite: ctx.sprite([{ cmds: [...rrect(x, BASE_Y - h, bw, h, Math.min(r, h / 2)), ...rect(x, BASE_Y - Math.min(r, h / 2), x + bw, BASE_Y)], color }], { margin: 2 }),
      // Settled value label: the same digit paths, placed the way the live label places them.
      label: ctx.sprite(
        final.parts.map((pt) => ({ cmds: transform(pt.cmds, 1, lx + pt.x, ly), color: labelColor })),
        { margin: 4 },
      ),
      cat: cat ? ctx.sprite([{ cmds: cat.cmds(Math.round(cx - cat.advance / 2), BASE_Y + 36), color: i === hi ? theme.fg : theme.muted }], { margin: 4 }) : null,
    }
  })
  const capPath = ctx.path(rrect(0, 0, bw, 2 * r, r))
  const bodyPath = ctx.path(rect(0, 0, bw, 1))

  // ---------------------------------------------------------------- average line
  const mean = data.reduce((a, b) => a + b, 0) / n
  const avgY = Math.round(BASE_Y - (mean / max) * maxH)
  const avgRun = text.run('semibold', `avg ${fmt(mean, decimals)}${unit}`, 20)
  const tagW = Math.ceil(avgRun.advance + 20)
  const tagX = W - PAD_X - tagW
  // The line passes behind the bars and breaks around any value label it would cross.
  const skip = []
  items.forEach((it, i) => {
    if (it.h >= BASE_Y - avgY - 1) skip.push([it.x - 6, it.x + bw + 6])
    const w = labelParts(data[i]).w
    const ly = BASE_Y - it.h - 14
    if (avgY > ly - 32 && avgY < ly + 10) skip.push([it.cx - w / 2 - 8, it.cx + w / 2 + 8])
  })
  const avgLine = q.average && n > 1 ? ctx.sprite([{ cmds: dashes(PAD_X, tagX - 10, avgY - 1, 8, 6, 2, skip), color: theme.fg, alpha: 0.6 }], { margin: 2 }) : null
  const avgTag = avgLine
    ? ctx.sprite(
        [
          { cmds: rrect(tagX, avgY - 15, tagW, 30, 15), color: theme.fg },
          { cmds: avgRun.cmds(tagX + 10, avgY + 7), color: theme.bg },
        ],
        { margin: 2 },
      )
    : null

  // ---------------------------------------------------------------- timeline
  const s = {
    grid: [...grids, axis].map(() => ({ p: 0 })),
    title: { p: 0 },
    bars: items.map(() => ({ k: 0 })),
    cats: { o: 0 },
    avg: { p: 0, o: 0 },
  }
  const tl = gsap.timeline({ paused: true })
  s.grid.forEach((o, i) => tl.fromTo(o, { p: 0 }, { p: 1, duration: 0.5, ease: 'expo.inOut' }, i * 0.05 - (i === 4 ? 0.15 : 0) + 0.05))
  if (title) tl.fromTo(s.title, { p: 0 }, { p: 1, duration: 0.7, ease: 'expo.out' }, BARS_AT)
  const stagger = Math.min(0.08, 0.7 / n)
  items.forEach((_, i) => tl.fromTo(s.bars[i], { k: 0 }, { k: 1, duration: 1.1, ease: 'expo.out' }, BARS_AT + 0.15 + i * stagger))
  tl.fromTo(s.cats, { o: 0 }, { o: 1, duration: 0.5, ease: 'power2.out' }, BARS_AT + 0.2)
  const barsEnd = BARS_AT + 0.15 + (n - 1) * stagger + 1.1
  if (avgLine) {
    tl.fromTo(s.avg, { p: 0 }, { p: 1, duration: 0.8, ease: 'expo.inOut' }, barsEnd - 0.5)
    tl.fromTo(s.avg, { o: 0 }, { o: 1, duration: 0.3, ease: 'power2.out', immediateRender: false }, barsEnd + 0.15)
  }
  tl.seek(0)

  // ---------------------------------------------------------------- frames
  const gridSprites = [...grids, axis]
  return {
    state(i) {
      tl.seek(i / ctx.fps, false)
      return s
    },
    draw(g) {
      const gDone = s.grid.map((o) => o.p >= 1)
      const tDone = !title || s.title.p >= 1
      const bDone = s.bars.map((o) => o.k >= 1)
      const cDone = s.cats.o >= 1
      const aDone = !avgLine || (s.avg.p >= 1 && s.avg.o >= 1)
      g.layer('bg', () => g.draw(bg))
      g.layer([gDone, tDone, bDone, cDone, aDone].join(), () => {
        gridSprites.forEach((sp, i) => gDone[i] && g.draw(sp))
        if (title && tDone) g.draw(title)
        items.forEach((it, i) => {
          if (!bDone[i]) return
          g.draw(it.sprite)
          g.draw(it.label)
        })
        if (cDone) items.forEach((it) => it.cat && g.draw(it.cat))
        if (avgLine && aDone) {
          g.draw(avgLine)
          g.draw(avgTag)
        }
      })

      gridSprites.forEach((sp, i) => {
        const pr = s.grid[i].p
        if (pr > 0 && !gDone[i]) g.draw(sp, { clip: [PAD_X, 0, PAD_X + (W - 2 * PAD_X) * pr, H] })
      })
      if (title && !tDone && s.title.p > 0) {
        g.draw(title, { opacity: Math.min(1, s.title.p * 1.5), clip: [0, 0, PAD_X + (titleRun.advance + 8) * s.title.p, H] })
      }
      if (!cDone && s.cats.o > 0) items.forEach((it) => it.cat && g.draw(it.cat, { opacity: s.cats.o }))

      items.forEach((it, i) => {
        const k = s.bars[i].k
        if (k <= 0 || bDone[i]) return
        const h = it.h * k
        if (h < 0.5) return
        if (h >= 2 * r) {
          g.fill(bodyPath, it.color, { transform: [1, 0, 0, h - r, it.x, BASE_Y - h + r] })
          g.fill(capPath, it.color, { transform: affine(it.x, BASE_Y - h) })
        } else g.fill(capPath, it.color, { transform: [1, 0, 0, h / (2 * r), it.x, BASE_Y - h] })
        const { parts, w } = labelParts(data[i] * k)
        const lx = Math.round((it.cx - w / 2) * 4) / 4
        const ly = Math.round(BASE_Y - h - 14)
        const a = Math.min(1, k * 3)
        for (const pt of parts) g.fill(pt.path, it.labelColor, { alpha: a, transform: affine(lx + pt.x, ly) })
      })

      if (avgLine && !aDone) {
        if (s.avg.p > 0) g.draw(avgLine, { clip: [0, 0, PAD_X + (tagX - PAD_X) * s.avg.p, H] })
        if (s.avg.o > 0) g.draw(avgTag, { opacity: s.avg.o })
      }
    },
    dispose: () => tl.kill(),
  }
}
