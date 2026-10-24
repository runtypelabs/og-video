import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNodeEngine, parseParams } from '../src/node/index.js'
import { readPrefix } from '../src/engine/encode.js'
import * as builtins from '../src/scenarios/index.js'
import { gallery } from '../src/scenarios/index.js'
import { createWorld } from '../src/physics.js'
import { readFile } from 'node:fs/promises'

const engine = await createNodeEngine()
const scenarios = Object.values(builtins).filter((s) => s && s.id)

for (const scenario of scenarios) {
  test(`${scenario.id}: renders are deterministic, and prefix + tail is the whole file`, async () => {
    const params = await parseParams(scenario, {})
    const prefix = await engine.prefix(scenario, params)
    assert.equal(prefix.frames, scenario.prefix.frames)
    const meta = readPrefix(prefix.bytes)
    assert.ok(meta.timescale > 0 && meta.trackId > 0 && meta.nextSeq > 1)
    const a = await engine.file(scenario, params, prefix)
    const b = await engine.file(scenario, params)
    assert.deepEqual(Buffer.from(a), Buffer.from(b))
    assert.deepEqual(Buffer.from(a.subarray(0, prefix.bytes.length)), Buffer.from(prefix.bytes))
  })

  test(`${scenario.id}: frames skipped under load still give a playable file`, async () => {
    const params = await parseParams(scenario, {})
    const prefix = await engine.prefix(scenario, params)
    const parts = []
    const r = await engine.tail(scenario, params, prefix, { write: (b) => parts.push(b), frameStep: () => 4 })
    assert.ok(r.skipped > 0)
    assert.ok(parts.length > 0)
  })

  test(`${scenario.id}: poster is a PNG of the frame size`, async () => {
    const png = await engine.poster(scenario, await parseParams(scenario, {}))
    assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71])
    const view = new DataView(png.buffer, png.byteOffset)
    assert.equal(view.getUint32(16), scenario.video.width)
    assert.equal(view.getUint32(20), scenario.video.height)
  })
}

// ---------------------------------------------------------------- image params

const fixtures = {
  'https://img.test/photo.jpg': 'photo.jpg',
  'https://img.test/mandel.png': 'mandel.png',
  'https://img.test/grad.webp': 'grad.webp',
}
const fetched = []
const imageEngine = await createNodeEngine({
  images: {
    fetch: async (url) => {
      fetched.push(url)
      if (!fixtures[url]) throw new Error('not found')
      return readFile(new URL(`./fixtures/${fixtures[url]}`, import.meta.url))
    },
  },
})

test('gallery: image params (JPEG, PNG, WebP) render deterministically, prefix first', async () => {
  const params = await parseParams(gallery, { images: Object.keys(fixtures) })
  const assets = await imageEngine.assets(gallery, params)
  assert.deepEqual(assets.missing, [])
  const prefix = await imageEngine.prefix(gallery, params, { assets })
  const a = await imageEngine.file(gallery, params, prefix, { assets })
  const b = await imageEngine.file(gallery, params)
  assert.deepEqual(Buffer.from(a), Buffer.from(b))
  assert.deepEqual(Buffer.from(a.subarray(0, prefix.bytes.length)), Buffer.from(prefix.bytes))
  // Fetched once per URL: later renders use the isolate's cache.
  assert.equal(fetched.filter((u) => u.endsWith('photo.jpg')).length, 1)
  // The images change the frames.
  const plain = await engine.file(gallery, await parseParams(gallery, {}))
  assert.notDeepEqual(Buffer.from(a), Buffer.from(plain))
})

test('gallery: an image that fails to load is reported missing, and the render still completes', async () => {
  const params = await parseParams(gallery, { images: ['https://img.test/photo.jpg', 'https://img.test/nope.png'] })
  const assets = await imageEngine.assets(gallery, params)
  assert.deepEqual(assets.missing, ['https://img.test/nope.png'])
  const png = await imageEngine.poster(gallery, params, 30, { assets })
  assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71])
})

test('images: bytes that are not an image are missing, not an error', async () => {
  const params = await parseParams(gallery, { images: ['data:image/png;base64,aGVsbG8gd29ybGQ='] })
  const png = await engine.poster(gallery, params, 30)
  assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71])
})

// ---------------------------------------------------------------- physics

test('physics: two runs of the same world give identical poses', async () => {
  const run = () => {
    const w = createWorld()
    w.box({ x: 300, y: 660, w: 1000, h: 60, density: 0 })
    for (let k = 0; k < 40; k++) w.box({ x: 100 + ((k * 37) % 400), y: -k * 30, w: 60 + (k % 5) * 10, h: 16, angle: k * 0.3 })
    const out = []
    for (let f = 0; f < 120; f++) {
      w.step(1 / 120)
      for (const b of w.bodies) out.push(b.x, b.y, b.angle)
    }
    return { out, asleep: w.bodies.filter((b) => b.asleep).length }
  }
  const a = run()
  const b = run()
  assert.deepEqual(a.out, b.out)
  assert.ok(a.out.every(Number.isFinite))
})
