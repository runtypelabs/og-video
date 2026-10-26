// pr: a pull request card, for "PR is up" and "merged!" shares. The repo and number wipe in, the
// title rises line by line, the state pill pops beside the author and branches, then a diff
// panel lands: each changed line types in over its red or green row while the +additions,
// -deletions and file counters tick up. A merged PR flips its pill from Open to Merged and a
// stamp lands on the diff; a closed one flips to Closed, dims the diff and gets a red stamp.
// Open and draft PRs end on the diff, with a pulse on the pill.
//
// `lines` are unified-diff lines: a leading '+', '-' or ' ' (context), or '@@' for a hunk
// header. Only the first lines that fit are shown; the counters are explicit params, since a
// card shows a few lines of a bigger change.
//
// The first 24 frames (0.4 s, the repo row wiping in) depend only on theme, accent, repo and
// number.
//
// Every line, the pills, the panel and the stamp are sprites rasterized once; motion is clips
// (typing, wipes), opacity and whole-pixel moves. Counters are drawn from ten pre-shaped
// monospace digit paths. Everything that has landed is in a cached layer keyed by what has
// settled, so after ~3.6 s every frame is identical and skipped.
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, ellipse, pose } from '../gfx.js'
import { W, H, background, mix, onColor, prng, q4 } from './showcase-kit.js'
import { MONO_FONTS, MONO_FEATURES, roles, windowLayers, monoWidth, checkCmds, crossCmds, polyline, ringCmds, hash } from './code-kit.js'

const PAD_X = 72
const REPO_Y = 70
const TITLE_SIZE = 46
const TITLE_LH = 56
const PILL_H = 40
const HEAD_H = 50
const CODE_SIZE = 20
const CODE_LH = 30
const CODE_LH_MAX = 34

const AVATARS = [0xf97316, 0x0ea5e9, 0x22c55e, 0xe11d48, 0x8b5cf6, 0xeab308, 0x14b8a6]

