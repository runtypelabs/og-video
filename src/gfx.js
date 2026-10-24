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
 * Prepares one render: runs the scene's setup and returns the frame-by-frame interface the
 * encoder drives.
 * @param {{ x: any, grid: any }} compositor
 * @param {any} text from createTextEngine
 * @param {{ width: number, height: number, fps: number, frames: number }} video
 * @param {(ctx: any) => any} setup
 */
export function createRun(compositor, text, video, setup) {
  const { x } = compositor
  const { width: W, height: H, fps } = video
  if (x.init(W, H) !== 0) throw new Error(`unsupported frame size ${W}x${H}: the width must be a multiple of 16 and the height even`)
  x.reset()

  const path = (cmds) => {
    if (!cmds.length) return null
    const f = new Float32Array(cmds)
    const p = x.alloc(f.byteLength)
    new Float32Array(x.memory.buffer, p, f.length).set(f)
    const id = x.path_new(p, f.length)
    x.dealloc(p, f.byteLength)
    return id < 0 ? null : { id }
  }

  const sprite = (layers, { margin = 2 } = {}) => {
    layers = layers.filter((l) => l && l.cmds && l.cmds.length)
    if (!layers.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const l of layers) {
      const b = bounds(l.cmds)
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1)
    }
    const sx = Math.floor(x0) - margin, sy = Math.floor(y0) - margin
    const id = x.sprite_new(sx, sy, Math.ceil(x1) + margin - sx, Math.ceil(y1) + margin - sy)
    for (const l of layers) {
      const p = path(l.cmds)
      if (p) x.sprite_fill(id, p.id, rgb(l.color), l.alpha ?? 1, l.evenodd ? 1 : 0, 1, 0, 0, 1, 0, 0)
    }
    return { id }
  }

  /** A sprite whose premultiplied RGBA pixels the caller writes. */
  const bitmap = (bx, by, bw, bh, paint) => {
    const id = x.sprite_new(bx, by, bw, bh)
    paint(new Uint8Array(x.memory.buffer, x.sprite_ptr(id), bw * bh * 4), bw, bh)
    return { id }
  }

  /**
   * The tiled-grid reveal effect: a shape (usually many rounded cells) rasterized once into a
   * coverage mask, revealed by a radial gradient from `center`, and resampled from a mip pyramid
   * when the stage is scaled. Kept across renders while `key` is unchanged.
   */
  const grid = (spec) => {
    const g = compositor.grid
    const ensure = () => {
      if (g.key === spec.key && x.grid_ready()) return
      const p = path(spec.cells)
      const [a, b, c, d, e, f] = spec.transform
      const [cx, cy] = spec.center
      const { x: ox, y: oy, w, h } = spec.canvas
      x.grid_setup(p.id, ox, oy, w, h, cx, cy, a, b, c, d, e, f, spec.background ?? 17, spec.cell ?? 31)
      g.key = spec.key
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
    width: W,
    height: H,
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
    fill(p, color, { alpha = 1, transform: t } = {}) {
      if (!p || alpha <= 0) return
      beforeDraw()
      const [a, b, c, d, e, f] = t ?? [1, 0, 0, 1, 0, 0]
      x.fill(p.id, rgb(color), alpha, a, b, c, d, e, f)
    },
    draw(s, { opacity = 1, blur = 0, clip } = {}) {
      if (!s || opacity <= 0) return
      beforeDraw()
      if (clip) x.sprite_draw_clip(s.id, opacity, blur, clip[0], clip[1], clip[2], clip[3])
      else x.sprite_draw(s.id, opacity, blur)
    },
    grid(effect, { radius, opacity = 1, scale = 1, x: tx = 0, y: ty = 0 }) {
      if (!inLayer) throw new Error('g.grid() repaints the whole frame, so it belongs in a layer')
      if (!(opacity > 0 && radius > 0)) {
        x.clear((effect.spec.background ?? 17) * 0x010101)
        return
      }
      effect.ensure()
      if (scale === 1 && tx === 0 && ty === 0) x.grid_reveal(radius, opacity)
      else {
        const gs = compositor.grid
        if (gs.bakedR !== radius) {
          x.grid_bake(radius)
          gs.bakedR = radius
        }
        x.grid_scaled(scale, tx, ty, opacity)
      }
    },
  }

  const ctx = { width: W, height: H, fps, frames: video.frames, text, path, sprite, bitmap, grid }
  const scene = setup(ctx)
  const frames = video.frames
  let lastKey = null

  return {
    width: W,
    height: H,
    fps,
    frames,
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
    dispose: () => scene.dispose?.(),
  }
}
