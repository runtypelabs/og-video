import { test } from 'node:test'
import assert from 'node:assert/strict'
import { p, validate, ParamError, imageUrls } from '../src/schema.js'
import { canonical, contentId, pack, unpack, sign, verify, rawParams } from '../src/params.js'

const schema = p.object({
  title: p.string({ max: 20, default: 'Hi' }),
  n: p.int({ min: 0, max: 9, default: 1 }),
  accent: p.color({ default: '#3b82f6' }),
  on: p.bool({ default: false }),
  tags: p.array(p.string({ max: 5 }), { max: 2, default: [] }),
})

test('defaults, coercion and bounds', async () => {
  assert.deepEqual(await validate(schema, {}), { title: 'Hi', n: 1, accent: '#3b82f6', on: false, tags: [] })
  assert.deepEqual(await validate(schema, { n: '3', accent: 'F0A', on: 'yes', tags: '["a"]' }), { title: 'Hi', n: 3, accent: '#ff00aa', on: true, tags: ['a'] })
  await assert.rejects(validate(schema, { n: '12' }), ParamError)
  await assert.rejects(validate(schema, { title: 'x'.repeat(21) }), /title: at most 20/)
  await assert.rejects(validate(schema, { tags: ['a', 'b', 'c'] }), /tags: at most 2 items/)
})

test('unknown and reserved query keys never reach the params', async () => {
  const raw = await rawParams(new URL('https://x/s.mp4?title=Yo&utm_source=t&sig=abc'), schema)
  assert.deepEqual(raw, { title: 'Yo' })
})

test('canonical JSON and content ids ignore key order', async () => {
  assert.equal(canonical({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}')
  assert.equal(await contentId('s', { a: 1, b: 2 }), await contentId('s', { b: 2, a: 1 }))
  assert.notEqual(await contentId('s', { a: 1 }), await contentId('t', { a: 1 }))
  assert.equal((await contentId('s', {})).length, 22)
})

test('pack round-trips and query + packed merge', async () => {
  const value = { title: 'Packed', tags: ['x'] }
  const s = await pack(value)
  assert.deepEqual(await unpack(s), value)
  const raw = await rawParams(new URL(`https://x/s.mp4?s=${s}&title=Override`), schema)
  assert.deepEqual(raw, { title: 'Override', tags: ['x'] })
})

test('signatures cover the validated params, however the URL spelled them', async () => {
  const a = await validate(schema, { accent: 'f0a', n: '2' })
  const b = await validate(schema, { n: 2, accent: '#FF00AA' })
  const sig = await sign('secret', 'card', a)
  assert.equal(sig.length, 22)
  assert.ok(await verify('secret', 'card', b, sig))
  assert.ok(!(await verify('other', 'card', b, sig)))
  assert.ok(!(await verify('secret', 'card', { ...b, n: 3 }, sig)))
  assert.ok(!(await verify('secret', 'card', b, null)))
})

test('an explicit empty string clears a string field; other kinds treat it as missing', async () => {
  const s = p.object({ kicker: p.string({ default: 'New' }), n: p.int({ default: 3 }) })
  assert.deepEqual(await validate(s, { kicker: '', n: '' }), { kicker: '', n: 3 })
})

test('p.image: http(s) URLs and base64 data:image URIs only; imageUrls finds them all', async () => {
  const s = p.object({ hero: p.image({ optional: true }), wall: p.array(p.image(), { max: 3, default: [] }), title: p.string({ default: '' }) })
  const v = await validate(s, { hero: 'https://example.com/a.png', wall: '["http://example.com/b.jpg","data:image/png;base64,iVBORw0KGgo="]' })
  assert.equal(v.hero, 'https://example.com/a.png')
  assert.deepEqual(imageUrls(s, v), ['https://example.com/a.png', 'http://example.com/b.jpg', 'data:image/png;base64,iVBORw0KGgo='])
  await assert.rejects(validate(s, { hero: 'file:///etc/passwd' }), /hero: expected an http\(s\) URL/)
  await assert.rejects(validate(s, { hero: 'javascript:alert(1)' }), ParamError)
  await assert.rejects(validate(s, { hero: 'data:text/html;base64,PGI+' }), ParamError)
  await assert.rejects(validate(s, { hero: `https://example.com/${'x'.repeat(2048)}` }), /at most 2048/)
})
