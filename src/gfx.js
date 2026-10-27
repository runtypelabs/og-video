// The drawing API scenes use, over the ogfx compositor (crates/ogfx).
//
// A scene rasterizes its shapes once in setup (paths and sprites), then describes each frame as
// a stack of cached layers plus a few live overlays. The runner here turns that into the
// compositor's cheap operations: a layer whose key has not changed is restored with one memcpy,
// overlays are blended on top, and every 16x16 block they did not touch is reported unchanged so
// the encoder can skip it.

/** '#rgb', '#rrggbb', 'rgb(r, g, b)' or 0xrrggbb -> 0xrrggbb. */
export function rgb(color) {
  if (typeof color === 'number') return color
  if (color[0] === '#') {
    const h = color.length === 4 ? [...color.slice(1)].map((c) => c + c).join('') : color.slice(1, 7)
    return parseInt(h, 16)
  }
  const m = color.match(/[\d.]+/g).map(Number)
  return (Math.round(m[0]) << 16) | (Math.round(m[1]) << 8) | Math.round(m[2])
}

// ---------------------------------------------------------------- shapes (command buffers)
// 0 x y = move, 1 x y = line, 2 x1 y1 x y = quad, 3 x1 y1 x2 y2 x y = cubic, 4 = close.

const ARGS = [2, 2, 4, 6, 0]

/** A rounded rectangle. */
export function rrect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  const c = r * 0.5522847498
  return [
    0, x + r, y,
    1, x + w - r, y,
    3, x + w - r + c, y, x + w, y + r - c, x + w, y + r,
    1, x + w, y + h - r,
    3, x + w, y + h - r + c, x + w - r + c, y + h, x + w - r, y + h,
    1, x + r, y + h,
    3, x + r - c, y + h, x, y + h - r + c, x, y + h - r,
    1, x, y + r,
    3, x, y + r - c, x + r - c, y, x + r, y,
    4,
  ]
}

/** An axis-aligned rectangle from its corners. */
export const rect = (x0, y0, x1, y1) => [0, x0, y0, 1, x1, y0, 1, x1, y1, 1, x0, y1, 4]

/** An ellipse. */
export function ellipse(cx, cy, rx, ry = rx) {
  const k = 0.5522847498
  return [
    0, cx + rx, cy,
    3, cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry,
    3, cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy,
    3, cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry,
    3, cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy,
    4,
  ]
}

/** Applies x' = x * k + tx, y' = y * k + ty to a command buffer. */
export function transform(cmds, k, tx = 0, ty = 0) {
  const out = []
  for (let i = 0; i < cmds.length; ) {
    const n = ARGS[cmds[i]]
    out.push(cmds[i])
    for (let j = 0; j < n; j += 2) out.push(cmds[i + 1 + j] * k + tx, cmds[i + 2 + j] * k + ty)
    i += 1 + n
  }
  return out
}

/** Bounds of a command buffer (control points included, so it is conservative). */
export function bounds(cmds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < cmds.length; i += 1 + ARGS[cmds[i]]) {
    for (let j = i + 1; j < i + 1 + ARGS[cmds[i]]; j += 2) {
      x0 = Math.min(x0, cmds[j]); x1 = Math.max(x1, cmds[j])
      y0 = Math.min(y0, cmds[j + 1]); y1 = Math.max(y1, cmds[j + 1])
    }
  }
  return { x0, y0, x1, y1 }
}

// ---------------------------------------------------------------- transforms and paints

/** The affine product m * n: apply n first, then m. */
export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/**
 * A transform that rotates by `rotate` degrees and scales by `scale` around `origin` (frame px),
 * then moves by (x, y). For `g.draw(sprite, { transform })`: the origin is usually the sprite's
 * centre in frame coordinates.
 */
export function pose({ x = 0, y = 0, rotate = 0, scale = 1, origin = [0, 0] } = {}) {
  const r = (rotate * Math.PI) / 180
  const sx = Array.isArray(scale) ? scale[0] : scale
  const sy = Array.isArray(scale) ? scale[1] : scale
  const c = Math.cos(r)
  const s = Math.sin(r)
  const [ox, oy] = origin
  const a = c * sx, b = s * sx, cc = -s * sy, d = c * sy
  return [a, b, cc, d, ox + x - (a * ox + cc * oy), oy + y - (b * ox + d * oy)]
}