export const pr = defineScenario({
  id: 'pr',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  fonts: MONO_FONTS,
  params: p.object({
    repo: p.string({ max: 60, default: 'orbit/checkout' }),
    number: p.int({ min: 0, max: 9999999, default: 1842 }),
    title: p.string({ max: 120, min: 1, default: 'Stream cart totals instead of polling' }),
    author: p.string({ max: 39, default: 'mira' }),
    state: p.enum(['open', 'merged', 'closed', 'draft'], { default: 'merged' }),
    base: p.string({ max: 40, default: 'main' }),
    head: p.string({ max: 60, default: 'mira/stream-totals' }),
    file: p.string({ max: 100, default: 'src/cart/totals.ts' }),
    lines: p.array(p.string({ max: 160 }), {
      max: 12,
      default: [
        '@@ -41,9 +41,11 @@ export async function totals(cart) {',
        '-  const res = await fetch(`/api/totals?cart=${cart.id}`)',
        '-  return res.json()',
        '+  const stream = client.totals.stream({ cart: cart.id })',
        '+  for await (const update of stream) {',
        '+    render(update)',
        '+  }',
        '   return stream.final()',
      ],
    }),
    additions: p.int({ min: 0, max: 9999999, default: 128 }),
    deletions: p.int({ min: 0, max: 9999999, default: 34 }),
    files: p.int({ min: 0, max: 99999, default: 6 }),
    accent: p.color({ default: '#8b5cf6' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 24, key: (q) => `${q.theme}|${q.accent}|${q.repo}|${q.number}` },
  meta: (q) => ({
    title: `${q.title}${q.number ? ` #${q.number}` : ''}`,
    description: [q.repo, `${q.state === 'open' ? 'Opened' : LABELS[q.state]}${q.author ? ` by ${q.author}` : ''}`, `+${q.additions} -${q.deletions}`, q.files ? `${q.files} file${q.files === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
  }),
  setup,
})

const LABELS = { open: 'Open', merged: 'Merged', closed: 'Closed', draft: 'Draft' }

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeOut3 = (t) => 1 - (1 - t) ** 3
const easeOut5 = (t) => 1 - (1 - t) ** 5
const easeBack = (t, s = 2.2) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2
/** Progress of a tween starting at `at` lasting `d`, eased. */
const tw = (t, at, d, ease = easeOut3) => ease(clamp01((t - at) / d))

/** Rotates a command buffer by `deg` around (cx, cy). */
function turn(cmds, deg, cx, cy) {
  const r = (deg * Math.PI) / 180
  const cs = Math.cos(r)
  const sn = Math.sin(r)
  const ARGS = [2, 2, 4, 6, 0]
  const out = []
  for (let i = 0; i < cmds.length; ) {
    const op = cmds[i++]
    out.push(op)
    for (let j = 0; j < ARGS[op]; j += 2) {
      const x = cmds[i++] - cx
      const y = cmds[i++] - cy
      out.push(cx + x * cs - y * sn, cy + x * sn + y * cs)
    }
  }
  return out
}

/** The pull-request glyph (two commits and a branch arrow), centred on (cx, cy), `s` px tall. */
function prIcon(cx, cy, s) {
  const k = s / 22
  const r0 = 1.7 * k
  const r1 = 3.4 * k
  const lw = 2 * k
  const lx = cx - 5.5 * k
  const rx = cx + 5.5 * k
  const top = cy - 7 * k
  const bot = cy + 7 * k
  return [
    { cmds: ringCmds(lx, top, r0, r1), evenodd: true },
    { cmds: ringCmds(lx, bot, r0, r1), evenodd: true },
    { cmds: ringCmds(rx, bot, r0, r1), evenodd: true },
    { cmds: polyline([[lx, top + r1], [lx, bot - r1]], lw) },
    { cmds: polyline([[rx, bot - r1], [rx, top + 1 * k], [cx - 0.5 * k, top + 1 * k]], lw) },
    { cmds: polyline([[cx + 2.5 * k, top - 2.2 * k], [cx - 0.5 * k, top + 1 * k], [cx + 2.5 * k, top + 4.2 * k]], lw) },
  ]
}

function setup(ctx, q) {
  const { text } = ctx
  const c = roles(q.theme, q.accent)
  const bg = background(ctx, c, c.accent, { glowAt: [W * 0.9, -60], radius: 820 })
  const stateColor = { open: c.ok, merged: c.accent, closed: c.err, draft: mix(c.muted, c.bg, 0.25) }
  const finalColor = stateColor[q.state]
  const flips = q.state === 'merged' || q.state === 'closed'

  // ---------------------------------------------------------------- repo row
  const repoRun = q.repo ? text.fit('semibold', q.repo, 24, W - 2 * PAD_X - 200) : null
  const numStr = q.number ? `#${q.number}` : ''
  const numRun = numStr ? text.run('semibold', numStr, 24) : null
  const repoX = PAD_X + 26
  const repoBase = REPO_Y + 9
  const numX = repoRun ? Math.round(repoX + repoRun.advance + 10) : repoX
  const marker = repoRun || numRun ? ctx.sprite([{ cmds: rrect(PAD_X, REPO_Y - 7, 14, 14, 3), color: c.accent }], { margin: 2 }) : null
  const repo = ctx.sprite(
    [
      repoRun && { cmds: repoRun.cmds(repoX, repoBase), color: c.muted },
      numRun && { cmds: numRun.cmds(numX, repoBase), color: c.accentInk },
    ],
    { margin: 4 },
  )
  const repoW = numRun ? numX + numRun.advance - repoX : repoRun ? repoRun.advance : 0

  // ---------------------------------------------------------------- title
  const titleLines = text.wrap('semibold', q.title, TITLE_SIZE, W - 2 * PAD_X, { letterSpacing: -0.02 * TITLE_SIZE, maxLines: 2 })
  const titleTop = 140
  const titles = titleLines.map((line, i) => {
    const base = titleTop + i * TITLE_LH
    const layers = line.words.map((w) => ({ cmds: w.run.cmds(PAD_X + w.x, base), color: c.fg }))
    return { base, w: line.width, sprite: ctx.sprite(layers, { margin: 4 }) }
  })
  const titleEnd = titleTop + (titles.length - 1) * TITLE_LH

  // ---------------------------------------------------------------- meta row: pill, author, branches
  const metaTop = titleEnd + 32
  const metaCy = metaTop + PILL_H / 2
  const pillRuns = { from: text.run('semibold', 'Open', 20), to: text.run('semibold', LABELS[q.state], 20) }
  const pillW = Math.ceil(Math.max(pillRuns.from.advance, pillRuns.to.advance) + 16 + 22 + 18)
  const pillOf = (state, run) => {
    const fill = stateColor[state]
    const ink = state === 'draft' ? c.fg : onColor(fill)
    const icon = state === 'merged' ? [{ cmds: checkCmds(PAD_X + 25, metaCy, 20) }] : state === 'closed' ? [{ cmds: crossCmds(PAD_X + 25, metaCy, 19) }] : prIcon(PAD_X + 25, metaCy, 18)
    return ctx.sprite(
      [
        { cmds: rrect(PAD_X, metaTop, pillW, PILL_H, PILL_H / 2), color: fill },
        ...icon.map((l) => ({ ...l, color: ink })),
        { cmds: run.cmds(PAD_X + 42, metaTop + text.baselineIn('semibold', 20, PILL_H)), color: ink },
      ],
      { margin: 2 },
    )
  }
  const pillFrom = pillOf(flips ? 'open' : q.state, flips ? pillRuns.from : pillRuns.to)
  const pillTo = flips ? pillOf(q.state, pillRuns.to) : null
  const pillCx = PAD_X + pillW / 2

  let mx = PAD_X + pillW + 18
  const metaLayers = []
  if (q.author) {
    const av = 30
    const avColor = AVATARS[hash(q.author) % AVATARS.length]
    const initial = text.run('semibold', [...q.author][0].toUpperCase(), 16)
    metaLayers.push({ cmds: ellipse(mx + av / 2, metaCy, av / 2), color: avColor })
    metaLayers.push({ cmds: initial.cmds(Math.round(mx + (av - initial.advance) / 2), metaCy + 6), color: onColor(avColor) })
    mx += av + 10
    const name = text.fit('semibold', q.author, 22, 240)
    metaLayers.push({ cmds: name.cmds(mx, metaCy + 8), color: c.fg })
    mx += name.advance + 10
  }
  // Branch chips: "into base from head", in mono on a tinted chip, cut to what fits.
  const chip = (label, room) => {
    const cwc = monoWidth(text, 17)
    const maxCh = Math.floor((room - 18) / cwc)
    if (maxCh < 3) return 0
    const chars = [...label]
    const s = chars.length > maxCh ? `${chars.slice(0, maxCh - 1).join('')}…` : label
    const run = text.run('mono', s, 17, { features: MONO_FEATURES })
    const w = Math.ceil(run.advance + 18)
    metaLayers.push({ cmds: rrect(mx, metaCy - 15, w, 30, 7), color: mix(c.panel, c.accent, c.dark ? 0.16 : 0.1) })
    metaLayers.push({ cmds: run.cmds(mx + 9, metaCy + 6), color: c.accentInk })
    return w
  }
  const word = (s) => {
    const run = text.run('regular', s, 22)
    metaLayers.push({ cmds: run.cmds(mx, metaCy + 8), color: c.muted })
    mx += run.advance + 10
  }
  const right = W - PAD_X
  if (q.base && right - mx > 120) {
    word(q.author ? (q.state === 'merged' ? 'merged into' : q.state === 'closed' ? 'wanted to merge into' : 'wants to merge into') : 'into')
    mx += chip(q.base, Math.min(220, right - mx)) + 10
    if (q.head && right - mx > 120) {
      word('from')
      mx += chip(q.head, right - mx)
    }
  }
  const meta = ctx.sprite(metaLayers, { margin: 3 })
  const metaX0 = PAD_X + pillW + 18

  // ---------------------------------------------------------------- diff panel
  const panel = { x: PAD_X - 8, y: metaTop + PILL_H + 28, w: W - 2 * (PAD_X - 8), h: 0, r: 12 }
  // Without diff lines the panel is just its header: file and counters.
  panel.h = q.lines.length ? H - 40 - panel.y : HEAD_H
  const panelSprite = ctx.sprite(windowLayers(c, { ...panel, bar: HEAD_H, dots: false }), { margin: 2 })
  const shadow = ctx.shadow(panelSprite, { blur: 30, opacity: c.dark ? 0.5 : 0.12 })
  const headCy = panel.y + HEAD_H / 2
  const cw = monoWidth(text, CODE_SIZE)
  const headBase = headCy + 7

  // Counters, right to left: diffstat squares, -deletions, +additions, files.
  const SQ = 12
  const sqX0 = panel.x + panel.w - 20 - (5 * SQ + 4 * 3)
  const total = q.additions + q.deletions
  const nAdd = total ? Math.round((5 * q.additions) / total) : 0
  const nDel = total ? Math.min(5 - nAdd, Math.round((5 * q.deletions) / total)) : 0
  const squares = Array.from({ length: 5 }, (_, j) => ({
    path: ctx.path(rrect(sqX0 + j * (SQ + 3), headCy - SQ / 2, SQ, SQ, 3)),
    color: j < nAdd ? c.ok : j < nAdd + nDel ? c.err : c.rule,
  }))
  const counters = []
  let cx = sqX0 - 16
  const counter = (prefix, value, color, suffix = '') => {
    const s = `${prefix}${value}${suffix}`
    const x1 = cx
    cx -= [...s].length * cw + 14
    counters.push({ prefix, value, suffix, color, x1 })
  }
  counter('-', q.deletions, c.err)
  counter('+', q.additions, c.ok)
  const glyphs = new Map()
  const glyph = (ch, font = 'monoBold') => {
    const key = font + ch
    if (!glyphs.has(key)) glyphs.set(key, ctx.path(text.run(font, ch, CODE_SIZE, { features: MONO_FEATURES }).cmds(0, 0)))
    return glyphs.get(key)
  }
  const filesStr = q.files ? `${q.files} file${q.files === 1 ? '' : 's'}` : ''
  const filesRun = filesStr ? text.run('regular', filesStr, 19) : null
  const filesX = filesRun ? Math.round(cx - filesRun.advance + 4) : cx
  const filesSprite = filesRun ? ctx.sprite([{ cmds: filesRun.cmds(filesX, headBase), color: c.muted }], { margin: 3 }) : null

  const fileRoom = Math.floor(((filesRun ? filesX : cx) - 24 - (panel.x + 20)) / cw)
  const fileChars = [...q.file]
  const fileStr = fileChars.length > fileRoom ? `…${fileChars.slice(fileChars.length - fileRoom + 1).join('')}` : q.file
  const fileRun = fileStr && fileRoom > 4 ? text.run('monoBold', fileStr, CODE_SIZE, { features: MONO_FEATURES }) : null
  const fileSprite = fileRun ? ctx.sprite([{ cmds: fileRun.cmds(panel.x + 20, headBase), color: c.fg }], { margin: 3 }) : null

  // Lines: a tinted row, a gutter bar and sign, and the code, each one sprite.
  const linesTop = panel.y + HEAD_H + 8
  const room = panel.y + panel.h - 8 - linesTop
  const fit = Math.max(0, Math.floor(room / CODE_LH))
  // A short diff opens its lines up a little rather than leaving the panel half empty.
  const lh = Math.max(CODE_LH, Math.min(CODE_LH_MAX, Math.floor(room / Math.max(1, Math.min(fit, q.lines.length)))))
  const codeX = panel.x + 20 + 2 * cw
  const maxCols = Math.floor((panel.x + panel.w - 16 - codeX) / cw)
  const codeBase = text.baselineIn('mono', CODE_SIZE, lh)
  const tint = c.dark ? 0.13 : 0.1
  const rows = q.lines.slice(0, fit).map((src, i) => {
    const kind = src.startsWith('@@') ? '@' : src[0] === '+' || src[0] === '-' ? src[0] : ' '
    const body = kind === '@' ? src : src[0] === '+' || src[0] === '-' || src[0] === ' ' ? src.slice(1) : src
    const chars = [...body.replace(/\t/g, '  ')]
    const shown = chars.length > maxCols ? `${chars.slice(0, maxCols - 1).join('')}…` : chars.join('')
    const y = linesTop + i * lh
    const color = kind === '+' ? c.ok : kind === '-' ? c.err : kind === '@' ? c.accent : null
    const layers = []
    if (color) layers.push({ cmds: rect(panel.x + 1, y, panel.x + panel.w - 1, y + lh), color, alpha: kind === '@' ? tint * 0.7 : tint })
    if (kind === '+' || kind === '-') {
      layers.push({ cmds: rect(panel.x + 1, y, panel.x + 4, y + lh), color })
      layers.push({ cmds: text.run('monoBold', kind, CODE_SIZE, { features: MONO_FEATURES }).cmds(panel.x + 20, y + codeBase), color })
    }
    const ink = kind === '@' ? c.accentInk : kind === ' ' ? mix(c.fg, c.muted, 0.45) : c.fg
    if (shown.trim()) layers.push({ cmds: text.run('mono', shown, CODE_SIZE, { features: MONO_FEATURES }).cmds(kind === '@' ? panel.x + 20 : codeX, y + codeBase), color: ink })
    return { y, cols: [...shown].length + (kind === '@' ? 0 : 2), sprite: ctx.sprite(layers, { margin: 2 }) }
  })
  const dim = q.state === 'closed' && rows.length ? ctx.path(rect(panel.x + 1, linesTop - 8, panel.x + panel.w - 1, panel.y + panel.h - 1)) : null

  // ---------------------------------------------------------------- stamp
  let stamp = null
  if (flips) {
    const label = text.run('semibold', LABELS[q.state], 40, { letterSpacing: -0.4 })
    const sw = Math.ceil(label.advance + 44 + 30 + 28)
    const sh = 74
    const scx = Math.round(panel.x + panel.w - 40 - sw / 2)
    const scy = Math.round(linesTop + Math.min(fit, 6) * lh * 0.5 + 6)
    const x0 = scx - sw / 2
    const y0 = scy - sh / 2
    const deg = -7
    const icon = q.state === 'merged' ? checkCmds(x0 + 40, scy, 34) : crossCmds(x0 + 40, scy, 30)
    const layers = [
      { cmds: rrect(x0, y0, sw, sh, 14), color: c.panel, alpha: 0.94 },
      { cmds: [...rrect(x0, y0, sw, sh, 14), ...rrect(x0 + 3.5, y0 + 3.5, sw - 7, sh - 7, 10.5)], color: finalColor, evenodd: true },
      { cmds: [...rrect(x0 + 8, y0 + 8, sw - 16, sh - 16, 7), ...rrect(x0 + 9.5, y0 + 9.5, sw - 19, sh - 19, 5.5)], color: finalColor, evenodd: true, alpha: 0.6 },
      { cmds: icon, color: finalColor },
      { cmds: label.cmds(x0 + 68, scy + 14), color: finalColor },
    ].map((l) => ({ ...l, cmds: turn(l.cmds, deg, scx, scy) }))
    stamp = {
      cx: scx,
      cy: scy,
      sprite: ctx.sprite(layers, { margin: 4 }),
      ring: ctx.path(turn([...rrect(-sw / 2, -sh / 2, sw, sh, 14), ...rrect(-sw / 2 + 3, -sh / 2 + 3, sw - 6, sh - 6, 11)], deg, 0, 0)),
    }
  }
  const pulse = ctx.path([...rrect(-pillW / 2, -PILL_H / 2, pillW, PILL_H, PILL_H / 2), ...rrect(-pillW / 2 + 2.5, -PILL_H / 2 + 2.5, pillW - 5, PILL_H - 5, PILL_H / 2 - 2.5)])

  // ---------------------------------------------------------------- timing
  const T = {
    repo: 0.05,
    title: 0.4,
    pill: 0.8,
    meta: 0.9,
    panel: 1.05,
    head: 1.3,
    lines: 1.4,
  }
  const LINE_STEP = Math.min(0.16, 1.3 / Math.max(1, rows.length))
  const rand = prng(q.title)
  const lineAt = rows.map((_, i) => T.lines + i * LINE_STEP + rand() * 0.03)
  const lineDur = rows.map((r) => Math.min(0.32, 0.08 + r.cols * 0.005))
  const linesEnd = rows.length ? Math.max(...rows.map((_, i) => lineAt[i] + lineDur[i])) : T.lines
  const COUNT = { at: T.head + 0.05, d: Math.max(1.2, linesEnd - T.head) }
  T.flip = Math.max(2.9, linesEnd + 0.35)

  // ---------------------------------------------------------------- frames
  const counterText = (k, progress) => {
    const v = Math.round(counters[k].value * progress)
    return `${counters[k].prefix}${v}`
  }
  return {
    state(i) {
      const t = i / ctx.fps
      return {
        repo: [q4(tw(t, T.repo, 0.3, easeBack)), q4(tw(t, T.repo + 0.06, 0.55, easeOut5))],
        title: titles.map((_, j) => q4(tw(t, T.title + j * 0.09, 0.6, easeOut5))),
        pill: q4(tw(t, T.pill, 0.45)),
        meta: q4(tw(t, T.meta, 0.6, easeOut5)),
        panel: q4(tw(t, T.panel, 0.5, easeOut5)),
        head: q4(tw(t, T.head, 0.5, easeOut5)),
        count: q4(tw(t, COUNT.at, COUNT.d, (x) => 1 - (1 - x) ** 2)),
        lines: rows.map((_, j) => q4(tw(t, lineAt[j], lineDur[j], (x) => x))),
        flip: flips ? q4(tw(t, T.flip, 0.3)) : 0,
        stamp: flips ? q4(clamp01((t - T.flip) / 0.26)) : 0,
        ring: q4(clamp01((t - T.flip - 0.26) / 0.6)),
      }
    },
    draw(g, s) {
      const repoDone = s.repo[0] >= 1 && s.repo[1] >= 1
      const titleDone = s.title.map((v) => v >= 1)
      const pillDone = s.pill >= 1 && (!flips || s.flip >= 1)
      const metaDone = s.meta >= 1
      const panelDone = s.panel >= 1
      const headDone = s.head >= 1 && s.count >= 1
      const lineDone = s.lines.map((v) => v >= 1)
      const stampDone = !flips || s.stamp >= 1

      g.layer('bg', () => g.draw(bg))
      g.layer([repoDone, titleDone, pillDone, metaDone, panelDone, headDone, lineDone, stampDone].join(), () => {
        if (repoDone) {
          g.draw(marker)
          g.draw(repo)
        }
        titles.forEach((tl, j) => titleDone[j] && g.draw(tl.sprite))
        if (pillDone) g.draw(pillTo ?? pillFrom)
        if (metaDone) g.draw(meta)
        if (panelDone) {
          g.draw(shadow, { transform: [1, 0, 0, 1, 0, 12] })
          g.draw(panelSprite)
          if (headDone) drawHead(g, 1)
          rows.forEach((r, j) => lineDone[j] && g.draw(r.sprite))
          if (stampDone && dim) g.fill(dim, c.panel, { alpha: 0.5 })
          if (stampDone && stamp) g.draw(stamp.sprite)
        }
      })

      // Repo row: the marker pops, the text wipes on.
      if (!repoDone) {
        const [k, w] = s.repo
        if (k > 0) g.draw(marker, { opacity: Math.min(1, k * 2), transform: pose({ origin: [PAD_X + 7, REPO_Y], scale: k, rotate: 90 * (1 - k) }) })
        if (w > 0) g.draw(repo, { opacity: Math.min(1, w * 2), clip: [0, 0, repoX + (repoW + 8) * w, H] })
      }
      // Title lines rise into place by whole pixels.
      titles.forEach((tl, j) => {
        const v = s.title[j]
        if (v <= 0 || titleDone[j]) return
        g.draw(tl.sprite, { opacity: Math.min(1, v * 1.6), transform: [1, 0, 0, 1, 0, Math.round((1 - v) * 28)] })
      })
      // Pill: pops in, and for merged/closed later flips to its final state.
      if (!pillDone) {
        if (s.flip > 0 && pillTo) {
          g.draw(pillFrom, { opacity: 1 - s.flip })
          const k = 0.75 + 0.25 * easeBack(s.flip, 3)
          g.draw(pillTo, { opacity: Math.min(1, s.flip * 2), transform: pose({ origin: [pillCx, metaCy], scale: k }) })
        } else if (s.pill > 0) {
          const k = 0.6 + 0.4 * easeBack(s.pill, 2.4)
          g.draw(pillFrom, { opacity: Math.min(1, s.pill * 2), transform: s.pill < 1 ? pose({ origin: [pillCx, metaCy], scale: k }) : undefined })
        }
      }
      if (!metaDone && s.meta > 0) g.draw(meta, { opacity: s.meta, clip: [0, 0, metaX0 + (mx - metaX0 + 12) * s.meta, H] })

      // Panel slides up by whole pixels and fades in; then the header and the lines.
      if (!panelDone) {
        if (s.panel > 0) {
          const y = Math.round((1 - s.panel) * 24)
          g.draw(shadow, { opacity: s.panel, transform: [1, 0, 0, 1, 0, 12 + y] })
          g.draw(panelSprite, { opacity: s.panel, transform: [1, 0, 0, 1, 0, y] })
        }
        return
      }
      if (!headDone) drawHead(g, s.head)
      rows.forEach((r, j) => {
        const v = s.lines[j]
        if (v <= 0 || lineDone[j]) return
        // Types in: the clip advances a character cell at a time.
        const cols = Math.ceil(v * r.cols)
        g.draw(r.sprite, { clip: [panel.x, r.y, codeX + (cols - 2) * cw, r.y + lh] })
      })

      // Stamp: drops from large onto the diff, then a ring ripples out from it.
      if (stamp && !stampDone && s.stamp > 0) {
        if (dim) g.fill(dim, c.panel, { alpha: 0.5 * s.stamp })
        const k = 1 + 0.9 * (1 - s.stamp) ** 2
        g.draw(stamp.sprite, { opacity: Math.min(1, s.stamp * 2.5), transform: pose({ origin: [stamp.cx, stamp.cy], scale: k }) })
      }
      if (s.ring > 0 && s.ring < 1) {
        const k = 1 + 0.35 * easeOut3(s.ring)
        if (stamp) g.fill(stamp.ring, finalColor, { alpha: 0.5 * (1 - s.ring), evenodd: true, transform: [k, 0, 0, k, stamp.cx, stamp.cy] })
        else g.fill(pulse, stateColor[q.state], { alpha: 0.6 * (1 - s.ring), evenodd: true, transform: [k, 0, 0, k + 0.25 * easeOut3(s.ring), pillCx, metaCy] })
      }

      function drawHead(g, v) {
        if (fileSprite) g.draw(fileSprite, { opacity: v, clip: [0, 0, panel.x + 20 + (fileRun.advance + 8) * v, H] })
        if (filesSprite) g.draw(filesSprite, { opacity: v })
        // Counters, right-aligned, drawn from digit paths.
        counters.forEach((ct, k) => {
          const str = counterText(k, s.count)
          const n = [...str].length
          ;[...str].forEach((ch, j) => g.fill(glyph(ch), ct.color, { alpha: v, transform: [1, 0, 0, 1, Math.round((ct.x1 - (n - j) * cw) * 4) / 4, headBase] }))
        })
        squares.forEach((sq, j) => g.fill(sq.path, s.count * 5 > j + 0.5 ? sq.color : c.rule, { alpha: v }))
      }
    },
  }
}
