# Writing a scenario

```js
import { gsap } from 'gsap'
import { defineScenario, p, rrect } from 'streaming-og-video'

export const hello = defineScenario({
  id: 'hello',                       // URL: /hello.mp4
  version: 1,                        // bump to invalidate cached renders
  video: { width: 1200, height: 630, fps: 30, frames: 150 },
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
| `ctx.text.wrap(font, str, size, maxWidth, { letterSpacing, maxLines })` | Greedy word wrap with ellipsis clamping. Returns lines of `{ words: [{ text, run, x }], width }` |
| `ctx.text.fit(font, str, size, maxWidth)` | One line with an ellipsis |
| `ctx.text.metrics(font, size)`, `ctx.text.baselineIn(font, size, lineHeight)` | Chrome-compatible vertical metrics |
| `ctx.path(cmds)` | A path for `g.fill` (null if empty) |
| `ctx.sprite(layers, { margin })` | Rasterize solid layers `{ cmds, color, alpha?, evenodd? }` once into a premultiplied sprite. Margin leaves room for blur |
| `ctx.bitmap(x, y, w, h, paint)` | A sprite whose premultiplied RGBA pixels you write (gradients, noise, images) |
| `ctx.grid(spec)` | The tiled-grid reveal effect used by `title-card` |

Fonts: `regular` and `semibold` (Inter) are built in. Add your own with `fonts: { display: () => bytes }` on the scenario.

Path command buffers are flat arrays:
- `0 x y`: move
- `1 x y`: line
- `2 x1 y1 x y`: quad
- `3 x1 y1 x2 y2 x y`: cubic
- `4`: close

Helpers: `rrect`, `rect`, `ellipse`, `transform(cmds, k, tx, ty)`, `bounds`.

## Frame (`g`), run per changed frame

| Call | Notes |
|---|---|
| `g.layer(key, paint)` | Cached backdrop. Calls stack. The deepest layer whose key and all earlier keys are unchanged is restored; later ones repaint. Layers come before overlays. |
| `g.clear(color)` | Inside a layer, or as the first call of a layerless frame |
| `g.fill(path, color, { alpha, transform })` | Live vector fill with a 2D affine `[a, b, c, d, e, f]` |
| `g.draw(sprite, { opacity, blur, clip })` | Blend a sprite. `blur` is a Gaussian sigma in px (three box passes). `clip` is `[x0, y0, x1, y1]` |
| `g.grid(effect, { radius, opacity, scale, x, y })` | Inside a layer only |

## Patterns

- **Bake what has settled.** Track when each element's last tween ends. `settleTimes(tl, items)` and `bakedAt(items, t)` from `streaming-og-video/gsap` do this. Draw settled items inside a layer keyed by the settled set, and the rest as overlays. See `src/scenarios/diagram.js`.
- **Text that animates per word or letter**: one sprite per word, with `run.cmds(x, y, glyphIndex)` for letters.
- **Counters**: cache one path per displayed value in a Map, so each value is only shaped once.
- **Wipes**: `g.draw(sprite, { clip })` with a moving edge. Clips are pixel-snapped.
- **Keep state small.** `state(i)` is stringified every frame, so return only what `draw` reads. GSAP's `_gsap` caches are skipped automatically because keys starting with `_` are ignored.
- **Under budget?** `sogv bench` should stay well under realtime (7 s of video in under ~300 ms locally).

## GSAP gotchas

- **Use `fromTo`, not `to`.** Stills and posters seek straight to one frame, and `to()` records its start values lazily, the first time it renders. That gives wrong values when frames are visited out of order. For chained tweens on the same property, add `immediateRender: false` to the later ones.
- **Keep effects in the state.** `onUpdate` callbacks that set other objects (counters, packets) must leave their result in objects that `state(i)` returns, so frame diffing sees them.
- **Videos are variable frame rate.** Frames identical to the previous one are never encoded, so tools that count frames (`ffmpeg select=eq(n,…)`) don't line up with frame indices. Seek by time instead.

## Empty strings

An explicit empty string (`?kicker=`) is a value for string params, so URLs can clear a field that has a non-empty default. For every other kind, an empty value means "use the default".

## Testing

`node --test` runs determinism checks for the built-in scenarios. Copy `test/render.test.js` for your own: two renders must be byte-identical, and the prefix bytes must be the start of the file.
