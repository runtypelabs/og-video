// kinetic: kinetic typography. An accent line cuts across the frame, then the headline rises word
// by word out of each line's baseline with a slight rotation, on a steady beat. Words wrapped in
// *asterisks* land in the accent colour and then get a highlight block that wipes in behind them,
// flipping the type. The attribution settles last.
//
// The first 18 frames (0.6 s, the accent line) depend only on accent and theme, so they are one
// prefix per accent/theme pair.
//
// Moving words are vector fills with a transform (sprites cannot move); a word is "masked" by
// redrawing the background bitmap clipped to the band under its line. Settled words are sprites
// in a cached layer, so after ~3.2 s every frame is identical and skipped.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect } from '../gfx.js'
import { W, H, THEMES, background, onColor, hex, affine } from './showcase-kit.js'

const PAD_X = 96
const PAD_Y = 64
const FOOT_H = 64
const WORDS_AT = 0.6

export const kinetic = defineScenario({
  id: 'kinetic',
  version: 1,
  video: { width: W, height: H, fps: 30, frames: 210 },
  params: p.object({
    text: p.string({ max: 120, min: 1, default: 'Every link deserves a *moving picture*' }),
    by: p.string({ max: 40, default: '' }),
    accent: p.color({ default: '#06b6d4' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 18, key: (q) => `${q.accent}|${q.theme}` },
  meta: (q) => ({ title: q.text.replace(/\*/g, ''), description: q.by || undefined }),
  setup,
})

/** Splits "a *b c* d" into words with an emphasis flag; '*' toggles emphasis. */
function parse(src) {
  const words = []
  let on = false
  for (const raw of src.split(/\s+/).filter(Boolean)) {
    let w = ''
    let em = false
    for (const c of raw) {
      if (c === '*') on = !on
      else {
        w += c
        if (on && /[\p{L}\p{N}]/u.test(c)) em = true
      }
    }
    if (w) words.push({ text: w, em })
  }
  return words.length ? words : [{ text: '…', em: false }]
}

function layout(text, words) {
  const maxW = W - 2 * PAD_X
  const maxH = H - 2 * PAD_Y - FOOT_H
  const plain = words.map((w) => w.text).join(' ')
  for (const size of [132, 120, 108, 96, 86, 76, 68, 60, 52, 46]) {
    const lh = Math.round(size * 1.06)
    const lines = text.wrap('semibold', plain, size, maxW, { letterSpacing: -0.045 * size, maxLines: 4 })
    const fits = lines.every((l) => l.width <= maxW + 0.5) && lines.length * lh <= maxH
    const cut = lines.reduce((n, l) => n + l.words.length, 0) < words.length
    if ((fits && !cut) || size === 46) return { size, lh, lines }
  }
}

function setup(ctx, q) {
  const { text } = ctx
  const theme = THEMES[q.theme]
  const accent = hex(q.accent)
  const inverse = onColor(accent)
  const bg = background(ctx, theme, accent)

  // ---------------------------------------------------------------- layout
  const parsed = parse(q.text)
  const { size, lh, lines } = layout(text, parsed)
  const blockH = lines.length * lh
  const top = PAD_Y + Math.round((H - 2 * PAD_Y - FOOT_H - blockH) / 2)
  const asc = text.baselineIn('semibold', size, lh)
  const travel = Math.round(size * 1.15)

  const words = []
  let k = 0
  lines.forEach((line, li) => {
    const baseline = top + li * lh + asc
    for (const w of line.words) {
      const em = parsed[k]?.em ?? false
      // Quarter-pixel x, as glyph outlines snap, so a landing word does not shift when its live
      // fill hands over to the settled sprite.
      const x = Math.round((PAD_X + w.x) * 4) / 4
      const color = em ? accent : theme.fg
      words.push({
        li,
        x,
        baseline,
        w: w.run.advance,
        em,
        color,
        path: ctx.path(w.run.cmds(0, 0)),
        sprite: ctx.sprite([{ cmds: w.run.cmds(x, baseline), color }], { margin: 4 }),
        inv: em ? ctx.sprite([{ cmds: w.run.cmds(x, baseline), color: inverse }], { margin: 4 }) : null,
      })
      k++
    }
  })
  const lineInfo = lines.map((_, li) => {
    const baseline = top + li * lh + asc
    return { baseline, coverTop: Math.round(baseline + size * 0.26) }
  })

  // Highlight blocks: consecutive emphasised words on one line share a block.
  const segs = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!w.em) continue
    const last = segs[segs.length - 1]
    if (last && last.li === w.li && last.to === i - 1) {
      last.to = i
      last.x1 = w.x + w.w
    } else segs.push({ li: w.li, from: i, to: i, x0: w.x, x1: w.x + w.w })
  }
  const padX = Math.round(size * 0.1)
  for (const s of segs) {
    const b = lineInfo[s.li].baseline
    s.x0 = Math.floor(s.x0 - padX)
    s.x1 = Math.ceil(s.x1 + padX)
    s.y0 = Math.floor(b - size * 0.77)
    s.y1 = Math.ceil(b + size * 0.25)
    s.sprite = ctx.sprite([{ cmds: rrect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0, Math.round(size * 0.06)), color: accent }], { margin: 2 })
  }

  // Footer: a small accent marker and the attribution.
  const footBase = H - PAD_Y + 4
  const byRun = q.by ? text.fit('semibold', q.by, 28, W - 2 * PAD_X - 40, { letterSpacing: -0.2 }) : null
  const marker = byRun ? ctx.path(rrect(-7, -7, 14, 14, 3)) : null
  const markerAt = [PAD_X + 7, footBase - 9]
  const by = byRun ? ctx.sprite([{ cmds: byRun.cmds(PAD_X + 28, footBase), color: theme.muted }], { margin: 4 }) : null

  // Intro: the accent line.
  const lineY = Math.round(H / 2) - 2
  const introLine = ctx.path(rect(0, 0, 1, 4))

  // ---------------------------------------------------------------- timeline
  const s = {
    intro: { a: 0.5, b: 0.5 },
    words: words.map(() => ({ y: 1, r: 7 })),
    segs: segs.map(() => ({ p: 0 })),
    marker: { k: 0 },
    by: { p: 0 },
  }
  const tl = gsap.timeline({ paused: true })
  // The line grows out from the centre, then its left end chases the right end off frame.
  // fromTo everywhere: a paused timeline is seeked out of order (posters, stills), and fromTo
  // never depends on what was rendered before.
  tl.fromTo(s.intro, { a: 0.5 }, { a: 0.04, duration: 0.28, ease: 'expo.out' }, 0)
  tl.fromTo(s.intro, { a: 0.04 }, { a: 1.02, duration: 0.3, ease: 'expo.in', immediateRender: false }, 0.28)
  tl.fromTo(s.intro, { b: 0.5 }, { b: 0.96, duration: 0.36, ease: 'expo.out' }, 0)
  tl.fromTo(s.intro, { b: 0.96 }, { b: 1.02, duration: 0.2, ease: 'power2.in', immediateRender: false }, 0.36)

  let t = WORDS_AT
  const starts = []
  words.forEach((w, i) => {
    if (i > 0 && w.li !== words[i - 1].li) t += 0.1
    starts.push(t)
    tl.fromTo(s.words[i], { y: 1 }, { y: 0, duration: 0.72, ease: 'expo.out' }, t)
    tl.fromTo(s.words[i], { r: 7 }, { r: 0, duration: 0.6, ease: 'power3.out' }, t)
    t += 0.085
  })
  let segAt = t + 0.3
  segs.forEach((sg, j) => {
    const at = Math.max(segAt, starts[sg.to] + 0.45)
    tl.fromTo(s.segs[j], { p: 0 }, { p: 1, duration: 0.55, ease: 'expo.inOut' }, at)
    segAt = at + 0.16
  })
  const footAt = segs.length ? segAt + 0.1 : t + 0.3
  if (byRun) {
    tl.fromTo(s.marker, { k: 0 }, { k: 1, duration: 0.45, ease: 'back.out(2.2)' }, footAt)
    tl.fromTo(s.by, { p: 0 }, { p: 1, duration: 0.6, ease: 'expo.out' }, footAt + 0.08)
  }
  tl.seek(0)

  // ---------------------------------------------------------------- frames
  const wordDone = (o) => o.y <= 0 && o.r <= 0
  return {
    state(i) {
      tl.seek(i / ctx.fps, false)
      return s
    },
    draw(g) {
      g.layer('bg', () => g.draw(bg))
      const segDone = s.segs.map((o) => o.p >= 1)
      const footDone = !byRun || (s.by.p >= 1 && s.marker.k >= 1)
      const key = s.words.map((o) => (wordDone(o) ? 1 : 0)).join('') + '|' + segDone.map(Number).join('') + '|' + Number(footDone)
      g.layer(key, () => {
        words.forEach((w, i) => wordDone(s.words[i]) && g.draw(w.sprite))
        segs.forEach((sg, j) => {
          if (!segDone[j]) return
          g.draw(sg.sprite)
          for (let i = sg.from; i <= sg.to; i++) g.draw(words[i].inv)
        })
        if (byRun && footDone) {
          g.fill(marker, accent, { transform: affine(...markerAt) })
          g.draw(by)
        }
      })

      // Intro line.
      const { a, b } = s.intro
      if (b - a > 0.001 && a < 1) {
        const x0 = Math.max(0, a * W)
        const x1 = Math.min(W, b * W)
        g.fill(introLine, accent, { transform: [x1 - x0, 0, 0, 1, x0, lineY] })
      }

      // Rising words, line by line, each line followed by its mask band.
      lines.forEach((_, li) => {
        let x0 = Infinity
        let x1 = -Infinity
        words.forEach((w, i) => {
          const o = s.words[i]
          if (w.li !== li || wordDone(o) || o.y >= 1) return
          g.fill(w.path, w.color, { transform: affine(w.x, w.baseline + o.y * travel, o.r) })
          x0 = Math.min(x0, w.x)
          x1 = Math.max(x1, w.x + w.w)
        })
        if (x0 < x1) {
          const y0 = lineInfo[li].coverTop
          g.draw(bg, { clip: [x0 - 24, y0, x1 + 24, y0 + travel + size * 0.5 + (x1 - x0) * 0.13] })
        }
      })

      // Highlight wipes.
      segs.forEach((sg, j) => {
        const pr = s.segs[j].p
        if (pr <= 0 || segDone[j]) return
        const cx = sg.x0 + (sg.x1 - sg.x0) * pr
        const clip = [sg.x0, sg.y0 - 2, cx, sg.y1 + 2]
        g.draw(sg.sprite, { clip })
        for (let i = sg.from; i <= sg.to; i++) g.draw(words[i].inv, { clip })
      })

      // Footer.
      if (byRun && !footDone) {
        const mk = s.marker.k
        if (mk > 0) g.fill(marker, accent, { transform: affine(markerAt[0], markerAt[1], 90 * (1 - mk), mk) })
        if (s.by.p > 0) g.draw(by, { opacity: s.by.p, clip: [0, 0, PAD_X + 28 + (byRun.advance + 8) * s.by.p, H] })
      }
    },
    dispose: () => tl.kill(),
  }
}