/** A linear gradient from (x0, y0) to (x1, y1); stops are [offset, color, alpha?]. */
export const linear = (x0, y0, x1, y1, stops) => ({ type: 'linear', from: [x0, y0], to: [x1, y1], stops })

/** A radial gradient centred on (cx, cy) with radius r; stops are [offset, color, alpha?]. */
export const radial = (cx, cy, r, stops) => ({ type: 'radial', center: [cx, cy], radius: r, stops })

const BLEND = { normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4 }

// ---------------------------------------------------------------- frame keys

/**
 * A stable string for comparing frame states: numbers rounded to 1e-4, keys starting with `_`
 * skipped (GSAP caches itself on its targets as `_gsap`), Maps and Sets as arrays.
 */
export function stateKey(value) {
  return JSON.stringify(value, (k, v) => {
    if (k[0] === '_') return undefined
    if (typeof v === 'number') return Math.round(v * 1e4) / 1e4
    if (v instanceof Map) return [...v.entries()]
    if (v instanceof Set) return [...v]
    return v
  })
}

// ---------------------------------------------------------------- compositor

export async function createCompositor(module) {
  const { exports: x } = await WebAssembly.instantiate(module, {})
  // Survives across renders on this instance: the grid effect is expensive to set up and is
  // usually the same from one render of a scenario to the next.
  return { x, grid: { key: null, bakedR: -1 } }
}

/**
 * The output size of a `width` x `height` scene rendered at about `scale`, and the exact scale
 * used: the width is rounded to a multiple of 16 and the height to an even number, as the
 * encoder needs. 1200x630 at 0.8 is exactly 960x504.
 */
export function scaledSize({ width, height }, scale = 1) {
  const w = Math.max(16, Math.round((width * scale) / 16) * 16)
  const k = w / width
  return { width: w, height: Math.max(2, Math.round((height * k) / 2) * 2), k }
}

/**
 * Prepares one render: runs the scene's setup and returns the frame-by-frame interface the
 * encoder drives.
 *
 * With `scale` below 1 the frame is composited natively at the smaller size: scenes keep drawing
 * in the scenario's coordinates (ctx.width and g.width stay the scenario's), and every coordinate,
 * radius and blur is scaled on its way into the compositor. That is cheaper than compositing at
 * full size and resampling, and sharper, since outlines are rasterized at the output resolution.
 * @param {{ x: any, grid: any }} compositor
 * @param {any} text from createTextEngine
 * @param {{ width: number, height: number, fps: number, frames: number }} video
 * @param {(ctx: any) => any} setup
 * @param {{ images?: Map<string, Uint8Array | null>, decoded?: { get(k: string): any, set(k: string, v: any): void } }} [assets]
 *   Fetched image bytes by URL (null when the fetch failed) and a cache of decoded sprites.
 * @param {number} [scale] output pixels per scene pixel
 */
