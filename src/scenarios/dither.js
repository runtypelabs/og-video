// dither: an aurora drawn as an ordered (Bayer 8x8) dither, after dithercn's Aurora
// (github.com/opencoredev/dithercn, MIT). The aurora rises out of the dark in Bayer order and
// keeps flowing at the full frame rate; the title dithers in, then resolves to solid type.
//
// There is no shader here. The aurora's tone is evaluated on the CPU at a few keyframes (once
// per isolate), and every frame blends the two around it, drifts it sideways and re-quantizes it
// against a Bayer matrix fixed to the screen, so cells flip as the light moves, like dithercn's
// shader. g.cells draws the result; nothing is cached, since every frame differs.
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect } from '../gfx.js'
import { W, H, hex, mix } from './showcase-kit.js'

const PAD_X = 80
const PAD_Y = 72
/** Aurora cell pitch and dot size, frame px (4 and 3 output px at og.video's 960 wide). */
const PITCH = 5
const DOT = 4
/** Aurora keyframes across the video, and the field time between them. */
const KEYS = 6
const KEY_DT = 3
/** Sideways flow, frame px a second. */
const DRIFT = 22
const AURORA_IN = [0, 1.5]
const TITLE_IN = [0.8, 2.0]
const TITLE_SOLID = [2.0, 2.5]
const META_IN = 2.2

export const dither = defineScenario({
  id: 'dither',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  params: p.object({
    title: p.string({ max: 80, min: 1, default: 'Dithers for anything your agent builds' }),
    kicker: p.string({ max: 32, default: 'Now in Persona' }),
    brand: p.string({ max: 32, default: 'RUNTYPE' }),
    accent: p.color({ default: '#5b8cff' }),
  }),
  meta: (q) => ({ title: q.title, description: q.kicker || undefined }),
  setup,
})

// ---------------------------------------------------------------- noise
// snoise and fbm are dithercn's GLSL helpers (Ashima simplex noise), line for line in JS.

const C0 = 0.211324865405187, C1 = 0.366025403784439, C2 = -0.577350269189626, C3 = 0.024390243902439
const mod289 = (x) => x - Math.floor(x / 289) * 289
const permute = (x) => mod289((x * 34 + 1) * x)

function snoise(vx, vy) {
  const s = (vx + vy) * C1
  let ix = Math.floor(vx + s), iy = Math.floor(vy + s)
  const t = (ix + iy) * C0
  const x0 = vx - ix + t, y0 = vy - iy + t
  const i1x = x0 > y0 ? 1 : 0, i1y = 1 - i1x
  const x1 = x0 + C0 - i1x, y1 = y0 + C0 - i1y
  const x2 = x0 + C2, y2 = y0 + C2
  ix = mod289(ix)
  iy = mod289(iy)
  const p0 = permute(permute(iy) + ix)
  const p1 = permute(permute(iy + i1y) + ix + i1x)
  const p2 = permute(permute(iy + 1) + ix + 1)
  let n = 0
  for (const [pp, x, y] of [[p0, x0, y0], [p1, x1, y1], [p2, x2, y2]]) {
    let m = Math.max(0.5 - (x * x + y * y), 0)
    m *= m
    m *= m
    const gx = 2 * (pp * C3 - Math.floor(pp * C3)) - 1
    const h = Math.abs(gx) - 0.5
    const a0 = gx - Math.floor(gx + 0.5)
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h)
    n += m * (a0 * x + h * y)
  }
  return 130 * n
}

function fbm(x, y) {
  let sum = 0, amp = 0.5
  for (let i = 0; i < 4; i++) {
    sum += amp * snoise(x, y)
    const nx = 0.8 * x + 0.6 * y, ny = -0.6 * x + 0.8 * y
    x = nx * 2.02 + 11.3
    y = ny * 2.02 + 4.7
    amp *= 0.5
  }
  return Math.min(1, Math.max(0, 0.5 + (0.5 * sum) / 0.9375))
}

// ---------------------------------------------------------------- aurora
// dithercn's Aurora field with its defaults (3 curtains, direction up), the edge set low so the
// title has clean sky. (u, v) is the cell centre with v = 0 at the bottom, as gl_FragCoord.
const AURORA = { curtains: 3, height: 0.12, spread: 0.09, sway: 1.1, turbulence: 0.6, rays: 8, length: 0.62, glow: 0.9, intensity: 0.95, shimmer: 0.2 }

