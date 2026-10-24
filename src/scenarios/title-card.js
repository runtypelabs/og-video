// title-card: an announcement card. A grid reveals from the centre, a scan line types the brand
// as a pixel wordmark, the stage flips the wordmark into the header, then the kicker types on and
// the title words blur in.
//
// The first 168 frames (2.8 s, until the badge appears) depend only on the brand and accent, so
// they are one prefix per brand/accent pair and play instantly while the rest renders.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect } from '../gfx.js'
import { lu } from '../text.js'
import { pixelText } from '../pixelfont.js'

const W = 1200
const H = 630
const PAD_X = 64
const PAD_Y = 56
const HEADER_H = 52
const SLOT_H = 36
const FLIP_AT = 2.25
const SCAN_START = 0.35

export const titleCard = defineScenario({
  id: 'title-card',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  params: p.object({
    title: p.string({ max: 140, default: 'Animated link previews, rendered at the edge' }),
    kicker: p.string({ max: 32, default: '' }),
    badge: p.string({ max: 24, default: '' }),
    brand: p.string({ max: 12, default: 'OG VIDEO', pattern: /^[A-Za-z0-9 .!+/-]*$/ }),
    accent: p.color({ default: '#3b82f6' }),
    footer: p.string({ max: 48, default: '' }),
    url: p.string({ max: 48, default: '' }),
  }),
  prefix: { frames: 168, key: (q) => `${q.brand.toUpperCase()}|${q.accent}` },
  meta: (q) => ({ title: q.title, description: [q.kicker, q.footer, q.url].filter(Boolean).join(' · ') || undefined }),
  setup,
})

