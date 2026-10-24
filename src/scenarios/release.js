// release: a changelog card. A huge version numeral rises from the bottom edge, the version pill
// and title land, then each item slides in with its icon tile popping on a steady beat.
//
// The first 21 frames (0.7 s, the numeral rising) depend only on version, accent and theme.
//
// Moving pieces (numeral, tiles, icons, item text) are live vector fills with a transform;
// everything that has landed is a sprite in a cached layer.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, transform } from '../gfx.js'
import { W, H, THEMES, background, mix, hex, onColor, affine } from './showcase-kit.js'
import EMOJI from './twemoji.json' with { type: 'json' }

const PAD_X = 80
const ICONS = Object.keys(EMOJI)
const DEFAULT_ICONS = ['sparkles', 'bolt', 'globe', 'package', 'chart']

export const release = defineScenario({
  id: 'release',
  version: 1,
  video: { width: W, height: H, fps: 30, frames: 210 },
  params: p.object({
    title: p.string({ max: 48, default: "What's new this week" }),
    version: p.string({ max: 8, default: '2.4', pattern: /^[A-Za-z0-9.\-]*$/ }),
    kicker: p.string({ max: 24, default: 'Changelog' }),
    items: p.array(p.string({ max: 48 }), {
      min: 1,
      max: 5,
      default: ['Kinetic type, metric and chart scenarios', 'Streams out faster than realtime', 'Rendered at the edge, no browser', 'Cached after the first view'],
    }),
    icons: p.array(p.enum(ICONS), { max: 5, default: [] }),
    accent: p.color({ default: '#a855f7' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 21, key: (q) => `${q.accent}|${q.theme}|${q.version}` },
  meta: (q) => ({ title: q.version ? `${q.title} (v${q.version.replace(/^v/i, '')})` : q.title, description: q.items.join(' · ') }),
  setup,
})

function setup(ctx, q) {
  const { text } = ctx
  const theme = THEMES[q.theme]
  const accent = hex(q.accent)
  const bg = background(ctx, theme, accent, { glowAt: [W - 160, H + 40], radius: 760 })

  // ---------------------------------------------------------------- big numeral
  const num = q.version.replace(/^v/i, '')
  const numSize = num.length > 4 ? Math.max(200, Math.round(1600 / num.length)) : 400
  const numRun = num ? text.run('semibold', num, numSize, { letterSpacing: -0.06 * numSize }) : null
  const numX = numRun ? Math.round(W - 56 - numRun.advance) : 0
  const numBase = H + Math.round(numSize * 0.04)
  const numColor = mix(theme.bg, accent, q.theme === 'dark' ? 0.15 : 0.13)
  const numPath = numRun ? ctx.path(numRun.cmds(0, 0)) : null
  const numSprite = numRun ? ctx.sprite([{ cmds: numRun.cmds(numX, numBase), color: numColor }], { margin: 4 }) : null
  const numTravel = Math.round(numSize * 0.8)

  // ---------------------------------------------------------------- header
  const pillText = num ? `v${num}` : ''
  const pillRun = pillText ? text.run('semibold', pillText, 22) : null
  const pillW = pillRun ? Math.ceil(pillRun.advance + 28) : 0
  const pillH = 36
  const pillY = 72
  const ink = onColor(accent)
  const pill = pillRun
    ? ctx.sprite(
        [
          { cmds: rrect(PAD_X, pillY, pillW, pillH, pillH / 2), color: accent },
          { cmds: pillRun.cmds(PAD_X + 14, pillY + text.baselineIn('semibold', 22, pillH)), color: ink },
        ],
        { margin: 2 },
      )
    : null
  const kickX = PAD_X + (pillW ? pillW + 14 : 0)
  const kickRun = q.kicker ? text.fit('semibold', q.kicker, 22, 400) : null
  const kicker = kickRun ? ctx.sprite([{ cmds: kickRun.cmds(kickX, pillY + text.baselineIn('semibold', 22, pillH)), color: theme.muted }], { margin: 2 }) : null

  const titleSize = 60
  const titleBase = 178
  const titleRun = q.title ? text.fit('semibold', q.title, titleSize, W - 2 * PAD_X, { letterSpacing: -0.03 * titleSize }) : null
  const title = titleRun ? ctx.sprite([{ cmds: titleRun.cmds(PAD_X, titleBase), color: theme.fg }], { margin: 4 }) : null

  // ---------------------------------------------------------------- items
  const n = q.items.length
  const top = 232
  const rowH = Math.min(78, Math.floor((H - 48 - top) / n))
  const tile = Math.min(52, rowH - 18)
  const iconPx = Math.round(tile * 0.56)
  const textSize = Math.min(32, Math.round(rowH * 0.42))
  const tileFill = q.theme === 'dark' ? mix(theme.bg, 0xffffff, 0.07) : 0xffffff
  const tileEdge = q.theme === 'dark' ? mix(theme.bg, 0xffffff, 0.14) : mix(theme.bg, 0x000000, 0.1)
  const rows = q.items.map((label, i) => {
    const y = top + i * rowH
    const cy = y + rowH / 2
    const name = q.icons[i] ?? DEFAULT_ICONS[i % DEFAULT_ICONS.length]
    const k = iconPx / 36
    // Icon layers centred on (0, 0), for live fills; and placed, for the settled sprite.
    const layers = EMOJI[name].map((l) => ({ cmds: transform(l.cmds, k, -iconPx / 2, -iconPx / 2), color: l.rgb }))
    const tcx = PAD_X + tile / 2
    const tileLayers = [
      { cmds: rrect(-tile / 2, -tile / 2, tile, tile, tile * 0.28), color: tileEdge },
      { cmds: rrect(-tile / 2 + 1, -tile / 2 + 1, tile - 2, tile - 2, tile * 0.28 - 1), color: tileFill },
    ]
    const run = text.fit('semibold', label, textSize, W - PAD_X - (PAD_X + tile + 22), { letterSpacing: -0.012 * textSize })
    const tx = PAD_X + tile + 22
    const base = Math.round(cy + textSize * 0.36)
    return {
      cx: tcx,
      cy,
      tx,
      base,
      tileParts: tileLayers.map((l) => ({ path: ctx.path(l.cmds), color: l.color })),
      iconParts: layers.map((l) => ({ path: ctx.path(l.cmds), color: l.color })),
      textPath: ctx.path(run.cmds(0, 0)),
      sprite: ctx.sprite(
        [
          ...tileLayers.map((l) => ({ cmds: transform(l.cmds, 1, tcx, cy), color: l.color })),
          ...layers.map((l) => ({ cmds: transform(l.cmds, 1, tcx, cy), color: l.color })),
          { cmds: run.cmds(tx, base), color: theme.fg },
        ],
        { margin: 4 },
      ),
    }
  })

  // ---------------------------------------------------------------- timeline
  const s = {
    num: { y: 1 },
    pill: { k: 0 },
    kicker: { p: 0 },
    title: { p: 0 },
    rows: rows.map(() => ({ tile: 0, icon: 0, x: 1, o: 0 })),
  }
  const tl = gsap.timeline({ paused: true })
  if (numRun) tl.fromTo(s.num, { y: 1 }, { y: 0, duration: 1.1, ease: 'expo.out' }, 0)
  if (pill) tl.fromTo(s.pill, { k: 0 }, { k: 1, duration: 0.5, ease: 'back.out(2)' }, 0.7)
  if (kicker) tl.fromTo(s.kicker, { p: 0 }, { p: 1, duration: 0.6, ease: 'expo.out' }, 0.8)
  if (title) tl.fromTo(s.title, { p: 0 }, { p: 1, duration: 0.8, ease: 'expo.out' }, 0.85)
  const step = Math.min(0.2, 1.1 / n)
  rows.forEach((_, i) => {
    const at = 1.3 + i * step
    tl.fromTo(s.rows[i], { tile: 0 }, { tile: 1, duration: 0.55, ease: 'back.out(1.7)' }, at)
    tl.fromTo(s.rows[i], { icon: 0 }, { icon: 1, duration: 0.6, ease: 'back.out(2.6)' }, at + 0.08)
    tl.fromTo(s.rows[i], { x: 1 }, { x: 0, duration: 0.7, ease: 'expo.out' }, at + 0.06)
    tl.fromTo(s.rows[i], { o: 0 }, { o: 1, duration: 0.35, ease: 'power2.out' }, at + 0.06)
  })
  tl.seek(0)

  // ---------------------------------------------------------------- frames
  const rowDone = (o) => o.tile >= 1 && o.icon >= 1 && o.x <= 0 && o.o >= 1
  return {
    state(i) {
      tl.seek(i / ctx.fps, false)
      return s
    },
    draw(g) {
      const nDone = !numRun || s.num.y <= 0
      const pDone = !pill || s.pill.k >= 1
      const kDone = !kicker || s.kicker.p >= 1
      const tDone = !title || s.title.p >= 1
      const rDone = s.rows.map(rowDone)
      g.layer('bg', () => g.draw(bg))
      g.layer([nDone, pDone, kDone, tDone, rDone].join(), () => {
        if (numRun && nDone) g.draw(numSprite)
        if (pill && pDone) g.draw(pill)
        if (kicker && kDone) g.draw(kicker)
        if (title && tDone) g.draw(title)
        rows.forEach((r, i) => rDone[i] && g.draw(r.sprite))
      })

      if (numRun && !nDone && s.num.y < 1) g.fill(numPath, numColor, { transform: affine(numX, numBase + s.num.y * numTravel) })
      if (pill && !pDone && s.pill.k > 0) {
        // The pill is a sprite, so it pops with a growing clip from its centre plus opacity.
        const k = Math.min(1, s.pill.k)
        const cx = PAD_X + pillW / 2
        const hw = (pillW / 2 + 2) * Math.min(1, s.pill.k * 1.05)
        g.draw(pill, { opacity: k, clip: [cx - hw, pillY - 2, cx + hw, pillY + pillH + 2] })
      }
      if (kicker && !kDone && s.kicker.p > 0) g.draw(kicker, { opacity: s.kicker.p, clip: [0, 0, kickX + (kickRun.advance + 8) * s.kicker.p, H] })
      if (title && !tDone && s.title.p > 0) g.draw(title, { opacity: Math.min(1, s.title.p * 1.6), clip: [0, 0, PAD_X + (titleRun.advance + 12) * s.title.p, H] })

      rows.forEach((r, i) => {
        const o = s.rows[i]
        if (rDone[i] || (o.tile <= 0 && o.o <= 0)) return
        if (o.tile > 0) for (const part of r.tileParts) g.fill(part.path, part.color, { alpha: Math.min(1, o.tile * 2), transform: affine(r.cx, r.cy, -12 * (1 - o.tile), o.tile) })
        if (o.icon > 0) for (const part of r.iconParts) g.fill(part.path, part.color, { alpha: Math.min(1, o.icon * 2), transform: affine(r.cx, r.cy, 0, o.icon) })
        if (o.o > 0) g.fill(r.textPath, theme.fg, { alpha: o.o, transform: affine(r.tx + o.x * 36, r.base) })
      })
    },
    dispose: () => tl.kill(),
  }
}