function aurora(u, v, aspect, t) {
  const a = AURORA
  const px = (u - 0.5) * aspect, py = v
  const x = px
  const decay = 15 + (2.2 - 15) * a.length
  let light = 0
  for (let i = 0; i < a.curtains; i++) {
    const depth = i / Math.max(a.curtains - 1, 1)
    const edge = a.height + i * a.spread
      + a.sway * 0.11 * snoise(x * 0.55 + i * 3.1, t * 0.035 + i * 1.7)
      + a.turbulence * 0.05 * snoise(x * 2.1 - i * 1.3, t * 0.07 + i)
    const above = py - edge
    const curtain = above > 0 ? Math.exp(-above * decay * (1 + i * 0.4)) : Math.exp(above * 48)
    const bend = snoise(x * 0.8, t * 0.03 + i) * (0.25 + 0.35 * a.sway)
    const rx = (x + bend) * a.rays
    const sm = (e0, e1, z) => { const k = Math.min(1, Math.max(0, (z - e0) / (e1 - e0))); return k * k * (3 - 2 * k) }
    let rays = 0.2 + 0.8 * sm(0.25, 0.75, fbm(rx + i * 9, t * 0.045 + i))
    rays *= 0.75 + 0.25 * snoise(rx * 3.2, i * 4 + t * 0.02)
    const patch = 0.3 + 0.7 * sm(0.25, 0.7, fbm(x * 0.45 + i * 5, t * 0.02 + i * 2))
    const rim = Math.exp(-Math.abs(above) * 34) * a.glow
    const haze = above > 0 ? Math.exp(-above * 5) * 0.09 : Math.exp(above * 14) * 0.05
    light += (curtain * rays + rim * (0.5 + 0.5 * rays) + haze) * patch * (1 - 0.5 * depth)
  }
  const ripple = 0.5 + 0.5 * Math.sin(t * 0.8 + px * 4 + 2 * snoise(px * 2.5, t * 0.15))
  const tone = (1 - Math.exp(-light * 1.25)) * a.intensity * (1 - a.shimmer * 0.45 * ripple)
  // Fade to paper well below the title (dithercn's mask, set to the band the title leaves free).
  const k = Math.min(1, Math.max(0, (v - 0.36) / (0.64 - 0.36)))
  return tone * (1 - k * k * (3 - 2 * k))
}

// ---------------------------------------------------------------- Bayer

/** Bayer ranks for an n x n matrix (n a power of two), dithercn's bit interleave. */
function bayer(n) {
  const ranks = new Uint8Array(n * n)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let rank = 0
      for (let bit = 1; bit < n; bit *= 2) {
        const xb = Math.floor(x / bit) % 2, yb = Math.floor(y / bit) % 2
        rank = rank * 4 + 2 * ((xb + yb) % 2) + yb
      }
      ranks[y * n + x] = rank
    }
  }
  return ranks
}
const BAYER8 = bayer(8)
/** The Bayer threshold of cell (c, r), halfway between steps, in (0, 1). */
const threshold = (c, r) => (BAYER8[(r & 7) * 8 + (c & 7)] + 0.5) / 64

// ---------------------------------------------------------------- keyframes
// The aurora's tone depends on no param, so each isolate evaluates the noise once per grid size
// and every later render reuses it. A keyframe is wider than the grid by the drift's travel.
const KEYFRAMES = new Map()

function keyframes(cols, rows, top, span, extra) {
  const id = `${cols}x${rows}+${extra}`
  let keys = KEYFRAMES.get(id)
  if (keys) return keys
  const wide = cols + extra
  keys = []
  for (let k = 0; k < KEYS; k++) {
    const tone = new Float32Array(wide * rows)
    for (let r = top; r < rows; r++) {
      const v = 1 - (r + 0.5) / rows
      for (let c = 0; c < wide; c++) tone[r * wide + c] = aurora((c + 0.5) / cols, v, W / H, 4 + k * KEY_DT)
    }
    keys.push(tone)
  }
  KEYFRAMES.set(id, (keys = { keys, wide, span }))
  return keys
}

// ---------------------------------------------------------------- setup

