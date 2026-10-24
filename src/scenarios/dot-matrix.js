// dot-matrix: a product card whose right-hand panel cycles through dot-matrix illustrations. Each
// icon is drawn once as flat vector shapes, sampled onto a grid of square dots (brighter shapes
// give brighter dots), and dissolves in and out dot by dot, sweeping left to right with some
// noise. Its label is pixel-font dots that dissolve with it. The left half is a static headline.
//
// The first 12 frames (0.4 s, the panel sliding in) depend only on the accent, so they are one
// prefix per accent. While an icon holds, frames are identical and skipped; a dissolve touches
// only the panel, so each frame costs a few hundred microseconds.
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, ellipse } from '../gfx.js'
import { pixelText } from '../pixelfont.js'
import { prng } from './showcase-kit.js'

const W = 1200
const H = 630
const SPLIT = 624
const PAD = 72
const PANEL_IN = 0.4
const ITEMS_AT = 0.75
const DOT_IN = 0.55
const DOT_OUT = 0.4
/** The icon box (local units = frame px), centred in the panel above the label. */
const BOX_W = 360
const BOX_H = 234
const PITCH = 6
const LABEL_PITCH = 6
/** Each icon starts dissolving in while the previous one is still dissolving out. */
const OVERLAP = 0.2

const ICONS = ['search', 'brand', 'map', 'monitor', 'scrape', 'code', 'chart']
/** The label an icon gets when none is given. */
const LABELS = { search: 'search', brand: 'logos', map: 'sitemap', monitor: 'monitor', scrape: 'scrape', code: 'code', chart: 'charts' }

export const dotMatrix = defineScenario({
  id: 'dot-matrix',
  version: 1,
  video: { width: W, height: H, fps: 30, frames: 210 },
  params: p.object({
    title: p.string({ max: 90, default: 'Search, map and monitor the web from one API.' }),
    brand: p.string({ max: 32, default: 'Acme' }),
    url: p.string({ max: 40, default: 'acme.dev' }),
    accent: p.color({ default: '#2459e6' }),
    items: p.array(
      p.object({
        icon: p.enum(ICONS),
        label: p.string({ max: 10, default: '', pattern: /^[A-Za-z0-9 .!+/-]*$/ }),
      }),
      {
        min: 1,
        max: 6,
        default: () => ['search', 'brand', 'map', 'monitor'].map((icon) => ({ icon, label: LABELS[icon] })),
      },
    ),
  }),
  prefix: { frames: 12, key: (q) => q.accent },
  meta: (q) => ({ title: q.title, description: q.url || undefined }),
  setup,
})

// ---------------------------------------------------------------- icon art
// Each icon is a list of layers in a BOX_W x BOX_H box: white shapes whose alpha becomes dot
// brightness. Outlines are even-odd pairs, since the compositor fills but does not stroke.

const white = (cmds, alpha = 1, evenodd = false) => ({ cmds, color: 0xffffff, alpha, evenodd })
const frame = (x, y, w, h, t, r = 0) => [...rrect(x, y, w, h, r), ...rrect(x + t, y + t, w - 2 * t, h - 2 * t, Math.max(0, r - t))]
const ring = (cx, cy, r, t) => [...ellipse(cx, cy, r), ...ellipse(cx, cy, r - t)]

/** A thick segment from (x0, y0) to (x1, y1) as a quad. */
function bar(x0, y0, x1, y1, t) {
  const dx = x1 - x0, dy = y1 - y0
  const k = t / 2 / Math.hypot(dx, dy)
  const nx = -dy * k, ny = dx * k
  return [0, x0 + nx, y0 + ny, 1, x1 + nx, y1 + ny, 1, x1 - nx, y1 - ny, 1, x0 - nx, y0 - ny, 4]
}

