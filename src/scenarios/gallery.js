// gallery: a title block on the left and a two-column wall of thumbnails on the right that scrolls
// up without end. Thumbnails are image params (PNG, JPEG or WebP URLs, fetched and decoded into
// rounded sprites); without any, it shows built-in illustrated tiles, a few of them animated.
//
// The wall moves exactly 4 px per frame and a column repeats every 840 px (4 tiles), so the 7 s
// video loops seamlessly. Whole-pixel motion keeps the sprites unresampled (plain copies) and lets
// the encoder match every block exactly one step down, which is far cheaper than sub-pixel motion.
//
// The first 10 frames (before the text fades in) depend only on the images and the accent.
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, ellipse } from '../gfx.js'

const W = 1200
const H = 630
const PAD = 72
const TILE_W = 262
const TILE_H = 196
const GAP = 14
const PER_COL = 4
const PERIOD = PER_COL * (TILE_H + GAP) // 840 px
const STEP = 4 // px per frame: 210 frames x 4 = 840
const COL_X = [W - 40 - 2 * TILE_W - GAP, W - 40 - TILE_W]
const RADIUS = 14

export const gallery = defineScenario({
  id: 'gallery',
  version: 1,
  video: { width: W, height: H, fps: 30, frames: 210 },
  params: p.object({
    title: p.string({ max: 40, default: 'Playground' }),
    description: p.string({ max: 140, default: 'A collection of interactive experiments, demos and creative projects.' }),
    site: p.string({ max: 40, default: 'acme.dev' }),
    accent: p.color({ default: '#2f6bff' }),
    images: p.array(p.image(), { max: 8, default: [] }),
  }),
  prefix: { frames: 10, key: (q) => `${q.accent}|${q.images.join(' ')}` },
  meta: (q) => ({ title: q.title, description: q.description || undefined }),
  setup,
})

// ---------------------------------------------------------------- built-in tiles
// Drawn in a TILE_W x TILE_H box at the origin. `live` (optional) draws an animated overlay at
// time t, in the same box, from paths made once.

