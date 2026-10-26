// terminal: a scripted shell session, for CLI and SDK launches. A terminal window settles in,
// then each command types out after the prompt with a block cursor, a spinner runs briefly, and
// the output prints in. Status lines spin in their gutter and resolve to a drawn check or cross.
// The session ends on a fresh prompt with a blinking cursor, which is also the poster.
//
// `lines` is the script, one flat array in the order it plays: '$ cmd' is a command, '+ text' a
// success line, '! text' a failure, '> text' muted, anything else plain ('\' escapes a leading
// marker). *Asterisks* put words in the accent. One flat array of strings reads like the
// transcript it draws and stays short in a URL; `steps` ([{ cmd, out: [...] }]) is the same
// thing structured, for code that builds the params.
//
// The first 36 frames (0.6 s, the window settling) depend only on theme, accent, title and prompt.
//
// Every row is one sprite, rasterized once at the origin and moved into place by whole pixels
// (scrolling, when the script is longer than the window, is whole-pixel too). Typing is a clip
// that widens one character cell at a time. Rows that have finished animating are drawn in a
// cached layer keyed by the scroll offset and the set of settled rows; only the row in progress,
// the spinner and the cursor are drawn live.
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, transform } from '../gfx.js'
import { W, H, background, prng, q4 } from './showcase-kit.js'
import { MONO_FONTS, roles, windowLayers, marks, clipSegments, monoLayers, monoWidth, checkCmds, crossCmds, spinnerDots, spinnerAlpha } from './code-kit.js'

const SIZE = 28
const LH = 44
const BAR = 52
const PAD_Y = 22
const MIN_ROWS = 5
const MAX_ROWS = 10

/**
 * The window, sized to the script (between MIN_ROWS and MAX_ROWS rows; longer scripts scroll)
 * and centred. Only the row count matters, so it can be part of the prefix key.
 */
function frame(rows) {
  const n = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows))
  const h = BAR + 2 * PAD_Y + n * LH
  const win = { x: 72, y: Math.round((H - h) / 2), w: W - 144, h, r: 14 }
  return {
    win,
    rows: n,
    bodyX: win.x + 30,
    bodyTop: win.y + BAR + PAD_Y,
    // Rows scroll out under the top padding, so a half row never shows under the title bar.
    clip: [win.x + 1, win.y + BAR + PAD_Y - 6, win.x + win.w - 1, win.y + win.h - 1],
  }
}

const FPS_SPIN = 14
const SPIN_N = 8

// Timing (seconds). The script is compressed to finish by END, leaving the rest as a hold.
const INTRO = 0.55
const START = 0.6
const END = 5.6
const FADE = 0.08
const POP = 0.32
const SCROLL = 0.12

const step = p.object({ cmd: p.string({ max: 160, default: '' }), out: p.array(p.string({ max: 160 }), { max: 12, default: [] }) })

export const terminal = defineScenario({
  id: 'terminal',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  fonts: MONO_FONTS,
  params: p.object({
    title: p.string({ max: 48, default: '~/my-agent' }),
    lines: p.array(p.string({ max: 160 }), {
      min: 1,
      max: 24,
      default: [
        '$ npm create agent@latest my-agent',
        '+ Scaffolded *my-agent* from the starter template',
        '+ Installed 42 packages in 3.1s',
        '$ cd my-agent && npm run deploy',
        '> Bundling 3 tools and 1 prompt',
        '+ Deployed to *https://my-agent.example.com*',
      ],
    }),
    steps: p.array(step, { max: 8, optional: true }),
    prompt: p.string({ max: 12, default: '$' }),
    accent: p.color({ default: '#22d3ee' }),
    theme: p.enum(['dark', 'light'], { default: 'dark' }),
  }),
  prefix: { frames: 36, key: (q) => `${q.theme}|${q.accent}|${q.title}|${q.prompt}|${frame(script(q).length + 1).rows}` },
  meta: (q) => {
    const rows = script(q)
    const cmds = rows.filter((r) => r.kind === 'cmd').map((r) => r.text)
    const last = [...rows].reverse().find((r) => r.kind === 'out')
    return { title: cmds.length ? cmds.join(' && ') : q.title || 'Terminal', description: last ? last.text.replace(/\*/g, '') : undefined }
  },
  setup,
})

