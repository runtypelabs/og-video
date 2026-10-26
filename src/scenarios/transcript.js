// transcript: an AI agent run, replayed. The header (title and an agent/model pill) settles, then
// the conversation plays in order: the user's bubble pops in on the right, each tool call lands as
// a mono chip whose spinner resolves into a check, its result folds in underneath, and a typing
// indicator gives way to the assistant's reply streaming in line by line. The optional stats
// footer settles last. When the run is taller than the card, the conversation scrolls up by whole
// pixels so the final answer lands in view; the last frame (the poster) is the whole run's summary.
//
// Messages are one string each with a short role prefix: `u:` user, `a:` assistant, `t:` tool
// call, `r:` tool result, `r!:` (or `error:`) a failed one: its call's spinner resolves into a red
// cross instead, and the result is tinted. In a URL they go as `chat`, joined with `|` (no JSON quoting to
// escape); `messages` takes the same strings as a JSON array when a message needs a literal `|`.
//
// The first 30 frames (0.5 s, the header settling) depend only on title, model, accent and theme.
//
// Every bubble, chip and result is a sprite rasterized once at its place in the conversation.
// Settled items are drawn in a cached layer keyed by the settled set and the (whole-pixel) scroll;
// only the item in flight is drawn live (a spinner, three dots, a line wiping in). Once the footer
// lands nothing changes, and every later frame is skipped.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, ellipse, linear } from '../gfx.js'
import { settleTimes, bakedAt } from '../gsap.js'
import { W, H, THEMES, background, mix, hex, onColor, affine } from './showcase-kit.js'

const PAD_X = 64
const CW = W - 2 * PAD_X
const RULE_Y = 100
const PAD_V = 16
const FADE = 28
const START = 0.5
const END_BY = 5.7

// Bubbles: Inter 26 on 36 px lines.
const MSG = 26
const LH = 36
const BPX = 22
const BPY = 14
const BUBBLE_MAX = 780
// Tool chips and results: JetBrains Mono.
const CHIP_H = 44
const CHIP_TEXT = 20
const RES_TEXT = 18
const RES_LH = 27
const ICON_CX = 24

export const DEFAULT_CHAT = [
  "u: Where's my order? It was supposed to arrive Monday.",
  't: search_orders(email="sam@example.com")',
  'r: 1 order: #4821, delayed at the carrier, new ETA Thursday',
  't: refund_shipping(order="4821")',
  'r: $12.00 refunded to the original card',
  'a: Your order #4821 was delayed at the carrier and will arrive Thursday. I refunded the $12 shipping fee, so you will see it on your card in 3 to 5 days.',
].join(' | ')

