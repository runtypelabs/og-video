// Shared pieces for the code-flavoured scenarios (terminal, pr): colour roles, window chrome,
// monospace lines with light markup, and vector status glyphs.
//
// The built-in JetBrains Mono is a Latin subset: no check marks, box drawing, arrows or braille.
// So checks, crosses, spinners and window dots are drawn here as filled paths. There is no stroke
// primitive either: polylines become quads plus round caps, all wound the same way so overlaps
// stay filled under the nonzero rule.
import { rrect, ellipse } from '../gfx.js'
import { THEMES, mix, hex, luminance } from './showcase-kit.js'

/** Scenario `fonts` for the built-in monospace faces, under the names used below. */
export const MONO_FONTS = { mono: 'jetbrains-mono', monoBold: 'jetbrains-mono-semibold' }

/** Terminals do not join `->` or `=>`; neither do we. */
export const MONO_FEATURES = { liga: false, calt: false, clig: false, dlig: false }

/**
 * Colour roles for a theme and accent: the showcase theme plus window surfaces, status colours
 * and an accent that still reads as text (light themes darken a pale accent).
 */
export function roles(themeName, accentColor) {
  const theme = THEMES[themeName]
  const accent = hex(accentColor)
  const dark = themeName === 'dark'
  const accentInk = !dark && luminance(accent) > 0.3 ? mix(accent, 0x000000, 0.35) : accent
  return {
    ...theme,
    dark,
    accent,
    accentInk,
    panel: dark ? mix(theme.bg, 0xffffff, 0.035) : 0xffffff,
    bar: dark ? mix(theme.bg, 0xffffff, 0.065) : mix(0xffffff, theme.bg, 0.6),
    edge: dark ? mix(theme.bg, 0xffffff, 0.13) : mix(theme.bg, 0x000000, 0.11),
    rule: dark ? mix(theme.bg, 0xffffff, 0.09) : mix(theme.bg, 0x000000, 0.07),
    ok: dark ? 0x4ade80 : 0x16a34a,
    err: dark ? 0xf87171 : 0xdc2626,
    warn: dark ? 0xfbbf24 : 0xb45309,
    merged: dark ? 0xa78bfa : 0x7c3aed,
    // The classic window controls, a touch quieter on dark.
    lights: dark ? [0xff5f57, 0xfebc2e, 0x28c840] : [0xff5f57, 0xfdbc2c, 0x27c93f],
  }
}

/**
 * Sprite layers for a window or panel: a 1px edge, the body, and optionally a title bar of
 * `bar` px with a rule under it and three window dots.
 */
export function windowLayers(c, { x, y, w, h, r = 14, bar = 0, dots = true }) {
  const layers = [
    { cmds: rrect(x, y, w, h, r), color: c.edge },
    { cmds: rrect(x + 1, y + 1, w - 2, h - 2, r - 1), color: c.panel },
  ]
  if (bar) {
    layers.push({ cmds: topRounded(x + 1, y + 1, w - 2, bar - 1, r - 1), color: c.bar })
    layers.push({ cmds: [0, x + 1, y + bar - 1, 1, x + w - 1, y + bar - 1, 1, x + w - 1, y + bar, 1, x + 1, y + bar, 4], color: c.rule })
    if (dots) c.lights.forEach((color, i) => layers.push({ cmds: ellipse(x + 26 + i * 22, y + bar / 2, 6.5), color }))
  }
  return layers
}

/** A rectangle with only its top corners rounded. */
function topRounded(x, y, w, h, r) {
  const k = 0.5522847498 * r
  return [
    0, x, y + h,
    1, x, y + r,
    3, x, y + r - k, x + r - k, y, x + r, y,
    1, x + w - r, y,
    3, x + w - r + k, y, x + w, y + r - k, x + w, y + r,
    1, x + w, y + h,
    4,
  ]
}

/**
 * Splits a line into coloured segments. `*word*` toggles the accent. Returns
 * [{ text, em }] covering the line with the asterisks removed.
 */