/** Rows of "words": dashes of seeded lengths, optionally only the parts inside a circle. */
function textLines({ x, y, w, rows, gap = 21, h = 7, seed, inside }) {
  const rnd = prng(seed)
  const out = []
  for (let r = 0; r < rows; r++) {
    const ry = y + r * gap
    let cx = x
    const end = x + w * (0.72 + 0.28 * rnd())
    while (cx < end) {
      const len = 14 + rnd() * 70
      let a = cx, b = Math.min(cx + len, end)
      if (inside) {
        const dy = ry + h / 2 - inside.cy
        const half = Math.sqrt(Math.max(0, inside.r * inside.r - dy * dy))
        a = Math.max(a, inside.cx - half)
        b = Math.min(b, inside.cx + half)
      }
      if (b - a > 3) out.push(...rect(a, ry, b, ry + h))
      cx += len + 7 + rnd() * 6
    }
  }
  return out
}

/** Applies [a, b, c, d, e, f] to every point of a command buffer. */
function mapCmds(cmds, [a, b, c, d, e, f]) {
  const args = [2, 2, 4, 6, 0]
  const out = []
  for (let i = 0; i < cmds.length; ) {
    const n = args[cmds[i]]
    out.push(cmds[i])
    for (let j = 0; j < n; j += 2) {
      const x = cmds[i + 1 + j], y = cmds[i + 2 + j]
      out.push(a * x + c * y + e, b * x + d * y + f)
    }
    i += 1 + n
  }
  return out
}

const rotateAbout = (deg, cx, cy) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
}

const ART = {
  search() {
    const lens = { cx: 112, cy: 98, r: 64 }
    return [
      white(textLines({ x: 0, y: 4, w: BOX_W, rows: 11, seed: 'search' }), 0.55),
      white(ellipse(lens.cx, lens.cy, lens.r - 9), 0.12),
      white(textLines({ x: 0, y: 4, w: BOX_W, rows: 11, seed: 'search', inside: { ...lens, r: lens.r - 12 } }), 1),
      white(ring(lens.cx, lens.cy, lens.r, 11), 1, true),
      white(bar(158, 146, 208, 200, 16), 1),
    ]
  },
  brand() {
    return [
      white([...rrect(150, 6, 206, 210, 16), ...ellipse(226, 120, 50)], 0.5, true),
      white(ellipse(226, 120, 50), 0.1),
      white(ellipse(92, 168, 70), 0.85),
    ]
  },
  map() {
    const dash = []
    // Dashes on the dot grid (every other dot), so each one lands on exactly one dot.
    for (let x = 0; x < BOX_W; x += 2 * PITCH) dash.push(...rect(x, 0, x + PITCH, PITCH), ...rect(x, BOX_H - PITCH, x + PITCH, BOX_H))
    for (let y = 2 * PITCH; y < BOX_H - PITCH; y += 2 * PITCH) dash.push(...rect(0, y, PITCH, y + PITCH), ...rect(BOX_W - PITCH, y, BOX_W, y + PITCH))
    const tiles = [], marks = []
    const tw = (BOX_W - 28 - 20) / 3, th = (BOX_H - 28 - 10) / 2
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        const x = 14 + c * (tw + 10), y = 14 + r * (th + 10)
        tiles.push(...rrect(x, y, tw, th, 6))
        marks.push(...bar(x + 14, y + th - 22, x + tw * 0.45, y + th * 0.45, 5), ...bar(x + tw * 0.45, y + th * 0.45, x + tw - 16, y + th - 34, 5))
      }
    }
    return [white(dash, 0.95), white(tiles, 0.42), white(marks, 0.8)]
  },
  monitor() {
    const peaks = [0.2, 0.35, 0.3, 0.5, 0.42, 0.62, 0.48, 0.7, 0.55, 0.4, 0.5, 0.3]
    const x0 = 14, x1 = BOX_W - 14, base = BOX_H - 14
    const pts = peaks.map((v, i) => [x0 + ((x1 - x0) * i) / (peaks.length - 1), base - v * 82])
    const area = [0, x0, base, ...pts.flatMap(([x, y]) => [1, x, y]), 1, x1, base, 4]
    const ridge = pts.slice(1).flatMap(([x, y], i) => bar(pts[i][0], pts[i][1], x, y, 5))
    return [
      white(frame(0, 0, BOX_W, BOX_H, 6, 10), 1, true),
      white([...ellipse(22, 20, 4), ...ellipse(36, 20, 4), ...ellipse(50, 20, 4)], 0.9),
      white(rect(6, 34, BOX_W - 6, 39), 0.8),
      white(rect(22, 56, BOX_W - 22, 66), 0.95),
      white(textLines({ x: 22, y: 80, w: 220, rows: 3, gap: 16, h: 5, seed: 'monitor' }), 0.5),
      white(area, 0.42),
      white(ridge, 1),
    ]
  },
  scrape() {
    const pages = []
    ;[[22, -4], [136, 2], [250, -3]].forEach(([x, deg], i) => {
      const m = rotateAbout(deg, x + 46, 128)
      pages.push(
        white(mapCmds(rrect(x, 62, 92, 130, 6), m), 0.45),
        white(mapCmds(textLines({ x: x + 10, y: 78, w: 72, rows: 6, gap: 17, h: 5, seed: `page${i}` }), m), 0.9),
      )
    })
    const scan = []
    for (let x = 0; x < BOX_W; x += 10) scan.push(...rect(x, 110, x + 6, 115))
    return [...pages, white(scan, 1)]
  },
  code() {
    const lines = textLines({ x: 96, y: 40, w: 168, rows: 8, gap: 21, h: 7, seed: 'code' })
    return [
      white([...bar(62, 60, 14, 118, 13), ...bar(14, 118, 62, 176, 13)], 1),
      white([...bar(298, 60, 346, 118, 13), ...bar(346, 118, 298, 176, 13)], 1),
      white(lines, 0.55),
      white(rect(96, 40, 176, 47), 1),
    ]
  },
  chart() {
    const vals = [0.35, 0.55, 0.45, 0.75, 0.6, 0.92]
    const bw = 40, gap = (BOX_W - vals.length * bw) / (vals.length + 1)
    const bars = vals.flatMap((v, i) => rrect(gap + i * (bw + gap), BOX_H - 10 - v * 190, bw, v * 190, 5))
    return [white(rect(0, BOX_H - 6, BOX_W, BOX_H), 0.9), white(bars, 0.5), white(bars.slice(-26), 0.6)]
  },
}