export const transcript = defineScenario({
  id: 'transcript',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  fonts: { mono: 'jetbrains-mono' },
  params: p.object({
    title: p.string({ max: 60, default: 'Support thread #4821' }),
    model: p.string({ max: 32, default: 'support-agent' }),
    // "u: question | t: tool(args) | r: result | a: answer"
    chat: p.string({ max: 1600, default: DEFAULT_CHAT }),
    messages: p.array(p.string({ max: 280 }), { max: 10, optional: true }),
    stats: p.string({ max: 64, default: '2 tool calls · 1,284 tokens · 3.2 s' }),
    accent: p.color({ default: '#3b82f6' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 30, key: (q) => JSON.stringify([q.accent, q.theme, q.title, q.model]) },
  meta: (q) => {
    const msgs = parseChat(q)
    const first = msgs.find((m) => m.role === 'u')
    const last = [...msgs].reverse().find((m) => m.role === 'a')
    return { title: q.title || first?.text || 'Agent run', description: last?.text }
  },
  setup,
})

const ROLES = { u: 'u', user: 'u', a: 'a', assistant: 'a', agent: 'a', t: 't', tool: 't', call: 't', r: 'r', result: 'r', 'r!': 'r!', error: 'r!' }

/**
 * The messages, from `messages` or `chat`: [{ role: 'u' | 'a' | 't' | 'r', error?, text }], at
 * most 10. A failed result (`r!:`, `error:`) is role 'r' with `error: true`.
 */
export function parseChat(q) {
  const raw = q.messages ?? (q.chat ? q.chat.split(/\s*[|\n]\s*/) : [])
  const out = []
  for (const s of raw) {
    const m = s.match(/^\s*([a-z]+!?)\s*:\s*([\s\S]*)$/i)
    const role = m && Object.hasOwn(ROLES, m[1].toLowerCase()) ? ROLES[m[1].toLowerCase()] : undefined
    // No (known) prefix: alternate user and assistant.
    const r = role ?? (out.filter((x) => x.role === 'u' || x.role === 'a').at(-1)?.role === 'u' ? 'a' : 'u')
    const text = (role ? m[2] : s).trim().slice(0, 280)
    if (text) out.push(r === 'r!' ? { role: 'r', error: true, text } : { role: r, text })
  }
  return out.slice(0, 10)
}

/** A rounded rectangle with its own radius per corner: [top left, top right, bottom right, bottom left]. */
function rrect4(x, y, w, h, [a, b, c, d]) {
  const k = 0.5522847498
  return [
    0, x + a, y,
    1, x + w - b, y,
    3, x + w - b + b * k, y, x + w, y + b - b * k, x + w, y + b,
    1, x + w, y + h - c,
    3, x + w, y + h - c + c * k, x + w - c + c * k, y + h, x + w - c, y + h,
    1, x + d, y + h,
    3, x + d - d * k, y + h, x, y + h - d + d * k, x, y + h - d,
    1, x, y + a,
    3, x, y + a - a * k, x + a - a * k, y, x + a, y,
    4,
  ]
}

/** A ring segment (the spinner) centred on (0, 0), from 0 to `sweep` degrees. */
function arc(r0, r1, sweep, n = 24) {
  const out = []
  const pt = (r, i) => {
    const t = ((sweep * i) / n) * (Math.PI / 180)
    return [Math.cos(t) * r, Math.sin(t) * r]
  }
  for (let i = 0; i <= n; i++) out.push(i ? 1 : 0, ...pt(r1, i))
  for (let i = n; i >= 0; i--) out.push(1, ...pt(r0, i))
  out.push(4)
  return out
}

/** A straight bar `w` wide from a to b, as a quad (butt ends). */
function bar([x0, y0], [x1, y1], w) {
  const l = Math.hypot(x1 - x0, y1 - y0)
  const nx = (-(y1 - y0) / l) * (w / 2)
  const ny = ((x1 - x0) / l) * (w / 2)
  return [0, x0 + nx, y0 + ny, 1, x1 + nx, y1 + ny, 1, x1 - nx, y1 - ny, 1, x0 - nx, y0 - ny, 4]
}

/** A check mark as one filled polygon: a 2-segment polyline `w` wide, mitred at the elbow. */
function check(points, w) {
  const [a, b, c] = points
  const norm = ([x0, y0], [x1, y1]) => {
    const l = Math.hypot(x1 - x0, y1 - y0)
    return [-(y1 - y0) / l, (x1 - x0) / l]
  }
  const n1 = norm(a, b)
  const n2 = norm(b, c)
  const h = w / 2
  const d = 1 + n1[0] * n2[0] + n1[1] * n2[1]
  const m = [((n1[0] + n2[0]) / d) * h, ((n1[1] + n2[1]) / d) * h]
  return [
    0, a[0] + n1[0] * h, a[1] + n1[1] * h,
    1, b[0] + m[0], b[1] + m[1],
    1, c[0] + n2[0] * h, c[1] + n2[1] * h,
    1, c[0] - n2[0] * h, c[1] - n2[1] * h,
    1, b[0] - m[0], b[1] - m[1],
    1, a[0] - n1[0] * h, a[1] - n1[1] * h,
    4,
  ]
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const inOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

function setup(ctx, q) {
  const { text } = ctx
  const theme = THEMES[q.theme]
  const dark = q.theme === 'dark'
  const accent = hex(q.accent)
  const ink = onColor(accent)
  const bg = background(ctx, theme, accent, { glowAt: [W - 120, H + 60], radius: 820 })
  const surface = dark ? mix(theme.bg, 0xffffff, 0.08) : 0xffffff
  const danger = dark ? 0xef4444 : 0xdc2626
  const dangerText = dark ? 0xf87171 : 0xc81e1e
  const dangerEdge = mix(dark ? mix(theme.bg, 0xffffff, 0.14) : mix(theme.bg, 0x000000, 0.11), danger, 0.55)
  const surfaceEdge = dark ? null : mix(theme.bg, 0x000000, 0.08)
  const chipFill = dark ? mix(theme.bg, 0xffffff, 0.035) : mix(theme.bg, 0xffffff, 0.55)
  const chipEdge = dark ? mix(theme.bg, 0xffffff, 0.14) : mix(theme.bg, 0x000000, 0.11)
  const ruleColor = dark ? mix(theme.bg, 0xffffff, 0.1) : mix(theme.bg, 0x000000, 0.09)
  const outline = (cmds, inner, color) => ({ cmds: [...cmds, ...inner], color, evenodd: true })

  const msgs = parseChat(q)
  if (!msgs.length) msgs.push(...parseChat({ chat: DEFAULT_CHAT }))

  const items = []
  const item = (targets, draw, fixed = false) => {
    const it = { group: items.length, targets, draw, fixed, settle: 0 }
    items.push(it)
    return it
  }

  // ---------------------------------------------------------------- header
  const hasHeader = Boolean(q.title || q.model)
  const pillText = q.model ? text.fit('mono', q.model, 17, 360) : null
  const pillH = 34
  const pillW = pillText ? Math.ceil(pillText.advance + 44) : 0
  const pillX = W - PAD_X - pillW
  const pillY = 38
  const pill = pillText
    ? ctx.sprite(
        [
          { cmds: rrect(pillX, pillY, pillW, pillH, pillH / 2), color: chipFill },
          outline(rrect(pillX, pillY, pillW, pillH, pillH / 2), rrect(pillX + 1, pillY + 1, pillW - 2, pillH - 2, pillH / 2 - 1), chipEdge),
          { cmds: rrect(pillX + 14, pillY + pillH / 2 - 5, 10, 10, 3), color: accent },
          { cmds: pillText.cmds(pillX + 32, pillY + text.baselineIn('mono', 17, pillH)), color: theme.muted },
        ],
        { margin: 2 },
      )
    : null
  const titleRun = q.title ? text.fit('semibold', q.title, 30, CW - (pillW ? pillW + 32 : 0), { letterSpacing: -0.6 }) : null
  const title = titleRun ? ctx.sprite([{ cmds: titleRun.cmds(PAD_X, pillY + text.baselineIn('semibold', 30, pillH)), color: theme.fg }], { margin: 2 }) : null
  const rulePath = hasHeader ? ctx.path(rect(0, 0, 1, 1)) : null
  const head = { title: 0, pill: 0, rule: 0 }
  if (hasHeader)
    item([head], (g) => {
      if (title && head.title > 0) g.draw(title, { opacity: head.title, transform: [1, 0, 0, 1, 0, Math.round((1 - head.title) * 10)] })
      if (pill && head.pill > 0) g.draw(pill, { opacity: head.pill, transform: [1, 0, 0, 1, 0, Math.round((1 - head.pill) * 10)] })
      if (head.rule > 0) g.fill(rulePath, ruleColor, { transform: [CW * head.rule, 0, 0, 1, PAD_X, RULE_Y] })
    }, true)

  // ---------------------------------------------------------------- footer
  const statsRun = q.stats ? text.fit('mono', q.stats, 17, CW - 30) : null
  const footBase = H - 30
  const stats = statsRun
    ? ctx.sprite(
        [
          { cmds: rrect(PAD_X, footBase - 11, 10, 10, 3), color: accent },
          { cmds: statsRun.cmds(PAD_X + 20, footBase), color: theme.muted },
        ],
        { margin: 2 },
      )
    : null

  // ---------------------------------------------------------------- the conversation
  // Laid out in content coordinates (y from 0); drawn moved by `off` = where content y 0 is now.
  const CLIP0 = hasHeader ? RULE_Y + 1 : 24
  const CLIP1 = stats ? H - 62 : H - 24
  const VIEW_H = CLIP1 - CLIP0 - 2 * PAD_V
  const view = (top, bottom) => [0, Math.max(CLIP0, top), W, Math.min(CLIP1, bottom)]
  const maxLines = Math.max(2, Math.min(5, Math.floor((VIEW_H - 2 * BPY) / LH)))

  const convo = []
  let y = 0
  let prev = null
  msgs.forEach((m, mi) => {
    if (prev) y += m.role === 'r' && prev.role === 't' ? 6 : prev.role === m.role && m.role !== 'r' ? 10 : 16
    if (m.role === 'u' || m.role === 'a') {
      const right = m.role === 'u'
      const lines = text.wrap('regular', m.text, MSG, BUBBLE_MAX - 2 * BPX, { maxLines })
      const tw = Math.ceil(Math.max(...lines.map((l) => l.width)))
      const bw = tw + 2 * BPX
      const x = right ? W - PAD_X - bw : PAD_X
      const fg = right ? ink : theme.fg
      const fill = right ? accent : surface
      const shape = (h, w = bw) => rrect4(x, y, w, h, right ? [20, 20, 6, 20] : [20, 20, 20, 6])
      const shapeLayers = (h, w = bw) => [
        { cmds: shape(h, w), color: fill },
        !right && surfaceEdge && outline(shape(h, w), rrect4(x + 1, y + 1, w - 2, h - 2, [19, 19, 19, 5]), surfaceEdge),
      ]
      const base = text.baselineIn('regular', MSG, LH)
      const lineCmds = lines.map((l, j) => l.words.flatMap((w) => w.run.cmds(x + BPX + w.x, y + BPY + j * LH + base)))
      const h = lines.length * LH + 2 * BPY
      const entry = { role: m.role, y, h, lines: lines.length }
      if (right) {
        const sp = ctx.sprite([...shapeLayers(h), ...lineCmds.map((cmds) => ({ cmds, color: fg }))], { margin: 2 })
        const o = { o: 0 }
        entry.o = o
        entry.it = item([o], (g, off) => {
          if (o.o > 0) g.draw(sp, { opacity: o.o, transform: [1, 0, 0, 1, 0, off + Math.round((1 - o.o) * 16)], clip: view(-1e6, 1e6) })
        })
      } else {
        // Streams in: the bubble grows a line at a time while each line wipes in left to right.
        // Before that a typing indicator (a one-line bubble with three dots) holds its place.
        const grown = lines.map((_, j) => ctx.sprite(shapeLayers((j + 1) * LH + 2 * BPY), { margin: 2 }))
        const lineSprites = lineCmds.map((cmds) => ctx.sprite([{ cmds, color: fg }], { margin: 2 }))
        const typing = ctx.sprite(shapeLayers(LH + 2 * BPY, 92), { margin: 2 })
        const dot = ctx.path(ellipse(0, 0, 5))
        const dotY = y + BPY + LH / 2
        const o = { typing: 0, dots: 0, stream: 0 }
        entry.o = o
        entry.it = item([o], (g, off) => {
          const clip = view(-1e6, 1e6)
          if (o.stream <= 0) {
            if (o.typing <= 0) return
            g.draw(typing, { opacity: o.typing, transform: [1, 0, 0, 1, 0, off], clip })
            for (let j = 0; j < 3; j++) {
              const ph = (((o.dots - j * 0.16) % 1) + 1) % 1
              const lift = ph < 0.5 ? Math.sin(ph * 2 * Math.PI) * 5 : 0
              const a = 0.45 + 0.55 * (lift / 5)
              g.fill(dot, theme.muted, { alpha: o.typing * a, transform: affine(x + 26 + j * 20, dotY + off - lift), clip })
            }
            return
          }
          const n = Math.min(lines.length, Math.ceil(o.stream - 1e-6))
          g.draw(grown[n - 1], { transform: [1, 0, 0, 1, 0, off], clip })
          for (let j = 0; j < n; j++) {
            // Whole words, the way tokens arrive.
            const shown = clamp01(o.stream - j) * lines[j].width
            const words = lines[j].words
            if (shown >= lines[j].width) g.draw(lineSprites[j], { transform: [1, 0, 0, 1, 0, off], clip })
            else {
              let edge = 0
              for (const w of words) if (w.x + w.run.advance <= shown) edge = w.x + w.run.advance
              if (edge > 0) g.draw(lineSprites[j], { transform: [1, 0, 0, 1, 0, off], clip: [x, clip[1], x + BPX + edge + 4, clip[3]] })
            }
          }
        })
      }
      convo.push(entry)
      y += h
    } else if (m.role === 't') {
      // name(args): the name in the foreground colour, the arguments muted.
      const mt = m.text.match(/^([^(\s]+)(\([\s\S]*)?$/)
      const name = mt ? mt[1] : m.text
      const args = mt?.[2] ?? ''
      const maxW = CW - 56
      let nameRun = text.fit('mono', name, CHIP_TEXT, maxW)
      const argsRun = args && nameRun.advance < maxW - 40 ? text.fit('mono', args, CHIP_TEXT, maxW - nameRun.advance) : null
      const tw = nameRun.advance + (argsRun?.advance ?? 0)
      const cw = Math.ceil(tw + 44 + 18)
      const base = y + text.baselineIn('mono', CHIP_TEXT, CHIP_H)
      const tx = PAD_X + 44
      const sp = ctx.sprite(
        [
          { cmds: rrect(PAD_X, y, cw, CHIP_H, 10), color: chipFill },
          outline(rrect(PAD_X, y, cw, CHIP_H, 10), rrect(PAD_X + 1, y + 1, cw - 2, CHIP_H - 2, 9), chipEdge),
          { cmds: nameRun.cmds(tx, base), color: theme.fg },
          argsRun && { cmds: argsRun.cmds(tx + nameRun.advance, base), color: theme.muted },
        ],
        { margin: 2 },
      )
      const cx = PAD_X + ICON_CX
      const cy = y + CHIP_H / 2
      const spinner = ctx.path(arc(6.5, 9, 270))
      // Resolves into a check, or a red cross when its result failed.
      const failed = msgs[mi + 1]?.role === 'r' && msgs[mi + 1].error
      const done = ctx.sprite(
        failed
          ? [
              { cmds: ellipse(0, 0, 11), color: danger },
              { cmds: bar([-4, -4], [4, 4], 2.6), color: 0xffffff },
              { cmds: bar([4, -4], [-4, 4], 2.6), color: 0xffffff },
            ]
          : [
              { cmds: ellipse(0, 0, 11), color: accent },
              { cmds: check([[-5, 0.5], [-1.5, 4], [5, -3.5]], 2.6), color: ink },
            ],
        { margin: 2 },
      )
      const o = { o: 0, spin: 0, ok: 0 }
      const entry = { role: 't', y, h: CHIP_H, o }
      entry.it = item([o], (g, off) => {
        if (o.o <= 0) return
        const clip = view(-1e6, 1e6)
        const dy = off + Math.round((1 - o.o) * 12)
        g.draw(sp, { opacity: o.o, transform: [1, 0, 0, 1, 0, dy], clip })
        if (o.ok < 1) g.fill(spinner, theme.muted, { alpha: o.o * (1 - o.ok), transform: affine(cx, cy + dy, o.spin), clip })
        if (o.ok > 0) g.draw(done, { opacity: clamp01(o.ok * 2), transform: o.ok === 1 ? [1, 0, 0, 1, cx, cy + dy] : [o.ok, 0, 0, o.ok, cx, cy + dy], clip })
      })
      convo.push(entry)
      y += CHIP_H
    } else {
      // A result folds in under its call, joined by an elbow from the call's icon.
      const lines = text.wrap('mono', m.text, RES_TEXT, CW - 52, { maxLines: 2 })
      const h = lines.length * RES_LH + 4
      const base = text.baselineIn('mono', RES_TEXT, RES_LH)
      const joined = prev?.role === 't'
      const ex = PAD_X + ICON_CX
      const ey = joined ? y - 6 : y
      const sp = ctx.sprite(
        [
          { cmds: rect(ex - 1, ey, ex + 1, y + RES_LH / 2 + 1), color: m.error ? dangerEdge : chipEdge },
          { cmds: rrect(ex - 1, y + RES_LH / 2 - 1, 16, 2, 1), color: m.error ? dangerEdge : chipEdge },
          ...lines.map((l, j) => ({ cmds: l.words.flatMap((w) => w.run.cmds(PAD_X + 52 + w.x, y + 2 + j * RES_LH + base)), color: m.error ? dangerText : theme.muted })),
        ],
        { margin: 2 },
      )
      const o = { r: 0 }
      const entry = { role: 'r', y, h, o }
      entry.it = item([o], (g, off) => {
        if (o.r <= 0) return
        const c = view(ey + off - 2, y + off + 4 + o.r * h)
        g.draw(sp, { opacity: clamp01(o.r * 1.4), transform: [1, 0, 0, 1, 0, off], clip: c })
      })
      convo.push(entry)
      y += h
    }
    prev = m
  })
  const total = y
  // A run that fits is centred in the space; a taller one starts at the top and scrolls.
  const top = CLIP0 + PAD_V + (total <= VIEW_H ? Math.round((VIEW_H - total) / 2) : 0)
  const scrollFor = (bottom) => Math.max(0, Math.ceil(bottom - VIEW_H))

  const foot = { o: 0 }
  if (stats) item([foot], (g) => g.draw(stats, { opacity: foot.o, transform: [1, 0, 0, 1, 0, Math.round((1 - foot.o) * 8)] }), true)

  // Restores the background along the top edge of the conversation, fading out, so scrolled
  // content slides under the header instead of being cut.
  const fade = ctx.sprite([{ cmds: rect(0, CLIP0, W, CLIP0 + FADE), color: linear(0, CLIP0, 0, CLIP0 + FADE, [[0, '#ffffff', 1], [1, '#ffffff', 0]]) }], { margin: 0 })

  // ---------------------------------------------------------------- timeline
  // Laid out at natural pace, then compressed (never stretched) to end by END_BY.
  const plan = (emit) => {
    let c = 0
    const scrolls = []
    const scrollTo = (t, bottom) => scrolls.push({ t, y: scrollFor(bottom) })
    convo.forEach((e, i) => {
      const next = convo[i + 1]
      if (e.role === 'u') {
        emit(e.o, { o: 0 }, { o: 1, duration: 0.4, ease: 'expo.out' }, c)
        scrollTo(c, e.y + e.h)
        c += 0.5 + 0.1 * e.lines
      } else if (e.role === 't') {
        const spin = 0.75
        emit(e.o, { o: 0 }, { o: 1, duration: 0.3, ease: 'expo.out' }, c)
        emit(e.o, { spin: 0 }, { spin: 360 * 1.6, duration: spin + 0.3, ease: 'none' }, c)
        emit(e.o, { ok: 0 }, { ok: 1, duration: 0.4, ease: 'back.out(2.4)' }, c + spin)
        scrollTo(c, e.y + e.h)
        c += spin + (next?.role === 'r' ? 0.15 : 0.35)
      } else if (e.role === 'r') {
        emit(e.o, { r: 0 }, { r: 1, duration: 0.35, ease: 'power2.out' }, c)
        scrollTo(c, e.y + e.h)
        c += 0.45
      } else {
        const type = 0.7
        const per = 0.24
        emit(e.o, { typing: 0 }, { typing: 1, duration: 0.15, ease: 'power2.out' }, c)
        emit(e.o, { dots: 0 }, { dots: 2, duration: type, ease: 'none' }, c)
        emit(e.o, { stream: 0 }, { stream: e.lines, duration: per * e.lines, ease: 'none' }, c + type)
        scrollTo(c, e.y + LH + 2 * BPY)
        for (let j = 1; j < e.lines; j++) scrollTo(c + type + per * j, e.y + (j + 1) * LH + 2 * BPY)
        c += type + per * e.lines + 0.25
      }
    })
    if (stats) emit(foot, { o: 0 }, { o: 1, duration: 0.4, ease: 'expo.out' }, c)
    return { end: c, scrolls }
  }
  const natural = plan(() => {})
  const speed = Math.min(1, (END_BY - START) / Math.max(natural.end, 0.01))
  const tl = gsap.timeline({ paused: true })
  if (hasHeader) {
    tl.fromTo(head, { title: 0 }, { title: 1, duration: 0.4, ease: 'expo.out' }, 0.02)
    tl.fromTo(head, { pill: 0 }, { pill: 1, duration: 0.4, ease: 'expo.out' }, 0.1)
    tl.fromTo(head, { rule: 0 }, { rule: 1, duration: 0.42, ease: 'expo.inOut' }, 0.05)
  }
  const { scrolls } = plan((target, from, to, at) => tl.fromTo(target, from, { ...to, duration: to.duration * speed }, START + at * speed))
  tl.seek(0)
  settleTimes(tl, items)

  // Scroll keyframes: each eases from wherever the previous one had reached when it starts.
  const SCROLL_DUR = 0.3 * speed
  const keys = []
  const along = (k, t) => k.from + (k.to - k.from) * inOut(clamp01((t - k.t) / SCROLL_DUR))
  for (const s of scrolls) {
    const t = START + s.t * speed
    const last = keys.at(-1)
    if (s.y === (last ? last.to : 0)) continue
    keys.push({ t, to: s.y, from: last ? along(last, t) : 0 })
  }
  const scrollAt = (t) => {
    let v = 0
    for (const k of keys) {
      if (t < k.t) break
      v = along(k, t)
    }
    return Math.round(v)
  }

  // ---------------------------------------------------------------- frames
  return {
    state(i) {
      const t = i / ctx.fps
      tl.seek(t, false)
      const baked = bakedAt(items, t)
      return { scroll: scrollAt(t), baked: baked.map((b) => (b ? 1 : 0)).join(''), live: items.map((it, j) => (baked[j] ? 0 : it.targets)) }
    },
    draw(g, s) {
      const off = top - s.scroll
      g.layer('bg', () => g.draw(bg))
      g.layer(`${s.baked}|${s.scroll}`, () => items.forEach((it, j) => s.baked[j] === '1' && it.draw(g, off)))
      items.forEach((it, j) => s.baked[j] === '0' && it.draw(g, off))
      if (s.scroll > 0) g.draw(bg, { mask: fade, clip: [0, CLIP0, W, CLIP0 + FADE] })
    },
    dispose: () => tl.kill(),
  }
}
