// falling-words: a clean card with a dot and a label in the middle. About a hundred small
// uppercase words rain in from above, each at its own angle, tumble against each other and pile
// up along the bottom edge. Near the end the floor gives way and the pile drops out of frame, so
// the video loops back to its empty opening.
//
// The physics runs once in setup (src/physics.js: deterministic rigid boxes) and is recorded per
// frame; frames just play it back. Words are sprites drawn with a rotation transform (bilinear).
// Words that have come to rest fall asleep: they are baked into a cached layer and only the
// moving ones are drawn live, so a settled pile costs nothing per frame.
//
// Dense motion of fine detail is what costs here (encoding ~100 frames of small rotating type),
// so it runs at qp 23.
//
// The first 30 frames (0.5 s: the dot and label popping in) depend only on the label and the
// accent, so they are one prefix per label/accent pair.
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, ellipse } from '../gfx.js'
import { createWorld } from '../physics.js'
import { prng } from './showcase-kit.js'

const W = 1200
const H = 630
const FPS = 60
const FRAMES = 420
const RAIN_AT = 0.5
const DROP_AT = 6.3
const SUBSTEPS = 2 // 1/120 s physics steps
const FONT = 17

const WORDS = [
  'Radio', 'Combobox', 'Carousel', 'Pagination', 'Drawer', 'Sidebar', 'Menu', 'Switch', 'Alert',
  'Button', 'Textarea', 'Accordion', 'Dialog', 'Card', 'Slider', 'Select', 'List', 'Table', 'Tabs',
  'Progress', 'Checkbox', 'Tag', 'Input', 'Tooltip', 'Popover', 'Avatar', 'Badge', 'Toast', 'Grid',
  'Dropdown', 'Toggle', 'Stepper', 'Calendar', 'Breadcrumb', 'Spinner', 'Divider',
]

export const fallingWords = defineScenario({
  id: 'falling-words',
  version: 1,
  video: { width: W, height: H, fps: FPS, frames: FRAMES, qp: 23 },
  params: p.object({
    label: p.string({ max: 24, default: 'System' }),
    words: p.array(p.string({ max: 16, min: 1 }), { min: 1, max: 60, default: () => WORDS }),
    count: p.int({ min: 10, max: 140, default: 100 }),
    accent: p.color({ default: '#ff4a1c' }),
    seed: p.int({ min: 0, max: 9999, default: 1 }),
  }),
  prefix: { frames: 30, key: (q) => `${q.label}|${q.accent}` },
  poster: Math.round(5.6 * FPS),
  meta: (q) => ({ title: q.label, description: q.words.slice(0, 6).join(', ') }),
  setup,
})

// ---------------------------------------------------------------- simulation

/** Recent simulations by input: a render runs setup twice (prefix, then tail). */
const recorded = new Map()

/**
 * Rains `sizes` (word boxes) into the frame and records every body's pose per frame: x, y, angle
 * in poses[(frame * n + k) * 3 ...], asleep[frame * n + k], and epoch[frame], which changes
 * whenever the set of sleeping bodies does (the baked layer's key).
 */
function simulate(sizes, seed) {
  const key = `${seed}|${sizes.map(([w, h]) => `${w},${h}`).join(';')}`
  const hit = recorded.get(key)
  if (hit) return hit
  const rnd = prng(`falling-words:${seed}`)
  const world = createWorld({ gravity: 1900, iterations: 8, sleepSpeed: 12, sleepTime: 0.2 })
  const floor = world.box({ x: W / 2, y: H + 60 + 2, w: W * 3, h: 120, density: 0, friction: 0.7 })
  world.box({ x: -60 - 4, y: 0, w: 120, h: H * 4, density: 0, friction: 0.3 })
  world.box({ x: W + 60 + 4, y: 0, w: 120, h: H * 4, density: 0, friction: 0.3 })

  // Spawn in a loose cloud above the frame: higher words arrive later.
  const n = sizes.length
  const words = sizes.map(([w, h], k) => {
    const band = k / n
    return world.box({
      x: 40 + rnd() * (W - 80),
      y: -30 - band * 1500 - rnd() * 160,
      w,
      h,
      angle: (rnd() - 0.5) * Math.PI * 0.9,
      vy: 260 + rnd() * 120,
      spin: (rnd() - 0.5) * 3,
      density: 1,
      friction: 0.55,
    })
  })

  const poses = new Float32Array(FRAMES * n * 3)
  const asleep = new Uint8Array(FRAMES * n)
  const epoch = new Int32Array(FRAMES)
  const dt = 1 / FPS / SUBSTEPS
  let dropped = false
  let e = 0
  for (let f = 0; f < FRAMES; f++) {
    const t = f / FPS
    if (t >= RAIN_AT) {
      if (!dropped && t >= DROP_AT) {
        dropped = true
        world.remove(floor)
        world.wake()
      }
      for (let s = 0; s < SUBSTEPS; s++) world.step(dt)
    }
    let changed = false
    words.forEach((b, k) => {
      const o = (f * n + k) * 3
      poses[o] = b.x
      poses[o + 1] = b.y
      poses[o + 2] = b.angle
      asleep[f * n + k] = b.asleep ? 1 : 0
      if (f > 0 && asleep[f * n + k] !== asleep[(f - 1) * n + k]) changed = true
    })
    if (changed) e++
    epoch[f] = e
  }
  const out = { poses, asleep, epoch }
  recorded.set(key, out)
  while (recorded.size > 4) recorded.delete(recorded.keys().next().value)
  return out
}