// ---------------------------------------------------------------- setup

function setup(ctx, q) {
  const { text } = ctx
  const accent = q.accent
  const ink = 0x111113

  // Left: brand mark and name, the headline, and the URL pill.
  const markAt = [PAD, 62]
  const mark = ctx.sprite([
    { cmds: rrect(markAt[0] + 8, markAt[1], 18, 18, 3), color: accent },
    { cmds: ellipse(markAt[0] + 8, markAt[1] + 14, 8), color: accent, alpha: 0.75 },
  ], { margin: 4 })
  const brandRun = text.fit('semibold', q.brand, 24, SPLIT - 2 * PAD - 40, { letterSpacing: -0.3 })
  const brand = ctx.sprite([{ cmds: brandRun.cmds(PAD + 36, markAt[1] + 18), color: ink }], { margin: 4 })

  let size = 56
  let lines
  for (; size >= 36; size -= 4) {
    lines = text.wrap('regular', q.title, size, SPLIT - 2 * PAD - 8, { letterSpacing: -0.02 * size, maxLines: 4 })
    if (lines.length <= 3 || size === 36) break
  }
  const lh = Math.round(size * 1.14)
  const top = Math.round(300 - (lines.length * lh) / 2)
  const asc = text.baselineIn('regular', size, lh)
  const headline = lines.map((l, i) => ctx.sprite(l.words.map((w) => ({ cmds: w.run.cmds(PAD + w.x, top + i * lh + asc), color: ink })), { margin: 8 }))

  const urlRun = q.url ? text.fit('regular', q.url, 22, SPLIT - 2 * PAD - 48) : null
  const pillW = urlRun ? Math.ceil(urlRun.advance) + 40 : 0
  const pillY = H - PAD - 46
  const pill = urlRun
    ? ctx.sprite([
        { cmds: [...rrect(PAD, pillY, pillW, 46, 23), ...rrect(PAD + 1.5, pillY + 1.5, pillW - 3, 43, 21.5)], color: accent, evenodd: true },
        { cmds: urlRun.cmds(PAD + 20, pillY + 30), color: accent },
      ], { margin: 4 })
    : null
  const leftParts = [[mark, brand], ...headline.map((h) => [h]), pill ? [pill] : []]

  // Right: the panel, and one dot field per item (icon + label).
  const panel = ctx.path(rect(0, 0, W - SPLIT, H))
  const pcx = SPLIT + (W - SPLIT) / 2
  const boxX = Math.round(pcx - BOX_W / 2)
  const boxY = 132
  const items = q.items.map((it, i) => {
    const art = ART[it.icon]().map((l) => ({ ...l, cmds: mapCmds(l.cmds, [1, 0, 0, 1, boxX, boxY]) }))
    const icon = ctx.dots(ctx.sprite(art, { margin: 0 }), {
      box: [boxX, boxY, BOX_W, BOX_H],
      pitch: PITCH,
      size: 4,
      seed: i + 1,
      // Mostly a left-to-right sweep, broken up with noise.
      order: (d, r) => 0.55 * d.u + 0.45 * r,
    })
    const label = (it.label || LABELS[it.icon]).toUpperCase()
    const px = pixelText(label)
    const lw = px.cols * LABEL_PITCH
    const lx = Math.round(pcx - lw / 2), ly = boxY + BOX_H + 66
    const cells = px.cells.flatMap(([c, r]) => rect(lx + c * LABEL_PITCH, ly + r * LABEL_PITCH, lx + (c + 1) * LABEL_PITCH, ly + (r + 1) * LABEL_PITCH))
    const labelDots = cells.length
      ? ctx.dots(ctx.sprite([{ cmds: cells, color: 0xffffff, alpha: 0.9 }], { margin: 0 }), {
          box: [lx, ly, lw, 5 * LABEL_PITCH],
          pitch: LABEL_PITCH,
          size: 4,
          seed: 100 + i,
          order: (d, r) => 0.3 * d.u + 0.7 * r,
        })
      : null
    return { icon, label: labelDots }
  })

  // ---------------------------------------------------------------- timeline
  const n = items.length
  const slot = (7 - ITEMS_AT) / n
  const expoOut = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
  const cubicOut = (t) => 1 - (1 - t) ** 3
  const clamp01 = (t) => Math.max(0, Math.min(1, t))
  const q3 = (v) => Math.round(v * 1000) / 1000

  return {
    state(i) {
      const t = i / ctx.fps
      const panelX = q3(expoOut(clamp01(t / PANEL_IN)))
      const left = leftParts.map((_, k) => q3(cubicOut(clamp01((t - 0.3 - k * 0.07) / 0.45))))
      const dots = items.map((_, k) => {
        const t0 = ITEMS_AT + k * slot
        const inP = clamp01((t - t0 + (k > 0 ? OVERLAP : 0)) / DOT_IN)
        // The last icon stays, so the poster (last frame) shows it.
        const outP = k === n - 1 ? 0 : clamp01((t - (t0 + slot - DOT_OUT)) / DOT_OUT)
        return outP > 0 ? { p: q3(1 - cubicOut(outP)), out: true } : { p: q3(cubicOut(inP)), out: false }
      })
      return { panelX, left, dots }
    },
    draw(g, s) {
      g.layer(s.panelX >= 1 ? 'panel' : `panel${s.panelX}`, () => {
        g.clear(0xffffff)
        const x0 = W - (W - SPLIT) * s.panelX
        g.fill(panel, accent, { transform: [1, 0, 0, 1, x0, 0] })
      })
      const settled = s.left.every((v) => v >= 1)
      const drawLeft = () =>
        leftParts.forEach((parts, k) => {
          const v = s.left[k]
          if (v <= 0) return
          for (const sp of parts) g.draw(sp, { opacity: v, transform: [1, 0, 0, 1, 0, Math.round((1 - v) * 14)] })
        })
      if (settled) g.layer('left', drawLeft)
      else drawLeft()
      items.forEach((it, k) => {
        const d = s.dots[k]
        if (d.p <= 0) return
        g.dots(it.icon, { progress: d.p, softness: 0.18, grow: true, color: 0xffffff, reverse: d.out })
        g.dots(it.label, { progress: d.p, softness: 0.25, grow: true, color: 0xffffff, opacity: 0.9, reverse: d.out })
      })
    },
  }
}