function setup(ctx, q) {
  const { text } = ctx
  const accent = q.accent

  // ---------------------------------------------------------------- stage (the intro), in units
  // Brand pixels sit on a 200-unit grid (165-unit cells), wordmark top-left at (0, 0).
  const brand = pixelText(q.brand)
  const C = brand.cols
  const BW = Math.max(C * 200 - 35, 0)
  const BH = 965
  const VBw = Math.max(11913.2, BW * 1.6)
  const VBh = (VBw * H) / W
  const cx = BW / 2
  const cy = BH / 2
  const K = W / VBw
  const ox = -(cx - VBw / 2) * K
  const oy = -(cy - VBh / 2) * K

  const cells = []
  const x0 = Math.floor((cx - VBw / 2 - 400) / 200) * 200
  const y0 = Math.floor((cy - VBh / 2 - 400) / 200) * 200
  for (let x = x0; x < cx + VBw / 2 + 400; x += 200) for (let y = y0; y < cy + VBh / 2 + 400; y += 200) cells.push(...rrect(x, y, 165, 165, 12))
  const grid = ctx.grid({
    key: `title-card:${VBw}:${cx}`,
    cells,
    transform: [K, 0, 0, K, ox, oy],
    center: [K * cx + ox, K * cy + oy],
    canvas: { x: -24, y: -12, w: W + 48, h: H + 56 },
    background: 17,
    cell: 31,
  })
  const rFinal = 5200 * (VBw / 11913.2)

  const scanPath = ctx.path(rrect(0, 0, 165, BH, 12))
  const pxPath = ctx.path(rect(0, 0, 165, 165))

  const fs = SLOT_H / (BH * K)
  const slot = { x: PAD_X, y: PAD_Y + (HEADER_H - SLOT_H) / 2 }
  const flip = { x: slot.x - fs * ox, y: slot.y - fs * oy, scale: fs }

  // ---------------------------------------------------------------- card layout
  const innerW = W - 2 * PAD_X
  let badge = null
  if (q.badge) {
    const label = text.run('semibold', q.badge, 24)
    const lineH = lu(24 * 1.2)
    const h = lineH + 22
    const w = 2 + 40 + 10 + 10 + label.advance
    const b = { x: W - PAD_X - w, y: PAD_Y + (HEADER_H - h) / 2, w, h }
    badge = ctx.sprite(
      [
        { cmds: rrect(b.x, b.y, b.w, b.h, b.h / 2), color: 0xffffff, alpha: 0.08 },
        // The 1px border, as the ring between its outer and inner edges.
        { cmds: [...rrect(b.x, b.y, b.w, b.h, b.h / 2), ...rrect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, b.h / 2 - 1)], color: 0xffffff, alpha: 0.16, evenodd: true },
        { cmds: rrect(b.x + 21, b.y + 11 + (lineH - 10) / 2, 10, 10, 2), color: accent },
        { cmds: label.cmds(b.x + 1 + 20 + 10 + 10, b.y + 1 + 10 + text.baselineIn('semibold', 24, lineH)), color: 0xffffff },
      ],
      { margin: 26 },
    )
  }

  const footerSize = 26
  const footerH = text.metrics('regular', footerSize).normal
  const footerTop = H - PAD_Y - footerH
  const footerBase = footerTop + text.baselineIn('regular', footerSize, footerH)
  const footer = q.footer ? ctx.sprite([{ cmds: text.fit('regular', q.footer, footerSize, innerW / 2 - 16).cmds(PAD_X, footerBase), color: 0xa0a0a0 }], { margin: 20 }) : null
  const urlRun = q.url ? text.fit('regular', q.url, footerSize, innerW / 2 - 16) : null
  const url = urlRun ? ctx.sprite([{ cmds: urlRun.cmds(W - PAD_X - urlRun.advance, footerBase), color: 0xa0a0a0 }], { margin: 20 }) : null

  const kickerSize = 26
  const kickerLH = lu(kickerSize * 1.2)
  const kickerText = q.kicker.toUpperCase()
  const kickerRun = kickerText ? text.run('semibold', kickerText, kickerSize, { letterSpacing: 0.08 * kickerSize }) : null
  const titleSize = q.title.length > 60 ? 52 : 64
  const titleLH = lu(titleSize * 1.12)
  const lines = text.wrap('semibold', q.title, titleSize, innerW, { letterSpacing: -0.03 * titleSize, maxLines: 3 })
  const bodyH = (kickerRun ? kickerLH + 24 : 0) + lines.length * titleLH
  const free = H - 2 * PAD_Y - HEADER_H - bodyH - footerH
  const bodyTop = PAD_Y + HEADER_H + Math.round((free / 2) * 64) / 64
  const kickerBase = bodyTop + text.baselineIn('semibold', kickerSize, kickerLH)
  const titleTop = bodyTop + (kickerRun ? kickerLH + 24 : 0)
  const titleBase = text.baselineIn('semibold', titleSize, titleLH)

  const kickerLetters = kickerRun ? [...kickerText].map((_, i) => ctx.sprite([{ cmds: kickerRun.cmds(PAD_X, kickerBase, i), color: accent }], { margin: 2 })) : []
  const caret = { x: PAD_X, y: bodyTop + kickerLH / 2 - 11, path: ctx.path(rrect(0, 0, 14, 22, 2)) }
  const words = lines.flatMap((line, li) =>
    line.words.map((w) => ctx.sprite([{ cmds: w.run.cmds(PAD_X + w.x, titleTop + li * titleLH + titleBase), color: 0xffffff }], { margin: 20 })),
  )

  // ---------------------------------------------------------------- timeline
  const s = {
    reveal: { r: 0 },
    grid: { opacity: 1 },
    scan: { x: 0, opacity: 0 },
    px: brand.cells.map(([col, row]) => ({ col, row, opacity: 0, scale: 1, fill: accent })),
    stage: { x: 0, y: 0, scale: 1 },
    badge: { opacity: 0, blur: 0 },
    caret: { opacity: 0, x: 0 },
    kicker: kickerLetters.map(() => ({ opacity: 0 })),
    words: words.map(() => ({ opacity: 0, blur: 0 })),
    footer: { opacity: 0, blur: 0 },
    url: { opacity: 0, blur: 0 },
  }

  const tl = gsap.timeline({ paused: true })
  tl.fromTo(s.reveal, { r: 0 }, { r: rFinal, duration: 0.9, ease: 'expo.out' }, 0)
  if (C > 0) {
    const step = Math.min(0.05, 1.3 / C)
    const colTime = (c) => SCAN_START + c * step
    tl.set(s.scan, { opacity: 0.45 }, SCAN_START)
    tl.fromTo(s.scan, { x: 0 }, { x: C * 200, duration: C * step, ease: `steps(${C})` }, SCAN_START)
    tl.to(s.scan, { opacity: 0, duration: 0.15, ease: 'power2.out' }, colTime(C) - 0.05)
    for (const px of s.px) {
      const at = colTime(px.col) + px.row * 0.012
      tl.fromTo(px, { opacity: 0 }, { opacity: 1, duration: 0.05, ease: 'none' }, at)
      tl.fromTo(px, { scale: 0.35 }, { scale: 1, duration: 0.32, ease: 'expo.out' }, at)
      tl.fromTo(px, { fill: accent }, { fill: '#ffffff', duration: 0.45, ease: 'power2.out' }, at + 0.12)
    }
  }
  tl.fromTo(s.stage, { x: 0, y: 0, scale: 1 }, { x: flip.x, y: flip.y, scale: flip.scale, duration: 0.75, ease: 'power3.inOut' }, FLIP_AT)
  tl.to(s.grid, { opacity: 0, duration: 0.55, ease: 'power2.in' }, FLIP_AT)
  if (badge) tl.fromTo(s.badge, { opacity: 0, blur: 8 }, { opacity: 1, blur: 0, duration: 0.2, ease: 'power3.out' }, FLIP_AT + 0.55)

  const CAT_AT = FLIP_AT + 0.7
  if (kickerRun) {
    const STEP = 0.035
    tl.fromTo(s.caret, { opacity: 0 }, { opacity: 1, duration: 0.01 }, CAT_AT)
    s.kicker.forEach((letter, i) => {
      const at = CAT_AT + i * STEP
      tl.fromTo(letter, { opacity: 0 }, { opacity: 1, duration: 0.01, ease: 'none' }, at)
      tl.set(s.caret, { x: kickerRun.rightOf(i) + 4 }, at)
    })
    tl.to(s.caret, { opacity: 0, duration: 0.12, ease: 'power2.out' }, CAT_AT + s.kicker.length * STEP + 0.12)
  }
  const TITLE_AT = CAT_AT + (kickerRun ? 0.2 : 0)
  s.words.forEach((word, i) => {
    tl.fromTo(word, { opacity: 0, blur: 6 }, { opacity: 1, blur: 0, duration: 0.16, ease: 'power3.out' }, TITLE_AT + i * 0.067)
  })
  const titleEnd = TITLE_AT + s.words.length * 0.067 + 0.16
  tl.fromTo([s.footer, s.url], { opacity: 0, blur: 6 }, { opacity: 1, blur: 0, duration: 0.2, ease: 'power3.out', stagger: 0.08 }, titleEnd)
  tl.seek(0)

  // ---------------------------------------------------------------- frames
  const settled = (o) => o.opacity >= 1 && !(o.blur > 0)
  const cardSprites = () => [
    [badge, s.badge],
    ...s.kicker.map((o, i) => [kickerLetters[i], o]),
    ...s.words.map((o, i) => [words[i], o]),
    [footer, s.footer],
    [url, s.url],
  ]

  return {
    state(i) {
      tl.seek(i / ctx.fps, false)
      return s
    },
    draw(g) {
      const st = s.stage
      // Layer 0: background and grid. Layer 1: the stage (scan + wordmark). Layer 2: card sprites
      // that have finished animating. Then the ones still animating, live.
      g.layer([st, s.reveal.r, s.grid.opacity], () => {
        g.grid(grid, {
          radius: s.reveal.r * K,
          opacity: s.grid.opacity,
          ...(st.x === 0 && st.y === 0 && st.scale === 1 ? {} : { scale: st.scale, x: st.x, y: st.y }),
        })
      })
      g.layer([s.scan, s.px], () => {
        const k = st.scale * K
        const E = st.scale * ox + st.x
        const F = st.scale * oy + st.y
        if (s.scan.opacity > 0) g.fill(scanPath, accent, { alpha: s.scan.opacity, transform: [k, 0, 0, k, k * s.scan.x + E, F] })
        for (const px of s.px) {
          if (px.opacity <= 0) continue
          const ux = px.col * 200
          const uy = px.row * 200
          const a = k * px.scale
          g.fill(pxPath, px.fill, {
            alpha: px.opacity,
            transform: [a, 0, 0, a, k * (px.scale * ux + (ux + 82.5) * (1 - px.scale)) + E, k * (px.scale * uy + (uy + 82.5) * (1 - px.scale)) + F],
          })
        }
      })
      const sprites = cardSprites()
      g.layer(sprites.map(([, o]) => (settled(o) ? 1 : 0)).join(''), () => {
        for (const [sp, o] of sprites) if (settled(o)) g.draw(sp)
      })
      sprites.forEach(([sp, o], j) => {
        // The caret sits between the kicker and the title in paint order.
        if (j === 1 + s.kicker.length && s.caret.opacity > 0)
          g.fill(caret.path, accent, { alpha: s.caret.opacity, transform: [1, 0, 0, 1, caret.x + s.caret.x, caret.y] })
        if (!settled(o)) g.draw(sp, { opacity: o.opacity, blur: o.blur })
      })
    },
    dispose: () => tl.kill(),
  }
}