// ---------------------------------------------------------------- setup

function setup(ctx, q) {
  const { text } = ctx
  const ink = 0x141416

  // The centre piece: a dot and a pill with the label.
  const cy = 236
  const labelRun = text.fit('regular', q.label, 30, 420, { letterSpacing: -0.3 })
  const pillW = Math.ceil(labelRun.advance) + 40
  const pillH = 50
  const dotR = 16
  const groupW = dotR * 2 + 12 + pillW
  const gx = Math.round(W / 2 - groupW / 2)
  const dot = ctx.sprite([{ cmds: ellipse(gx + dotR, cy, dotR), color: q.accent }], { margin: 3 })
  const px0 = gx + dotR * 2 + 12
  const pill = ctx.sprite([
    { cmds: [...rrect(px0, cy - pillH / 2, pillW, pillH, pillH / 2), ...rrect(px0 + 2, cy - pillH / 2 + 2, pillW - 4, pillH - 4, pillH / 2 - 2)], color: ink, evenodd: true },
    { cmds: labelRun.cmds(px0 + 20, cy + 10.5), color: ink },
  ], { margin: 3 })

  // Words: one sprite each (laid out at the origin), and a box a little larger than the caps.
  const rnd = prng(`falling-words:pick:${q.seed}`)
  const list = Array.from({ length: q.count }, (_, k) => q.words[(k + Math.floor(rnd() * q.words.length)) % q.words.length])
  const capH = FONT * 0.73
  const words = list.map((w) => {
    const run = text.fit('semibold', w.toUpperCase(), FONT, 260, { letterSpacing: 0.4 })
    const bw = Math.ceil(run.advance) + 4
    const bh = Math.ceil(capH) + 6
    // Sprite centred on (cx, cy) = (bw / 2, bh / 2) in frame coordinates.
    const sprite = ctx.sprite([{ cmds: run.cmds(2, 3 + capH), color: ink }], { margin: 2 })
    return { bw, bh, sprite }
  })
  const sim = simulate(words.map((w) => [w.bw, w.bh]), q.seed)
  const n = words.length

  const transformAt = (f, k) => {
    const o = (f * n + k) * 3
    const x = sim.poses[o], y = sim.poses[o + 1], a = sim.poses[o + 2]
    const c = Math.cos(a), s = Math.sin(a)
    const { bw, bh } = words[k]
    const ox = bw / 2, oy = bh / 2
    return [c, s, -s, c, x - (c * ox - s * oy), y - (s * ox + c * oy)]
  }
  const visible = (f, k) => {
    const o = (f * n + k) * 3
    const r = Math.hypot(words[k].bw, words[k].bh) / 2
    return sim.poses[o + 1] > -r && sim.poses[o + 1] < H + r
  }


  // The first frame of each sleep epoch, where the baked layer reads its poses.
  const epochStart = []
  sim.epoch.forEach((e, f) => (epochStart[e] ??= f))

  const pop = (t) => {
    // back.out: a small overshoot.
    if (t <= 0) return 0
    if (t >= 1) return 1
    const k = 1.9
    const u = t - 1
    return 1 + (k + 1) * u * u * u + k * u * u
  }
  const clamp01 = (t) => Math.max(0, Math.min(1, t))
  const r3 = (v) => Math.round(v * 1000) / 1000

  return {
    state(i) {
      const t = i / FPS
      const dotK = r3(pop(clamp01((t - 0.05) / 0.35)))
      const pillK = r3(clamp01((t - 0.15) / 0.3))
      // Bodies asleep in this frame are baked into a layer (keyed by the sleep epoch); the rest
      // are drawn from the recording.
      const live = []
      if (t >= RAIN_AT) for (let k = 0; k < n; k++) if (!sim.asleep[i * n + k] && visible(i, k)) live.push(k)
      return { dotK, pillK, epoch: sim.epoch[i], sleepers: epochStart[sim.epoch[i]], live, frame: live.length ? i : -1 }
    },
    draw(g, s) {
      const settled = s.dotK >= 1 && s.pillK >= 1
      const centre = () => {
        if (s.dotK > 0) g.draw(dot, { transform: [s.dotK, 0, 0, s.dotK, (gx + dotR) * (1 - s.dotK), cy * (1 - s.dotK)] })
        if (s.pillK > 0) g.draw(pill, { opacity: s.pillK, transform: [1, 0, 0, 1, Math.round((1 - s.pillK) * -10), 0] })
      }
      g.layer(settled ? 'centre' : `centre${s.dotK},${s.pillK}`, () => {
        g.clear(0xffffff)
        centre()
      })
      // Sleepers are still, so any frame of this epoch gives the same picture.
      g.layer(`asleep${s.epoch}`, () => {
        const f = s.sleepers
        for (let k = 0; k < n; k++) if (sim.asleep[f * n + k] && visible(f, k)) g.draw(words[k].sprite, { transform: transformAt(f, k) })
      })
      for (const k of s.live) g.draw(words[k].sprite, { transform: transformAt(s.frame, k) })
    },
  }
}