export function marks(src) {
  const out = []
  let on = false
  let cur = ''
  for (const ch of src) {
    if (ch === '*') {
      if (cur) out.push({ text: cur, em: on })
      cur = ''
      on = !on
    } else cur += ch
  }
  if (cur) out.push({ text: cur, em: on })
  return out
}

/** Cuts segments to `max` characters, the last one shown replaced by an ellipsis. */
export function clipSegments(segs, max) {
  const total = segs.reduce((n, s) => n + [...s.text].length, 0)
  if (total <= max) return segs
  const out = []
  let room = Math.max(0, max - 1)
  for (const s of segs) {
    if (room <= 0) break
    const chars = [...s.text]
    out.push({ ...s, text: chars.slice(0, room).join('') })
    room -= chars.length
  }
  const last = out[out.length - 1]
  if (last) last.text = `${last.text.trimEnd()}…`
  else out.push({ text: '…', em: false })
  return out
}

/**
 * Sprite layers for monospace segments starting at (x, baseline). Every character is `cw` wide,
 * so segment n starts at x + cw * (characters before it), and a typing reveal is a clip at
 * x + cw * typed.
 */
export function monoLayers(text, segs, x, baseline, size, colorOf, font = 'mono') {
  const layers = []
  let col = 0
  for (const s of segs) {
    if (s.text.trim()) layers.push({ cmds: text.run(font, s.text, size, { features: MONO_FEATURES }).cmds(x + col * monoWidth(text, size, font), baseline), color: colorOf(s) })
    col += [...s.text].length
  }
  return layers
}

/** The advance of one monospace character. */
export const monoWidth = (text, size, font = 'mono') => text.run(font, 'M', size, { features: MONO_FEATURES }).advance

// ---------------------------------------------------------------- vector glyphs

/** A polyline as filled quads with round joins and caps, `w` wide. */
export function polyline(pts, w) {
  const h = w / 2
  const out = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[i + 1]
    const l = Math.hypot(bx - ax, by - ay) || 1
    const nx = (-(by - ay) / l) * h
    const ny = ((bx - ax) / l) * h
    const q = [
      [ax + nx, ay + ny],
      [bx + nx, by + ny],
      [bx - nx, by - ny],
      [ax - nx, ay - ny],
    ]
    if (area(q) < 0) q.reverse()
    out.push(0, ...q[0], 1, ...q[1], 1, ...q[2], 1, ...q[3], 4)
  }
  for (const [x, y] of pts) out.push(...ellipse(x, y, h))
  return out
}

/** Shoelace area; positive matches gfx ellipse()'s winding. */
function area(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    a += x0 * y1 - x1 * y0
  }
  return a
}

/** A check mark centred on (cx, cy), `s` px across. */
export const checkCmds = (cx, cy, s, w = s * 0.17) =>
  polyline(
    [
      [cx - s * 0.36, cy + s * 0.02],
      [cx - s * 0.1, cy + s * 0.28],
      [cx + s * 0.38, cy - s * 0.26],
    ],
    w,
  )

/** A cross centred on (cx, cy), `s` px across. */
export const crossCmds = (cx, cy, s, w = s * 0.17) => {
  const d = s * 0.3
  return [
    ...polyline(
      [
        [cx - d, cy - d],
        [cx + d, cy + d],
      ],
      w,
    ),
    ...polyline(
      [
        [cx + d, cy - d],
        [cx - d, cy + d],
      ],
      w,
    ),
  ]
}

/** A ring (evenodd: outer and inner circles). */
export const ringCmds = (cx, cy, r0, r1) => [...ellipse(cx, cy, r1), ...ellipse(cx, cy, r0)]

/** The dots of a spinner around (0, 0): `n` dots on radius `r`, each `d` across. */
export const spinnerDots = (n, r, d) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return ellipse(Math.cos(a) * r, Math.sin(a) * r, d / 2)
  })

/** Alpha of spinner dot `i` at `phase` (0..n-1): a bright head with a fading tail. */
export const spinnerAlpha = (i, phase, n) => {
  const behind = (phase - i + n) % n
  return behind < 4 ? 1 - behind * 0.22 : 0.16
}

/** A deterministic string hash, for avatar colours and typing rhythm. */
export function hash(s) {
  let h = 2166136261
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