function setup(ctx, q) {
  const { text } = ctx
  const accent = hex(q.accent)
  const bg = 0x08080b
  // dithercn's auroraPalette: paper, two tints of the tip colour, the edge colour, its brightest.
  const palette = [bg, mix(bg, accent, 0.3), mix(bg, accent, 0.7), accent, mix(accent, 0xffffff, 0.5)]
  const steps = palette.length - 1

  const grid = ctx.cells({ pitch: PITCH, size: DOT, palette })
  const { cols, rows, index } = grid
  // The aurora only reaches the lower ~60%: rows above quantize to paper anyway.
  const top = Math.floor(rows * 0.3)
  const end = (ctx.frames - 1) / ctx.fps
  const extra = Math.ceil((DRIFT * end) / grid.step) + 2
  const field = keyframes(cols, rows, top, end, extra)
  // Each cell's Bayer threshold, and its place in the rise: bottom first, broken up in Bayer order.
  const thresholds = new Float32Array(cols * rows)
  const order = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const th = threshold(c, r)
      thresholds[r * cols + c] = th
      order[r * cols + c] = 0.6 * ((r + 0.5) / rows < 0.3 ? 1 : 1 - (r + 0.5) / rows) + 0.4 * th
    }
  }

  /** Fills grid.index for time t: blend the two keyframes around t, drift, re-dither. */
  const paintField = (t, rise) => {
    const { keys, wide } = field
    const f = (t / field.span) * (KEYS - 1)
    const k0 = Math.min(KEYS - 2, Math.floor(f)), w = f - k0
    const a = keys[k0], b = keys[k0 + 1]
    const shift = (DRIFT * t) / grid.step
    const s0 = Math.floor(shift), sf = shift - s0
    index.fill(0, 0, top * cols)
    for (let r = top; r < rows; r++) {
      const row = r * wide + s0
      for (let c = 0; c < cols; c++) {
        const o = r * cols + c
        if (order[o] > rise) { index[o] = 0; continue }
        const j = row + c
        const ta = a[j] + (a[j + 1] - a[j]) * sf
        const tb = b[j] + (b[j + 1] - b[j]) * sf
        const scaled = (ta + (tb - ta) * w) * steps
        const fl = Math.floor(scaled)
        index[o] = Math.min(fl + (scaled - fl > thresholds[o] ? 1 : 0), steps)
      }
    }
  }

  // ---------------------------------------------------------------- type
  const maxW = W - 2 * PAD_X
  let size = 84, lines
  for (size of [84, 76, 68, 60, 52]) {
    lines = text.wrap('semibold', q.title, size, maxW, { letterSpacing: -0.035 * size, maxLines: 3 })
    if (lines.every((l) => l.width <= maxW + 0.5)) break
  }
  const lh = Math.round(size * 1.08)
  const kickerSize = 24
  const titleTop = PAD_Y + (q.kicker ? kickerSize + 28 : 0)
  const asc = text.baselineIn('semibold', size, lh)
  const titleCmds = lines.flatMap((l, li) => l.words.flatMap((w) => w.run.cmds(PAD_X + w.x, titleTop + li * lh + asc)))
  const title = ctx.sprite([{ cmds: titleCmds, color: 0xffffff }], { margin: 4 })
  const titleH = lines.length * lh
  // The same title as 4 px dots in a Bayer x left-to-right order: it dithers in, then the solid
  // sprite fades over it.
  const titleDots = ctx.dots(title, {
    box: [PAD_X - 4, titleTop, maxW + 8, titleH + 8],
    pitch: 4,
    size: 3,
    min: 0.25,
    order: (d) => 0.55 * d.u + 0.45 * threshold(Math.round(d.x / 4), Math.round(d.y / 4)),
  })

  const kicker = q.kicker
    ? (() => {
        const run = text.fit('semibold', q.kicker.toUpperCase(), kickerSize, maxW - 30, { letterSpacing: 0.08 * kickerSize })
        return ctx.sprite([
          { cmds: rrect(PAD_X, PAD_Y + 5, 14, 14, 3), color: accent },
          { cmds: run.cmds(PAD_X + 28, PAD_Y + kickerSize - 2), color: accent },
        ], { margin: 4 })
      })()
    : null
  const brand = q.brand
    ? ctx.sprite([{ cmds: text.fit('semibold', q.brand, 26, 400, { letterSpacing: 0.12 * 26 }).cmds(PAD_X, H - PAD_Y + 10), color: 0xffffff, alpha: 0.85 }], { margin: 4 })
    : null

  // ---------------------------------------------------------------- timeline
  const clamp01 = (t) => Math.max(0, Math.min(1, t))
  const span = (t, [a, b]) => clamp01((t - a) / (b - a))
  const cubicOut = (t) => 1 - (1 - t) ** 3
  const q3 = (v) => Math.round(v * 1000) / 1000

  return {
    state(i) {
      const t = i / ctx.fps
      return {
        t,
        rise: q3(span(t, AURORA_IN)),
        titleDots: q3(span(t, TITLE_IN)),
        solid: q3(cubicOut(span(t, TITLE_SOLID))),
        meta: q3(cubicOut(clamp01((t - META_IN) / 0.4))),
      }
    },
    draw(g, s) {
      g.clear(bg)
      if (s.rise > 0) {
        paintField(s.t, s.rise)
        g.cells(grid)
      }
      if (s.solid < 1) g.dots(titleDots, { progress: s.titleDots, opacity: 1 - s.solid })
      if (s.solid > 0) g.draw(title, { opacity: s.solid })
      if (s.meta > 0) {
        const y = Math.round((1 - s.meta) * 10)
        if (kicker) g.draw(kicker, { opacity: s.meta, transform: [1, 0, 0, 1, 0, y] })
        if (brand) g.draw(brand, { opacity: s.meta })
      }
    },
  }
}
