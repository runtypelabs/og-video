import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeEngine, parseParams } from '../src/node/index.js'
import { atFps, av1Codec, readSequenceHeader } from '../src/engine/av1.js'
import { bars, kinetic, fallingWords } from '../src/scenarios/index.js'

const engine = await createNodeEngine()
const dir = mkdtempSync(join(tmpdir(), 'sogv-av1-'))
const has = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Top-level MP4 boxes: [type, offset, size]. */
function boxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []
  for (let o = 0; o < bytes.length; ) {
    const size = view.getUint32(o)
    out.push([String.fromCharCode(...bytes.subarray(o + 4, o + 8)), o, size])
    assert.ok(size >= 8, 'box size')
    o += size
  }
  return out
}

const renders = new Map()
const render = async (scenario, fps) => {
  const key = `${scenario.id}@${fps}`
  if (!renders.has(key)) renders.set(key, engine.av1(scenario, await parseParams(scenario, {}), { fps }))
  return renders.get(key)
}

test('atFps keeps the duration and scales frames and the prefix', () => {
  const k = atFps(kinetic, 120)
  assert.equal(k.video.fps, 120)
  assert.equal(k.video.frames / k.video.fps, kinetic.video.frames / kinetic.video.fps)
  assert.equal(k.prefix.frames, kinetic.prefix.frames * 4)
  assert.equal(atFps(kinetic, kinetic.video.fps), kinetic)
})

for (const [scenario, fps] of [[bars, 120], [kinetic, 120], [fallingWords, 30]]) {
  test(`${scenario.id} AV1 at ${fps} fps: deterministic, progressive MP4, codec string known up front`, async () => {
    const a = await render(scenario, fps)
    const b = await engine.av1(scenario, await parseParams(scenario, {}), { fps })
    assert.deepEqual(Buffer.from(a.bytes), Buffer.from(b.bytes))
    assert.equal(a.fps, fps)
    assert.equal(a.frames, Math.round((scenario.video.frames * fps) / scenario.video.fps))
    assert.ok(a.encoded > 1 && a.encoded <= a.frames)
    assert.deepEqual(boxes(a.bytes).map(([t]) => t), ['ftyp', 'moov', 'mdat'])
    assert.equal(a.codec, av1Codec(scenario.video.width, scenario.video.height, fps))
    const at = Buffer.from(a.bytes).indexOf('av1C')
    assert.equal(a.bytes[at + 4], 0x81)
    const { profile, level } = readSequenceHeader(a.bytes.subarray(at + 8))
    assert.equal(profile, 0)
    assert.equal(a.bytes[at + 5], (profile << 5) | level)
  })
}

test('codec strings for 1200x630', () => {
  assert.equal(av1Codec(1200, 630, 30), 'av01.0.05M.08')
  assert.equal(av1Codec(1200, 630, 60), 'av01.0.08M.08')
  assert.equal(av1Codec(1200, 630, 120), 'av01.0.09M.08')
})

test('ffprobe reads it as 120 fps AV1 and ffmpeg decodes every frame', { skip: !has('ffprobe', ['-version']) && 'no ffprobe' }, async () => {
  const r = await render(kinetic, 120)
  const file = join(dir, 'kinetic.av1.mp4')
  writeFileSync(file, r.bytes)
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', file], { encoding: 'utf8' }))
  const s = probe.streams[0]
  assert.equal(s.codec_name, 'av1')
  assert.equal(s.profile, 'Main')
  assert.equal(s.width, 1200)
  assert.equal(s.height, 630)
  assert.equal(s.r_frame_rate, '120/1')
  assert.equal(s.color_primaries, 'bt709')
  assert.equal(Number(s.nb_read_frames), r.encoded)
  assert.equal(Number(probe.format.duration), 7)
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'])
})

test('AVFoundation (Safari) plays it and decodes every frame', { skip: (process.platform !== 'darwin' || !has('swift', ['--version'])) && 'macOS only' }, async () => {
  const r = await render(kinetic, 120)
  const file = join(dir, 'kinetic-av.av1.mp4')
  writeFileSync(file, r.bytes)
  const out = execFileSync('swift', [new URL('../scripts/avcheck.swift', import.meta.url).pathname, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  assert.match(out, /playable=true codec=av01 size=1200x630 duration=7\.000s/)
  assert.match(out, new RegExp(`decodedFrames=${r.encoded} reader=completed`))
})