const TILES = [
  function keys(ctx) {
    const layers = [{ cmds: rect(0, 0, TILE_W, TILE_H), color: 0x0d0d10 }]
    const kw = (TILE_W - 40) / 10
    for (let i = 0; i < 10; i++) layers.push({ cmds: rrect(20 + i * kw + 1, 70, kw - 2, 100, 3), color: 0xf2f2ee })
    for (const i of [0, 1, 3, 4, 5, 7, 8]) layers.push({ cmds: rrect(20 + (i + 1) * kw - kw * 0.3, 70, kw * 0.6, 60, 2), color: 0x0d0d10 })
    const lit = ctx.path(rrect(1, 0, kw - 2, 100, 3))
    return {
      layers,
      live(g, x, y, t) {
        const i = [2, 6, 4, 9, 0, 5][Math.floor(t * 4) % 6]
        g.fill(lit, 0x2dd4bf, { transform: [1, 0, 0, 1, x + 20 + i * kw, y + 70] })
      },
    }
  },
  function synth() {
    const layers = [{ cmds: rect(0, 0, TILE_W, TILE_H), color: 0x7b1e2c }, { cmds: rrect(18, 26, TILE_W - 36, 56, 6), color: 0x5a1520 }]
    for (let i = 0; i < 6; i++) layers.push({ cmds: ellipse(44 + i * 35, 54, 11), color: 0xd9d4cc })
    const kw = (TILE_W - 36) / 14
    for (let i = 0; i < 14; i++) layers.push({ cmds: rrect(18 + i * kw + 1, 104, kw - 2, 70, 2), color: 0xf4f1ea })
    for (const i of [0, 1, 3, 4, 5, 7, 8, 10, 11, 12]) layers.push({ cmds: rect(18 + (i + 1) * kw - kw * 0.3, 104, 18 + (i + 1) * kw + kw * 0.3, 146), color: 0x1a1214 })
    return { layers }
  },
  function orbit(ctx) {
    const cx = TILE_W / 2, cy = TILE_H / 2
    const layers = [
      { cmds: rect(0, 0, TILE_W, TILE_H), color: 0x15151a },
      { cmds: [...ellipse(cx, cy, 70, 26), ...ellipse(cx, cy, 66, 22)], color: 0xe9e4d8, evenodd: true },
      { cmds: ellipse(cx, cy, 13), color: 0xf4b740 },
    ]
    const dot = ctx.path(ellipse(0, 0, 5))
    return {
      layers,
      live(g, x, y, t) {
        const a = t * 2.4
        g.fill(dot, 0xffffff, { transform: [1, 0, 0, 1, x + cx + Math.cos(a) * 68, y + cy + Math.sin(a) * 24] })
      },
    }
  },
  function garden() {
    const layers = [{ cmds: rect(0, 0, TILE_W, TILE_H), color: 0x9fd174 }]
    const s = 30
    for (let r = 0; r < 7; r++) for (let c = 0; c < 9; c++) if ((r + c) % 2) layers.push({ cmds: rect(c * s, r * s, c * s + s, r * s + s), color: 0x93c768 })
    layers.push(
      { cmds: rrect(0, 0, TILE_W, 26, 0), color: 0x8a8f99 },
      { cmds: rrect(90, 96, 90, 22, 11), color: 0xbfe8ff },
      { cmds: rrect(124, 62, 22, 90, 11), color: 0xbfe8ff },
      { cmds: ellipse(60, 140, 13), color: 0xffffff },
      { cmds: ellipse(205, 60, 14), color: 0xe9784f },
      { cmds: rrect(16, 150, 32, 32, 4), color: 0xd59a5b },
      { cmds: rrect(214, 150, 32, 32, 4), color: 0xd59a5b },
    )
    return { layers }
  },
  function nodes(ctx) {
    const pts = [[40, 150], [80, 60], [130, 120], [175, 50], [222, 110]]
    const layers = [{ cmds: rect(0, 0, TILE_W, TILE_H), color: 0xf6f1e7 }, { cmds: rect(30, 168, TILE_W - 30, 171), color: 0x2b2b2b }]
    for (const [x] of pts) layers.push({ cmds: rect(x - 1.5, 0, x + 1.5, 168), color: 0x2b2b2b, alpha: 0.85 })
    pts.forEach(([x, y]) => layers.push({ cmds: ellipse(x, y, 9), color: 0x2f6bff }))
    const ball = ctx.path(ellipse(0, 0, 7))
    return {
      layers,
      live(g, x, y, t) {
        const u = (t * 0.9) % 1
        const k = Math.min(3, Math.floor(u * 4))
        const f = u * 4 - k
        const [x0, y0] = pts[k + 1 > 4 ? 4 : k]
        const [x1, y1] = pts[k + 1 > 4 ? 4 : k + 1]
        const hop = Math.sin(f * Math.PI) * 30
        g.fill(ball, 0x1f9d55, { transform: [1, 0, 0, 1, x + x0 + (x1 - x0) * f, y + y0 + (y1 - y0) * f - 22 - hop] })
      },
    }
  },
  function dials() {
    const layers = [{ cmds: rect(0, 0, TILE_W, TILE_H), color: 0x101014 }]
    ;[[64, 70, 34], [150, 70, 34], [220, 130, 24], [96, 140, 22]].forEach(([x, y, r]) => {
      layers.push({ cmds: [...ellipse(x, y, r), ...ellipse(x, y, r - 4)], color: 0x6b6b75, evenodd: true }, { cmds: ellipse(x + r * 0.45, y - r * 0.45, 5), color: 0xf4b740 })
    })
    return { layers }
  },
  function chart() {
    const layers = [{ cmds: rect(0, 0, TILE_W, TILE_H), color: 0x1e4d3a }]
    ;[0.4, 0.62, 0.5, 0.82, 0.7, 0.95].forEach((v, i) => layers.push({ cmds: rrect(28 + i * 36, 170 - v * 130, 24, v * 130, 4), color: i === 5 ? 0xf8e16c : 0x9bd3b5 }))
    return { layers }
  },
  function cards() {
    return {
      layers: [
        { cmds: rect(0, 0, TILE_W, TILE_H), color: 0xe9e7f1 },
        { cmds: rrect(48, 42, 170, 112, 10), color: 0xc9c4dd },
        { cmds: rrect(38, 54, 170, 112, 10), color: 0xffffff },
        { cmds: rrect(54, 72, 90, 10, 5), color: 0x6a5acd },
        { cmds: rrect(54, 94, 130, 8, 4), color: 0xb9b4cc },
        { cmds: rrect(54, 110, 110, 8, 4), color: 0xb9b4cc },
        { cmds: rrect(54, 134, 52, 18, 9), color: 0x6a5acd },
      ],
    }
  },
]

// ---------------------------------------------------------------- setup

