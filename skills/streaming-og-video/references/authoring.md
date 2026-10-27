# Writing a scenario

```js
import { gsap } from 'gsap'
import { defineScenario, p, rrect } from 'streaming-og-video'

export const hello = defineScenario({
  id: 'hello',                       // URL: /hello.mp4
  version: 1,                        // bump to invalidate cached renders
  video: { width: 1200, height: 630, fps: 30, frames: 150 }, // layout units; renders at 960x504
  params: p.object({
    title: p.string({ max: 80, default: 'Hello' }),
    accent: p.color({ default: '#3b82f6' }),
  }),
  // Frames [0, 20) look the same for every title with the same accent.
  prefix: { frames: 20, key: (q) => q.accent },
  meta: (q) => ({ title: q.title }),
  setup(ctx, q) {
    const bar = ctx.path(rrect(0, 0, 400, 8, 4))
    const run = ctx.text.run('semibold', q.title, 72)
    const title = ctx.sprite([{ cmds: run.cmds(100, 340), color: '#ffffff' }], { margin: 20 })

    const s = { bar: { w: 0 }, title: { opacity: 0, blur: 8 } }
    const tl = gsap.timeline({ paused: true })
    tl.fromTo(s.bar, { w: 0 }, { w: 1, duration: 0.6, ease: 'expo.out' }, 0.1)
    tl.fromTo(s.title, { opacity: 0, blur: 8 }, { opacity: 1, blur: 0, duration: 0.4, ease: 'power3.out' }, 0.7)

    return {
      state(i) {
        tl.seek(i / ctx.fps, false)
        return s
      },
      draw(g) {
        g.layer('bg', () => g.clear('#111111'))
        g.fill(bar, q.accent, { transform: [s.bar.w, 0, 0, 1, 100, 380] })
        g.draw(title, s.title)
      },
      dispose: () => tl.kill(),
    }
  },
})
```

## Setup context (`ctx`), run once per render

| Member | Use |
|---|---|
| `ctx.width`, `ctx.height`, `ctx.fps`, `ctx.frames` | Video spec |
| `ctx.text.run(font, str, size, { letterSpacing, features })` | Shape a run. Returns `{ advance, cmds(x, baseline, glyphIndex?), rightOf(i) }` |
| `ctx.text.wrap(font, str, size, maxWidth, { letterSpacing, maxLines, breakWords })` | Greedy word wrap with ellipsis clamping; `breakWords` splits a word wider than the line. Returns lines of `{ words: [{ text, run, x }], width }` |
| `ctx.text.fit(font, str, size, maxWidth)` | One line with an ellipsis |
| `ctx.text.metrics(font, size)`, `ctx.text.baselineIn(font, size, lineHeight)` | Chrome-compatible vertical metrics |
| `ctx.path(cmds)` | A path for `g.fill` (null if empty) |
| `ctx.sprite(layers, { margin })` | Rasterize layers `{ cmds, color, alpha?, evenodd?, blend? }` once into a premultiplied sprite. `color` can be a gradient. Margin leaves room for blur. Returns `{ id, x, y, w, h }` |
| `ctx.bitmap(x, y, w, h, paint)` | A sprite whose premultiplied RGBA pixels you write (noise, procedural textures) |
| `ctx.mask(cmds)` | A white coverage sprite of a shape, to use as a mask |
| `ctx.clip(sprite, cmds, { invert })` | Cuts a sprite to a shape in place (rounded image corners, cut-outs) |
| `ctx.shadow(sprite, { blur, color, opacity, spread })` | A new sprite: the drop shadow or glow of `sprite`, computed once. Draw it under the sprite with an offset transform (glows: `blend: 'add'` or `'screen'`) |
| `ctx.image(url, { x, y, w, h, fit, position, radius })` | An image param as a sprite fitted into the box: `cover` (default), `contain`, `fill`. Null if it could not be fetched or decoded; draw a placeholder then |
| `ctx.dots(source, { box, pitch, size, round, min, gamma, seed, order })` | A dot-matrix field: `source` (a sprite or layers) sampled on a `pitch` grid; each covered cell becomes a dot whose brightness is its coverage. `order(dot, random)` sets each dot's reveal threshold in [0, 1] |
| `ctx.cells({ x, y, w, h, pitch, size, palette })` | A grid of palette-indexed cells for effects recomputed every frame, such as an ordered dither. Fill `grid.index` (cols x rows; 0 is transparent, i picks `palette[i]`) before each `g.cells(grid)`. Cells snap to whole output pixels |
| `ctx.grid(spec)` | The tiled-grid reveal effect used by `title-card` |

