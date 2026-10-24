// Shared pieces for the showcase scenarios (kinetic, metric, terminal, launch): themes, colour
// maths, a seeded PRNG and the static background bitmap.
//
// The background is a full-frame bitmap sprite, painted once in setup. Besides being layer 0 it
// doubles as a mask: drawing it again clipped to a rectangle restores the background there, which
// is how text "rises out of a line" without a real mask in the compositor.

export const W = 1200
export const H = 630

export const THEMES = {
  dark: { bg: 0x0a0a0b, fg: 0xf5f5f4, muted: 0x8a8a8e, faint: 0x2a2a2e, dot: 0xffffff, dotAlpha: 0.055, glow: 0.16 },
  light: { bg: 0xf6f5f1, fg: 0x111113, muted: 0x6b6b70, faint: 0xdedcd6, dot: 0x000000, dotAlpha: 0.07, glow: 0.12 },
}

export const hex = (c) => (typeof c === 'number' ? c : parseInt(c.replace('#', ''), 16))
const ch = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
const pack = (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)

/** Linear mix of two 0xrrggbb colours. */
export function mix(a, b, t) {
  const [r0, g0, b0] = ch(hex(a))
  const [r1, g1, b1] = ch(hex(b))
  return pack(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t)
}

/** WCAG relative luminance. */
export function luminance(c) {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = ch(hex(c))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** Text colour that reads on `bg`: near-black or near-white. */
export const onColor = (bg) => (luminance(bg) > 0.42 ? 0x0a0a0b : 0xffffff)

/** A small deterministic PRNG (mulberry32) seeded from a string. */
export function prng(seed) {
  let h = 2166136261
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The static background: flat theme colour, a soft accent glow from `glowAt` (frame px), a faint
 * dot grid and ordered dither so the glow does not band once it is H.264.
 */
export function background(ctx, theme, accent, { glowAt = [W * 0.92, -40], radius = 760, dots = 24, dotFade = true } = {}) {
  // Painting is ~756k iterations of float math, and it was the largest source of garbage in
  // production profiles, so each isolate keeps the last few backdrops and copies them in.
  const key = JSON.stringify([theme.bg, theme.dot, theme.glow, theme.dotAlpha, accent, glowAt, radius, dots, dotFade])
  const hit = BACKDROPS.get(key)
  if (hit) {
    BACKDROPS.delete(key)
    BACKDROPS.set(key, hit)
    return ctx.bitmap(0, 0, W, H, (px) => px.set(hit))
  }
  const sprite = paintBackground(ctx, theme, accent, glowAt, radius, dots, dotFade, (px) => {
    BACKDROPS.set(key, px.slice())
    if (BACKDROPS.size > BACKDROP_CACHE) BACKDROPS.delete(BACKDROPS.keys().next().value)
  })
  return sprite
}

const BACKDROP_CACHE = 4 // about 3 MB each
const BACKDROPS = new Map()

function paintBackground(ctx, theme, accent, glowAt, radius, dots, dotFade, done) {
  const bg = ch(theme.bg)
  const ac = ch(hex(accent))
  const dt = ch(theme.dot)
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  return ctx.bitmap(0, 0, W, H, (px) => {
    const [gx, gy] = glowAt
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - gx, y - gy) / radius
        const glow = d >= 1 ? 0 : theme.glow * (1 - d) ** 2.2
        let r = bg[0] + (ac[0] - bg[0]) * glow
        let g = bg[1] + (ac[1] - bg[1]) * glow
        let b = bg[2] + (ac[2] - bg[2]) * glow
        if (dots) {
          const mx = x % dots
          const my = y % dots
          if ((mx === 0 || mx === 1) && (my === 0 || my === 1)) {
            // Fades towards the bottom-left so the grid frames the glow instead of the type.
            const fade = dotFade ? Math.max(0, 1 - Math.hypot((x - gx) / 1.25, y - gy) / 1250) : 1
            const a = theme.dotAlpha * (0.35 + 0.65 * fade)
            r += (dt[0] - r) * a
            g += (dt[1] - g) * a
            b += (dt[2] - b) * a
          }
        }
        const n = (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 1.2
        const o = (y * W + x) * 4
        px[o] = Math.max(0, Math.min(255, Math.round(r + n)))
        px[o + 1] = Math.max(0, Math.min(255, Math.round(g + n)))
        px[o + 2] = Math.max(0, Math.min(255, Math.round(b + n)))
        px[o + 3] = 255
      }
    }
    done(px)
  })
}

/** Affine transform: rotate by `deg` and scale by `k` around local (0, 0), then move to (x, y). */
export function affine(x, y, deg = 0, k = 1) {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r) * k
  const s = Math.sin(r) * k
  return [c, s, -s, c, x, y]
}

/** Rounds a number for frame state, so float noise does not defeat frame skipping. */
export const q4 = (n) => Math.round(n * 1e4) / 1e4