function setup(ctx, q) {
  const { text } = ctx
  const ink = 0x111113
  const muted = 0x707078

  // Tiles: column c, slot k shows tile (k * 2 + c). Each sprite is made at slot 0 of its column
  // and moved by whole pixels.
  const tiles = []
  const shared = new Map()
  for (let c = 0; c < 2; c++) {
    for (let k = 0; k < PER_COL; k++) {
      const n = k * 2 + c
      const x = COL_X[c], y = 0
      let sprite = null
      let live = null
      if (q.images.length) {
        const src = q.images[n % q.images.length]
        const key = `${src}|${c}`
        sprite = shared.get(key) ?? ctx.image(src, { x, y, w: TILE_W, h: TILE_H, fit: 'cover', radius: RADIUS })
        shared.set(key, sprite)
        if (!sprite) sprite = ctx.sprite([{ cmds: rrect(x, y, TILE_W, TILE_H, RADIUS), color: 0xececef }], { margin: 0 })
      } else {
        const t = TILES[n % TILES.length](ctx)
        const moved = t.layers.map((l) => ({ ...l, cmds: shift(l.cmds, x, y) }))
        sprite = ctx.clip(ctx.sprite(moved, { margin: 0 }), rrect(x, y, TILE_W, TILE_H, RADIUS))
        live = t.live ?? null
      }
      tiles.push({ c, k, sprite, live })
    }
  }

  // Left: site row, title, description.
  const siteRun = q.site ? text.fit('semibold', q.site, 20, 360) : null
  let titleSize = 84
  let titleRun = text.fit('semibold', q.title, titleSize, 470, { letterSpacing: -0.035 * titleSize })
  while (titleRun.advance > 470 && titleSize > 48) {
    titleSize -= 4
    titleRun = text.fit('semibold', q.title, titleSize, 470, { letterSpacing: -0.035 * titleSize })
  }
  const desc = q.description ? text.wrap('regular', q.description, 24, 400, { maxLines: 3 }) : []
  const blockH = 34 + titleSize * 1.1 + 18 + desc.length * 34
  const top = Math.round(H / 2 - blockH / 2 - 10)
  const parts = []
  if (siteRun) {
    parts.push(ctx.sprite([
      { cmds: rrect(PAD, top + 4, 20, 20, 5), color: q.accent },
      { cmds: siteRun.cmds(PAD + 30, top + 21), color: ink },
    ], { margin: 4 }))
  }
  const titleBase = top + 34 + Math.round(titleSize * 0.92)
  parts.push(ctx.sprite([{ cmds: titleRun.cmds(PAD - titleSize * 0.04, titleBase), color: ink }], { margin: 6 }))
  if (desc.length) {
    parts.push(ctx.sprite(desc.flatMap((l, i) => l.words.map((w) => ({ cmds: w.run.cmds(PAD + w.x, titleBase + 46 + i * 34), color: muted }))), { margin: 4 }))
  }

  const ease = (t) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3
  const r3 = (v) => Math.round(v * 1000) / 1000

  return {
    state(i) {
      const t = i / ctx.fps
      return { i, text: parts.map((_, k) => r3(ease((t - 0.35 - k * 0.08) / 0.5))) }
    },
    draw(g, s) {
      const shown = s.text.every((v) => v >= 1)
      const left = () => {
        g.clear(0xffffff)
        parts.forEach((sp, k) => {
          const v = s.text[k]
          if (v > 0) g.draw(sp, { opacity: v, transform: [1, 0, 0, 1, 0, Math.round((1 - v) * 16)] })
        })
      }
      g.layer(shown ? 'left' : `left${s.text}`, left)
      const scroll = s.i * STEP
      const t = s.i / ctx.fps
      for (const tile of tiles) {
        // Column 1 runs half a tile behind column 0, like a masonry wall.
        const base = tile.k * (TILE_H + GAP) + (tile.c ? (TILE_H + GAP) / 2 : 0) - scroll
        for (const y of [mod(base, PERIOD) - PERIOD, mod(base, PERIOD)]) {
          if (y >= H || y + TILE_H <= 0) continue
          g.draw(tile.sprite, { transform: [1, 0, 0, 1, 0, y] })
          tile.live?.(g, COL_X[tile.c], y, t)
        }
      }
    },
  }
}

const mod = (a, n) => ((a % n) + n) % n

/** A command buffer moved by (dx, dy). */
function shift(cmds, dx, dy) {
  const args = [2, 2, 4, 6, 0]
  const out = []
  for (let i = 0; i < cmds.length; ) {
    const n = args[cmds[i]]
    out.push(cmds[i])
    for (let j = 0; j < n; j += 2) out.push(cmds[i + 1 + j] + dx, cmds[i + 2 + j] + dy)
    i += 1 + n
  }
  return out
}