/** The script as rows: { kind: 'cmd', text } or { kind: 'out', text, status: 'ok' | 'err' | 'muted' | null }. */
function script(q) {
  const lines = q.steps?.length ? q.steps.flatMap((s) => [...(s.cmd ? [`$ ${s.cmd}`] : []), ...s.out]).slice(0, 24) : q.lines
  return lines.map((line) => {
    if (line === '$' || line.startsWith('$ ')) return { kind: 'cmd', text: line.slice(2).trim() }
    const m = line.match(/^([+!>])(?: (.*))?$/)
    if (m) return { kind: 'out', text: m[2] ?? '', status: { '+': 'ok', '!': 'err', '>': 'muted' }[m[1]] }
    return { kind: 'out', text: line.replace(/^\\(?=[$+!>])/, ''), status: null }
  })
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeOut3 = (t) => 1 - (1 - t) ** 3
const easeBack = (t, s = 2.6) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2

/**
 * Times for every row, in seconds: when it shows, when its text appears, typing per character,
 * when a command is entered, when a status resolves, and when it is settled for good.
 */
function schedule(rows) {
  const out = []
  let t = START
  let prev = null
  for (const row of rows) {
    const r = { ...row }
    if (row.kind === 'cmd') {
      if (prev) t += prev.kind === 'cmd' ? 0.1 : 0.18
      r.show = t
      const rand = prng(row.text)
      let c = t + 0.22
      r.chars = [...row.text].map((ch, i) => {
        c += 0.034 * (0.55 + 0.9 * rand()) + (ch === ' ' ? 0.025 : 0) + (i === 0 ? 0.03 : 0)
        return c
      })
      r.enter = c + 0.2
      t = r.enter + 0.08
    } else {
      if (prev?.kind === 'out') t += prev.status === 'ok' || prev.status === 'err' ? 0.06 : 0.07
      r.show = t
      const first = !prev || prev.kind === 'cmd'
      if (r.status === 'ok' || r.status === 'err') {
        r.text_at = t
        r.resolve = t + (first ? 0.5 : 0.32)
        t = r.resolve
      } else {
        r.text_at = first ? t + 0.42 : t
        t = r.text_at
      }
    }
    out.push(r)
    prev = r
  }
  // The final prompt, idle.
  out.push({ kind: 'prompt', text: '', show: t + (prev?.kind === 'cmd' ? 0.02 : 0.16) })

  const last = out[out.length - 1].show
  if (last > END) {
    const k = (END - START) / (last - START)
    const f = (v) => START + (v - START) * k
    for (const r of out) {
      for (const key of ['show', 'text_at', 'resolve', 'enter']) if (r[key] !== undefined) r[key] = f(r[key])
      if (r.chars) r.chars = r.chars.map(f)
    }
  }
  for (const r of out) {
    if (r.kind === 'cmd') r.settle = r.enter
    else if (r.kind === 'prompt') r.settle = r.show
    else r.settle = r.resolve !== undefined ? r.resolve + POP : r.text_at + FADE
  }
  return out
}

function setup(ctx, q) {
  const { text } = ctx
  const c = roles(q.theme, q.accent)
  const bg = background(ctx, c, c.accent, { glowAt: [W * 0.5, H + 120], radius: 900 })
  const cw = monoWidth(text, SIZE)
  const plan = schedule(script(q))
  const { win, rows: visible, bodyX, bodyTop, clip } = frame(plan.length)
  const maxCols = Math.floor((win.x + win.w - 30 - bodyX) / cw)
  const base = text.baselineIn('mono', SIZE, LH)

  // ---------------------------------------------------------------- window
  const winLayers = windowLayers(c, { ...win, bar: BAR })
  const titleRun = q.title ? text.fit('semibold', q.title, 18, win.w - 240) : null
  if (titleRun) winLayers.push({ cmds: titleRun.cmds(Math.round(win.x + (win.w - titleRun.advance) / 2), win.y + text.baselineIn('semibold', 18, BAR)), color: c.muted })
  const winSprite = ctx.sprite(winLayers, { margin: 2 })
  const shadow = ctx.shadow(winSprite, { blur: 36, opacity: c.dark ? 0.6 : 0.16, spread: 0 })

  // ---------------------------------------------------------------- rows
  const prompt = q.prompt ? [...q.prompt].slice(0, 12).join('') : ''
  const promptCols = prompt ? [...prompt].length + 1 : 0
  const textX = bodyX + promptCols * cw
  const rows = plan.map((r, i) => {
    const row = { ...r, i, top: bodyTop + i * LH }
    const colorOf = (s) => (s.em ? c.accentInk : r.status === 'muted' ? c.muted : c.fg)
    const layers = []
    if (r.kind === 'cmd' || r.kind === 'prompt') {
      if (prompt) layers.push({ cmds: text.run('monoBold', prompt, SIZE).cmds(bodyX, base), color: c.accentInk })
      const segs = clipSegments(marks(r.text), maxCols - promptCols)
      layers.push(...monoLayers(text, segs, textX, base, SIZE, colorOf, 'monoBold'))
      row.cols = segs.reduce((n, s) => n + [...s.text].length, 0)
      // Typing reveals columns; a long command that was cut types its visible part.
      if (row.chars) row.chars = row.chars.slice(0, row.cols)
    } else {
      const gutter = r.status ? 2 : 0
      const segs = clipSegments(marks(r.text), maxCols - gutter)
      layers.push(...monoLayers(text, segs, bodyX + gutter * cw, base, SIZE, colorOf))
      if (r.status === 'ok') row.icon = { cmds: checkCmds(0, 0, SIZE * 0.74), color: c.ok }
      if (r.status === 'err') row.icon = { cmds: crossCmds(0, 0, SIZE * 0.66), color: c.err }
      if (row.icon) {
        row.iconAt = [Math.round(bodyX + cw * 0.6), Math.round(LH / 2 - 1)]
        row.iconPath = ctx.path(row.icon.cmds)
        layers.push({ cmds: transform(row.icon.cmds, 1, ...row.iconAt), color: row.icon.color })
      }
    }
    row.sprite = ctx.sprite(layers, { margin: 3 })
    return row
  })
  const spinDots = spinnerDots(SPIN_N, 7.5, 3.6).map((cmds) => ctx.path(cmds))
  const spinAt = [Math.round(bodyX + cw * 0.6), Math.round(LH / 2 - 1)]
  const cursorPath = ctx.path(rrect(0, 0, Math.round(cw) - 1, Math.round(SIZE * 1.18), 2))
  const cursorY = Math.round(LH / 2 - SIZE * 0.59)
  const lastT = (ctx.frames - 1) / ctx.fps

  // ---------------------------------------------------------------- frames
  const rowY = (r, scroll) => r.top - scroll
  return {
    state(i) {
      const t = i / ctx.fps
      const intro = easeOut3(clamp01(t / INTRO))
      let scroll = 0
      for (const r of rows) if (r.i >= visible) scroll += LH * easeOut3(clamp01((t - r.show) / SCROLL))
      scroll = Math.round(scroll)
      const live = []
      let bits = ''
      let cursor = null
      for (const r of rows) {
        const shown = t >= r.show
        const settled = t >= r.settle
        bits += settled ? '1' : '0'
        if (r.kind === 'cmd' && shown && t < r.enter) {
          const typed = r.chars.filter((ct) => ct <= t).length
          live.push([r.i, typed])
          cursor = [r.i, typed, 1]
        } else if (r.kind === 'prompt' && shown) {
          // Blinks on a 1 s cycle anchored to the last frame, so the poster shows the cursor.
          cursor = [r.i, 0, (lastT - t) % 1 < 0.55 ? 1 : 0]
        } else if (r.kind === 'out' && shown && !settled) {
          const spinning = r.resolve !== undefined ? t < r.resolve : t < r.text_at
          live.push([
            r.i,
            t >= r.text_at ? q4(clamp01((t - r.text_at) / FADE)) : 0,
            spinning ? Math.floor(t * FPS_SPIN) % SPIN_N : -1,
            r.resolve !== undefined && t >= r.resolve ? q4(clamp01((t - r.resolve) / POP)) : 0,
          ])
        }
      }
      return { win: [Math.round((1 - intro) * 22), q4(intro)], scroll, bits, live, cursor }
    },
    draw(g, s) {
      const [winY, winO] = s.win
      g.layer('bg', () => g.draw(bg))
      if (winO < 1) {
        g.draw(shadow, { opacity: winO, transform: [1, 0, 0, 1, 0, winY + 16] })
        g.draw(winSprite, { opacity: winO, transform: [1, 0, 0, 1, 0, winY] })
        return
      }
      g.layer(`${s.scroll}|${s.bits}`, () => {
        g.draw(shadow, { transform: [1, 0, 0, 1, 0, 16] })
        g.draw(winSprite)
        rows.forEach((r, i) => {
          if (s.bits[i] !== '1') return
          const y = rowY(r, s.scroll)
          if (y + LH > clip[1] && y < clip[3]) g.draw(r.sprite, { clip: clip, transform: [1, 0, 0, 1, 0, y] })
        })
      })

      for (const [i, a, spin, pop] of s.live) {
        const r = rows[i]
        const y = rowY(r, s.scroll)
        if (r.kind === 'cmd') {
          g.draw(r.sprite, { clip: [clip[0], Math.max(clip[1], y), Math.round(textX + a * cw), Math.min(clip[3], y + LH)], transform: [1, 0, 0, 1, 0, y] })
          continue
        }
        if (spin >= 0) spinDots.forEach((d, j) => g.fill(d, c.accentInk, { alpha: spinnerAlpha(j, spin, SPIN_N), transform: [1, 0, 0, 1, spinAt[0], y + spinAt[1]] }))
        if (a <= 0) continue
        if (!r.icon) {
          g.draw(r.sprite, { opacity: a, clip: clip, transform: [1, 0, 0, 1, 0, y] })
          continue
        }
        // Status rows: the text without its icon (clipped past the gutter), then the icon popping.
        g.draw(r.sprite, { opacity: a, clip: [Math.round(bodyX + cw * 1.5), clip[1], clip[2], clip[3]], transform: [1, 0, 0, 1, 0, y] })
        if (pop > 0) {
          const k = 0.35 + 0.65 * easeBack(pop)
          g.fill(r.iconPath, r.icon.color, { alpha: Math.min(1, pop * 3), transform: [k, 0, 0, k, r.iconAt[0], y + r.iconAt[1]] })
        }
      }

      if (s.cursor && s.cursor[2]) {
        const r = rows[s.cursor[0]]
        const y = rowY(r, s.scroll)
        g.fill(cursorPath, c.accentInk, { alpha: 0.85, transform: [1, 0, 0, 1, Math.round(textX + s.cursor[1] * cw), y + cursorY] })
      }
    },
  }
}