Fonts: `regular` and `semibold` (Inter) are built in. JetBrains Mono (Latin subset) is built in but opt-in: `fonts: { mono: 'jetbrains-mono', monoBold: 'jetbrains-mono-semibold' }` (see `terminal.js` and `code-kit.js`). It has no box-drawing, arrow or check glyphs, so draw those as shapes. Add your own with `fonts: { display: () => bytes }` on the scenario.

Path command buffers are flat arrays:
- `0 x y`: move
- `1 x y`: line
- `2 x1 y1 x y`: quad
- `3 x1 y1 x2 y2 x y`: cubic
- `4`: close

Helpers: `rrect`, `rect`, `ellipse`, `transform(cmds, k, tx, ty)`, `bounds`.

Transforms and paints:
- `pose({ x, y, rotate, scale, origin })` builds a matrix that rotates (degrees) and scales around `origin`, then moves by (x, y). `multiply(m, n)` composes two (n first).
- `linear(x0, y0, x1, y1, stops)` and `radial(cx, cy, r, stops)` are gradients, usable wherever a colour is: sprite layers and `g.fill`. Stops are `[offset, color, alpha?]`, up to 13. Coordinates are path units, so they move with a fill's transform.

## Image params

`p.image()` accepts an http(s) URL or a base64 `data:image/png|jpeg|webp` URI. Before setup, the engine fetches every image param (and any URLs `images(params)` on the scenario returns), outside the render queue:
- capped at 5 MB and 24 images by default;
- cached per isolate, both the bytes and each decoded, fitted sprite;
- decoded in wasm (PNG, JPEG, WebP; at most 4 MP after JPEG's DCT downscale).

Configure it with `images: { allow, maxBytes, maxImages, timeout, cacheBytes, fetch }` on `createHandler` or `createNodeEngine`. A render with a missing image still completes, but it is never cached. Image URLs are part of the cache key, so if a URL's content changes, use a new URL. If images appear in the prefix frames, include them in `prefix.key`.

## Physics

`createWorld({ gravity, iterations, sleepSpeed, sleepTime })` from `streaming-og-video` is a small deterministic world of rigid boxes. Run it in setup, record each body's pose per frame (a Float32Array), and have `state(i)` read frame i:

```js
const world = createWorld({ gravity: 1900 })
world.box({ x: W / 2, y: H + 60, w: W * 3, h: 120, density: 0 })   // static floor
const bodies = words.map((w) => world.box({ x: ..., y: -40, w: w.width, h: w.height, angle: ..., friction: 0.55 }))
for (let f = 0; f < frames; f++) { for (let s = 0; s < 4; s++) world.step(1 / fps / 4); record(f, bodies) }
```

Bodies at rest fall asleep: they are exactly still and act as static until something fast hits them or they lose all contact. Draw sleepers in a layer keyed by which bodies sleep, and draw only the awake ones live. `falling-words.js` shows the whole pattern, including a module-level cache of the recording (setup runs twice per render: prefix, then tail). Never use `Math.random()`: seed from params with a PRNG.

## Frame (`g`), run per changed frame

| Call | Notes |
|---|---|
| `g.layer(key, paint)` | Cached backdrop. Calls stack. The deepest layer whose key and all earlier keys are unchanged is restored; later ones repaint. Layers come before overlays. |
| `g.clear(color)` | Inside a layer, or as the first call of a layerless frame |
| `g.fill(path, paint, { alpha, transform, clip, mask, blend, evenodd })` | Live vector fill with a 2D affine `[a, b, c, d, e, f]`. `paint` is a colour or a gradient |
| `g.draw(sprite, { opacity, blur, clip, transform, blend, mask })` | Blend a sprite. `blur` is a Gaussian sigma in px, applied before the transform. `clip` is `[x0, y0, x1, y1]`. `transform` maps the sprite's frame coordinates (bilinear; whole-pixel translations copy pixels and cost nothing extra) |
| `g.dots(field, { progress, softness, opacity, grow, color, reverse })` | Draw a dot field revealed to `progress` (0..1). Dots appear as progress passes their threshold, fading (or growing, with `grow`) in over `softness`. For a dissolve-out in the same direction, run progress from 1 to 0 with `reverse: true` |
| `g.cells(grid)` | Draw a cell grid as its `index` stands: each nonzero cell a solid square. Every frame that calls it differs, so keep it for effects that really move |
| `g.grid(effect, { radius, opacity, scale, x, y })` | Inside a layer only |

- **Blend modes:** `normal`, `add`, `screen`, `multiply`, `overlay`.
- **Masks:** `mask: sprite` gates by the sprite's alpha. `mask: { sprite, transform, mode: 'luma', invert: true }` places it, uses its luminance, or inverts it. Move the mask's transform to make wipes, reveals and image-in-type mattes.

Costs for one 1200x630 frame (local wasm SIMD). Frames render at 960x504 by default, about two thirds of the pixels:
| Operation | Cost |
|---|---|
| Full-frame blend | 0.4 ms |
| Full-frame blur, sigma ≥ 4 | 1.7–3.5 ms |
| Full-frame blur, sigma < 3 | ~4.5 ms |
| 120-word headline blur | 0.2 ms |
| Full-frame bilinear (rotate, scale, sub-pixel move) | ~2.5 ms |
| 120 rotated words | ~1.5 ms |
| Full-frame screen, multiply or overlay | ~1.6 ms |
| A dot field | Well under 1 ms |

## Patterns

- **Bake what has settled.** Track when each element's last tween ends. `settleTimes(tl, items)` and `bakedAt(items, t)` from `streaming-og-video/gsap` do this. Draw settled items inside a layer keyed by the settled set, and the rest as overlays. See `src/scenarios/diagram.js`.
- **Text that animates per word or letter**: one sprite per word, with `run.cmds(x, y, glyphIndex)` for letters.
- **Counters**: cache one path per displayed value in a Map, so each value is only shaped once.
- **Wipes**: `g.draw(sprite, { clip })` with a moving edge. Clips are pixel-snapped. For shaped or soft wipes, use a `mask` with a moving transform.
- **Moving, rotating sprites**: `g.draw(sprite, { transform: pose({ origin: [cx, cy], rotate, x, y }) })`. Rasterize the sprite once, where it rests.
- **Scrolling**: move by whole pixels per frame where you can (`gallery.js`). Whole-pixel motion copies pixels and lets x264 match blocks exactly, which is much cheaper to encode than sub-pixel motion.
- **Shadows and glows**: make them once with `ctx.shadow` and draw them like any sprite.
- **Dissolves**: `ctx.dots` + `g.dots` (`dot-matrix.js`). A label in the pixel font can be a dot field too.
- **Moving dithers**: `ctx.cells` + `g.cells` (`dither.js`). Evaluate the field at a few keyframes in setup, then each frame blend them and quantize against a Bayer matrix fixed to the screen.
- **Keep state small.** `state(i)` is stringified every frame, so return only what `draw` reads. GSAP's `_gsap` caches are skipped automatically because keys starting with `_` are ignored.
- **Under budget?** `sogv bench` should stay well under realtime (7 s at 60 fps in under ~500 ms locally). When most of the frame moves every frame, the encoder dominates: lower `video.fps` (24 or 30) and use a `video.qp` of 23–26 for busy fine detail.

## GSAP gotchas

- **Use `fromTo`, not `to`.** Stills and posters seek straight to one frame, and `to()` records its start values lazily, the first time it renders. That gives wrong values when frames are visited out of order. For chained tweens on the same property, add `immediateRender: false` to the later ones.
- **Keep effects in the state.** `onUpdate` callbacks that set other objects (counters, packets) must leave their result in objects that `state(i)` returns, so frame diffing sees them.
- **Videos are variable frame rate.** Frames identical to the previous one are never encoded, so tools that count frames (`ffmpeg select=eq(n,…)`) don't line up with frame indices. Seek by time instead.

## Empty strings

An explicit empty string (`?kicker=`) is a value for string params, so URLs can clear a field that has a non-empty default. For every other kind, an empty value means "use the default".

## Testing

`node --test` runs determinism checks for the built-in scenarios. Copy `test/render.test.js` for your own: two renders must be byte-identical, and the prefix bytes must be the start of the file.