export function createRun(compositor, text, video, setup, assets = {}, scale = 1) {
  const { x } = compositor
  const { fps } = video
  const { width: W, height: H, k } = scaledSize(video, scale)
  if (x.init(W, H) !== 0) throw new Error(`unsupported frame size ${W}x${H}: the width must be a multiple of 16 and the height even`)
  x.reset()
  const missing = new Set()
  // Scene coordinates -> output pixels. A transform t maps scene to scene, so the compositor gets
  // S t S^-1: the same linear part, the translation scaled.
  const sc = (v) => v * k
  const scaleT = (t) => (k === 1 ? t : [t[0], t[1], t[2], t[3], t[4] * k, t[5] * k])
  // A sprite moved by whole scene pixels is a plain copy at scale 1. Keep it one (sharp, cheap
  // and unchanged blocks stay unchanged) by moving it by whole output pixels too; fractional
  // moves are animation and stay sub-pixel.
  const snapT = (t) =>
    k !== 1 && t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && Number.isInteger(t[4]) && Number.isInteger(t[5])
      ? [1, 0, 0, 1, Math.round(t[4] * k), Math.round(t[5] * k)]
      : scaleT(t)
  const scaleCmds = (cmds) => (k === 1 ? cmds : transform(cmds, k))

  /** Copies `data` into wasm memory for the duration of `fn(ptr)`. */
  const withBytes = (data, fn) => {
    const p = x.alloc(data.byteLength)
    new Uint8Array(x.memory.buffer, p, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    try {
      return fn(p)
    } finally {
      x.dealloc(p, data.byteLength)
    }
  }

  const path = (cmds) => {
    if (!cmds.length) return null
    cmds = scaleCmds(cmds)
    const id = withBytes(new Float32Array(cmds), (p) => x.path_new(p, cmds.length))
    return id < 0 ? null : { id }
  }

  // x, y, w, h are in scene coordinates (what scenes lay out with); px is the sprite's pixel box.
  const spriteOf = (id) => {
    const px = { x: x.sprite_x(id), y: x.sprite_y(id), w: x.sprite_w(id), h: x.sprite_h(id) }
    return k === 1 ? { id, ...px, px } : { id, x: px.x / k, y: px.y / k, w: px.w / k, h: px.h / k, px }
  }
  const pixels = (sp) => new Uint8Array(x.memory.buffer, x.sprite_ptr(sp.id), sp.px.w * sp.px.h * 4)

  // The argument block shared by draw_ex / fill_ex / sprite_fill_ex (layout in crates/ogfx).
  // Views on wasm memory go stale when it grows, so it is re-viewed per call.
  const args = () => {
    const a = new Float32Array(x.memory.buffer, x.args_ptr(), 96)
    a.fill(0)
    a[4] = -1e6; a[5] = -1e6; a[6] = 1e6; a[7] = 1e6
    a.set([1, 0, 0, 1, 0, 0], 8)
    a[14] = -1
    a.set([1, 0, 0, 1, 0, 0], 17)
    return a
  }
  const blendCode = (name = 'normal') => {
    const b = BLEND[name]
    if (b === undefined) throw new Error(`unknown blend mode "${name}" (normal, add, screen, multiply, overlay)`)
    return b
  }
  const setMask = (a, mask) => {
    if (!mask) return
    const m = mask.sprite ? mask : { sprite: mask }
    if (!m.sprite) return
    a[14] = m.sprite.id
    a[15] = m.mode === 'luma' ? 1 : 0
    a[16] = m.invert ? 1 : 0
    if (m.transform) a.set(scaleT(m.transform), 17)
  }
  /** Writes a solid colour or gradient (see linear, radial) at args[3] and args[24..]. */
  const setPaint = (a, paint) => {
    if (paint && typeof paint === 'object') {
      const stops = paint.stops.slice(0, 13)
      if (paint.type === 'linear') {
        a[24] = 1
        a.set([...paint.from, ...paint.to].map(sc), 25)
      } else {
        a[24] = 2
        a.set([...paint.center, paint.radius].map(sc), 25)
      }
      a[29] = stops.length
      stops.forEach(([offset, color, alpha = 1], i) => {
        const c = rgb(color)
        a.set([offset, ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, alpha], 30 + i * 5)
      })
      a[3] = 0
    } else a[3] = rgb(paint)
  }

  const sprite = (layers, { margin = 2 } = {}) => {
    layers = layers.filter((l) => l && l.cmds && l.cmds.length)
    if (!layers.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const l of layers) {
      const b = bounds(scaleCmds(l.cmds))
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1)
    }
    const sx = Math.floor(x0) - margin, sy = Math.floor(y0) - margin
    const id = x.sprite_new(sx, sy, Math.ceil(x1) + margin - sx, Math.ceil(y1) + margin - sy)
    for (const l of layers) {
      const p = path(l.cmds)
      if (!p) continue
      if (typeof l.color === 'object' || l.blend) {
        const a = args()
        a[0] = p.id
        a[1] = l.alpha ?? 1
        a[2] = blendCode(l.blend)
        a[23] = l.evenodd ? 1 : 0
        setPaint(a, l.color)
        x.sprite_fill_ex(id)
      } else x.sprite_fill(id, p.id, rgb(l.color), l.alpha ?? 1, l.evenodd ? 1 : 0, 1, 0, 0, 1, 0, 0)
    }
    return spriteOf(id)
  }

  /** A sprite whose premultiplied RGBA pixels the caller writes (at scene resolution). */
  const bitmap = (bx, by, bw, bh, paint) => {
    if (k === 1) {
      const id = x.sprite_new(bx, by, bw, bh)
      paint(new Uint8Array(x.memory.buffer, x.sprite_ptr(id), bw * bh * 4), bw, bh)
      return spriteOf(id)
    }
    const src = new Uint8Array(bw * bh * 4)
    paint(src, bw, bh)
    const sx = Math.round(bx * k), sy = Math.round(by * k)
    const sw = Math.max(1, Math.round((bx + bw) * k) - sx), sh = Math.max(1, Math.round((by + bh) * k) - sy)
    const id = x.sprite_new(sx, sy, sw, sh)
    resample(src, bw, bh, new Uint8Array(x.memory.buffer, x.sprite_ptr(id), sw * sh * 4), sw, sh)
    return spriteOf(id)
  }

  /** Cuts a sprite to a shape (frame coordinates), or away from it with `invert`. */
  const clip = (sp, cmds, { invert = false, evenodd = false } = {}) => {
    const p = sp && path(cmds)
    if (p) x.sprite_clip(sp.id, p.id, evenodd ? 1 : 0, invert ? 1 : 0)
    return sp
  }

  /** A drop shadow or glow for `sp`: its alpha, grown by `spread`, blurred, in `color`. */
  const shadow = (sp, { blur = 12, color = '#000000', opacity = 0.35, spread = 0 } = {}) =>
    sp ? spriteOf(x.sprite_shadow(sp.id, blur * k, rgb(color), opacity, spread * k)) : null

  /**
   * An image param, decoded and fitted into the box (x, y, w, h): `cover` crops to fill it,
   * `contain` fits inside it, `fill` stretches. Null when the image could not be fetched or
   * decoded (the render is then not cached).
   */
  const image = (src, { x: bx = 0, y: by = 0, w, h, fit = 'cover', position = [0.5, 0.5], radius = 0 } = {}) => {
    if (!src) return null
    if (!(w > 0 && h > 0)) throw new Error('ctx.image needs a box: { x, y, w, h }')
    const bytes = assets.images?.get(src)
    if (!bytes) {
      missing.add(src)
      return null
    }
    const key = `${src}|${bx},${by},${w},${h}|${fit}|${position}|${radius}|${k}`
    const hit = assets.decoded?.get(key)
    if (hit) {
      const id = x.sprite_new(hit.x, hit.y, hit.w, hit.h)
      new Uint8Array(x.memory.buffer, x.sprite_ptr(id), hit.w * hit.h * 4).set(hit.px)
      return spriteOf(id)
    }
    const rc = withBytes(bytes, (p) => x.image_decode(p, bytes.byteLength, Math.ceil(w * k), Math.ceil(h * k)))
    if (rc < 0) {
      missing.add(src)
      return null
    }
    const iw = x.image_width()
    const ih = x.image_height()
    let crop = [0, 0, iw, ih]
    let box = [bx, by, w, h]
    if (fit === 'cover') {
      const k = Math.max(w / iw, h / ih)
      const cw = w / k, ch = h / k
      crop = [(iw - cw) * position[0], (ih - ch) * position[1], cw, ch]
    } else if (fit === 'contain') {
      const k = Math.min(w / iw, h / ih)
      const dw = iw * k, dh = ih * k
      box = [bx + (w - dw) * position[0], by + (h - dh) * position[1], dw, dh]
    }
    box = box.map(sc)
    const sx = Math.round(box[0]), sy = Math.round(box[1])
    const sw = Math.max(1, Math.round(box[0] + box[2]) - sx), sh = Math.max(1, Math.round(box[1] + box[3]) - sy)
    const id = x.sprite_new(sx, sy, sw, sh)
    x.image_to_sprite(id, ...crop)
    x.image_free()
    const sp = spriteOf(id)
    if (radius > 0) clip(sp, rrect(sx / k, sy / k, sw / k, sh / k, radius))
    assets.decoded?.set(key, { x: sx, y: sy, w: sw, h: sh, px: pixels(sp).slice() })
    return sp
  }

  /**
   * A dot-matrix (halftone) of `source`: the sprite is sampled on a grid of `pitch` px cells
   * inside `box` (default: the sprite's bounds); each cell with coverage becomes a dot of `size`
   * px whose value is its coverage (and whose colour is the source's). `order(dot, random)`
   * gives each dot a reveal threshold in [0, 1] (default: random), for g.dots' dissolves.
   */
  const dots = (source, { box, pitch = 6, size = Math.round(pitch * 0.5), round = false, min = 0.04, gamma = 1, seed = 1, order } = {}) => {
    if (!source) return null
    const sp = Array.isArray(source) ? sprite(source) : source
    if (!sp) return null
    const [bx, by, bw, bh] = box ?? [sp.x, sp.y, sp.w, sp.h]
    const px = pixels(sp)
    const random = mulberry(seed)
    const out = []
    const half = Math.floor((pitch - size) / 2)
    const cols = Math.floor(bw / pitch), rows = Math.floor(bh / pitch)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = bx + c * pitch + half, y0 = by + r * pitch + half
        // Average the footprint of the dot in the source.
        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0
        // In output pixels: the footprint's rows and columns at this scale.
        for (let yy = y0; yy < y0 + size; yy++) {
          const ly = Math.floor((yy + 0.5) * k) - sp.px.y
          if (ly < 0 || ly >= sp.px.h) { n += size; continue }
          for (let xx = x0; xx < x0 + size; xx++) {
            n++
            const lx = Math.floor((xx + 0.5) * k) - sp.px.x
            if (lx < 0 || lx >= sp.px.w) continue
            const o = (ly * sp.px.w + lx) * 4
            sr += px[o]; sg += px[o + 1]; sb += px[o + 2]; sa += px[o + 3]
          }
        }
        const value = (sa / (n * 255)) ** gamma
        const rnd = random()
        if (value < min) continue
        const color = sa > 0 ? (Math.round((sr / sa) * 255) << 16) | (Math.round((sg / sa) * 255) << 8) | Math.round((sb / sa) * 255) : 0xffffff
        const dot = { x: x0, y: y0, u: (c + 0.5) / cols, v: (r + 0.5) / rows, value, color }
        const t = order ? order(dot, rnd) : rnd
        out.push(x0 * k, y0 * k, value, Math.max(0, Math.min(1, t)), color)
      }
    }
    if (!out.length) return null
    const id = withBytes(new Float32Array(out), (p) => x.dots_new(p, out.length / 5, size * k, round ? 1 : 0))
    return { id, count: out.length / 5 }
  }

  /**
   * A grid of palette-indexed cells for effects recomputed every frame (an ordered dither, say),
   * which a dot field cannot do: its colours are fixed in setup. Cells are whole output pixels,
   * so the grid stays crisp at any scale. Fill `grid.index` (cols x rows, row-major; 0 is
   * transparent, i picks palette[i]) and draw it with g.cells(grid).
   */
  const cells = ({ x: bx = 0, y: by = 0, w = video.width, h = video.height, pitch = 4, size = pitch, palette }) => {
    const step = Math.max(1, Math.round(pitch * k)), dot = Math.max(1, Math.min(step, Math.round(size * k)))
    const x0 = Math.round(bx * k), y0 = Math.round(by * k)
    const cols = Math.floor((w * k) / step), rows = Math.floor((h * k) / step)
    const pal = Uint32Array.from(palette, rgb)
    // Kept for the run: written into before every draw, never freed.
    const buf = x.alloc(cols * rows), palPtr = x.alloc(pal.byteLength)
    new Uint32Array(x.memory.buffer, palPtr, pal.length).set(pal)
    return { cols, rows, step: step / k, index: new Uint8Array(cols * rows), draw: [buf, cols, rows, x0, y0, step, dot, palPtr, pal.length] }
  }

  /**
   * The tiled-grid reveal effect: a shape (usually many rounded cells) rasterized once into a
   * coverage mask, revealed by a radial gradient from `center`, and resampled from a mip pyramid
   * when the stage is scaled. Kept across renders while `key` is unchanged.
   */
  const grid = (spec) => {
    const g = compositor.grid
    const ensure = () => {
      if (g.key === `${spec.key}@${k}` && x.grid_ready()) return
      const p = path(spec.cells)
      const [a, b, c, d, e, f] = scaleT(spec.transform)
      const [cx, cy] = spec.center.map(sc)
      const ox = Math.round(spec.canvas.x * k), oy = Math.round(spec.canvas.y * k)
      const w = Math.round((spec.canvas.x + spec.canvas.w) * k) - ox, h = Math.round((spec.canvas.y + spec.canvas.h) * k) - oy
      x.grid_setup(p.id, ox, oy, w, h, cx, cy, a, b, c, d, e, f, spec.background ?? 17, spec.cell ?? 31)
      g.key = `${spec.key}@${k}`
      g.bakedR = -1
    }
    return { ensure, spec }
  }

  // ---- per-frame state machine (see Frame below)
  let prevKeys = []
  let valid = []
  let idx = 0
  let matching = true
  let pending = -1
  let inLayer = false
  let overlay = false
  let cleared = false
  let keys = []

  const flushBase = () => {
    if (!matching) return
    matching = false
    if (pending >= 0) x.layer_restore(pending)
  }
  const beforeDraw = () => {
    if (inLayer || overlay) return
    flushBase()
    if (idx === 0 && !cleared) throw new Error('a frame must start with g.clear() or g.layer()')
    overlay = true
    x.mark(1)
  }

  /** @type {import('../types/index.js').Frame} */
  const g = {
    width: video.width,
    height: video.height,
    clear(color) {
      if (!inLayer) {
        if (overlay || idx > 0) throw new Error('g.clear() outside a layer must come first')
        matching = false
        cleared = true
        x.frame_full()
      }
      x.clear(rgb(color))
    },
    layer(key, paint) {
      if (inLayer) throw new Error('layers cannot be nested; call g.layer() again for the next one')
      if (overlay || cleared) throw new Error('layers must come before any overlay drawing')
      const k = typeof key === 'string' ? key : stateKey(key)
      if (matching && prevKeys[idx] === k && valid[idx]) pending = idx
      else {
        flushBase()
        x.frame_full()
        inLayer = true
        x.mark(0)
        paint(g)
        inLayer = false
        x.layer_save(idx)
        valid[idx] = true
        for (let j = idx + 1; j < valid.length; j++) valid[j] = false
      }
      keys[idx] = k
      idx++
    },
    fill(p, color, { alpha = 1, transform: t, clip: c, mask, blend, evenodd } = {}) {
      if (!p || alpha <= 0) return
      beforeDraw()
      if (typeof color !== 'object' && !c && !mask && !blend && !evenodd) {
        const [a, b, cc, d, e, f] = t ? scaleT(t) : [1, 0, 0, 1, 0, 0]
        x.fill(p.id, rgb(color), alpha, a, b, cc, d, e, f)
        return
      }
      const a = args()
      a[0] = p.id
      a[1] = alpha
      a[2] = blendCode(blend)
      a[23] = evenodd ? 1 : 0
      setPaint(a, color)
      if (c) a.set(c.map(sc), 4)
      if (t) a.set(scaleT(t), 8)
      setMask(a, mask)
      x.fill_ex()
    },
    draw(s, { opacity = 1, blur = 0, clip: c, transform: t, blend, mask } = {}) {
      if (!s || opacity <= 0) return
      beforeDraw()
      const a = args()
      a[0] = s.id
      a[1] = opacity
      a[2] = blur * k
      a[3] = blendCode(blend)
      if (c) a.set(c.map(sc), 4)
      if (t) a.set(snapT(t), 8)
      setMask(a, mask)
      x.draw_ex()
    },
    dots(field, { progress = 1, softness = 0.25, opacity = 1, grow = false, color, reverse = false } = {}) {
      if (!field || opacity <= 0 || progress <= 0) return
      beforeDraw()
      const soft = Math.max(0, softness)
      x.dots_draw(field.id, progress * (1 + soft), soft, opacity, grow ? 1 : 0, color === undefined ? -1 : rgb(color), reverse ? 1 : 0)
    },
    cells(grid) {
      if (!grid) return
      beforeDraw()
      new Uint8Array(x.memory.buffer, grid.draw[0], grid.index.length).set(grid.index)
      x.cells_draw(...grid.draw)
    },
    grid(effect, { radius, opacity = 1, scale = 1, x: tx = 0, y: ty = 0 }) {
      if (!inLayer) throw new Error('g.grid() repaints the whole frame, so it belongs in a layer')
      if (!(opacity > 0 && radius > 0)) {
        x.clear((effect.spec.background ?? 17) * 0x010101)
        return
      }
      effect.ensure()
      const r = radius * k
      if (scale === 1 && tx === 0 && ty === 0) x.grid_reveal(r, opacity)
      else {
        const gs = compositor.grid
        if (gs.bakedR !== r) {
          x.grid_bake(r)
          gs.bakedR = r
        }
        x.grid_scaled(scale, tx * k, ty * k, opacity)
      }
    },
  }

  const ctx = { width: video.width, height: video.height, fps, frames: video.frames, text, path, sprite, bitmap, grid, clip, shadow, image, dots, cells, mask: (cmds, o) => sprite([{ cmds, color: 0xffffff, evenodd: o?.evenodd }], o) }
  const scene = setup(ctx)
  const frames = video.frames
  let lastKey = null

  return {
    width: W,
    height: H,
    fps,
    frames,
    qp: video.qp ?? 20,
    /** Draws frame i; false when its state equals the previous frame's (nothing was drawn). */
    frame(i) {
      const s = scene.state(i)
      const key = stateKey(s)
      if (key === lastKey) return false
      lastKey = key
      x.frame_begin(0)
      idx = 0
      matching = true
      pending = -1
      overlay = false
      cleared = false
      keys = []
      scene.draw(g, s)
      if (inLayer) throw new Error('unfinished layer')
      flushBase()
      x.mark(0)
      prevKeys = keys
      for (let j = idx; j < valid.length; j++) valid[j] = false
      return true
    },
    rgba: () => new Uint8Array(x.memory.buffer, x.frame_ptr(), W * H * 4),
    /** Converts the frame; `changed` is the number of macroblocks that differ from the last call. */
    i420() {
      const changed = x.to_i420()
      const mbs = ((W + 15) >> 4) * ((H + 15) >> 4)
      return {
        changed,
        yuv: new Uint8Array(x.memory.buffer, x.yuv_ptr(), (W * H * 3) / 2),
        mbInfo: new Uint8Array(x.memory.buffer, x.mb_info_ptr(), mbs),
      }
    },
    /** Image params that could not be fetched or decoded: such a render must not be cached. */
    missing,
    dispose: () => scene.dispose?.(),
  }
}

/** mulberry32: a small deterministic PRNG. */
function mulberry(seed) {
  let h = seed | 0
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Area-averaging resample of premultiplied RGBA (src sw x sh into dst dw x dh), for bitmaps
 * painted at scene resolution and drawn at a smaller output scale.
 */
function resample(src, sw, sh, dst, dw, dh) {
  const fx = sw / dw, fy = sh / dh
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy, y1 = y0 + fy
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx, x1 = x0 + fx
      let r = 0, g = 0, b = 0, a = 0, wsum = 0
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx))
          const o = (sy * sw + sx) * 4
          r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w; a += src[o + 3] * w
          wsum += w
        }
      }
      const o = (y * dw + x) * 4
      dst[o] = Math.round(r / wsum); dst[o + 1] = Math.round(g / wsum); dst[o + 2] = Math.round(b / wsum); dst[o + 3] = Math.round(a / wsum)
    }
  }
}
