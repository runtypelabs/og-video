import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNodeEngine, parseParams } from '../src/node/index.js'
import { readPrefix } from '../src/engine/encode.js'
import * as builtins from '../src/scenarios/index.js'

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
