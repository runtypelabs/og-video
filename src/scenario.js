// defineScenario: the one interface a new video type implements.

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * @template P
 * @param {import('../types/index.js').ScenarioDefinition<P>} def
 * @returns {import('../types/index.js').Scenario<P>}
 */
export function defineScenario(def) {
  if (!ID.test(def.id ?? '')) throw new Error(`scenario id must match ${ID}: ${def.id}`)
  if (!def.params?.['~standard']) throw new Error(`${def.id}: params must be a schema (p.object(...) or any Standard Schema)`)
  if (typeof def.setup !== 'function') throw new Error(`${def.id}: setup(ctx, params) is required`)
  const video = { width: 1200, height: 630, fps: 30, frames: 210, ...def.video }
  if (video.width % 16 || video.height % 2) throw new Error(`${def.id}: width must be a multiple of 16 and height even`)
  const prefix = def.prefix ? { key: () => '', ...def.prefix } : { frames: 1, key: () => '' }
  if (!(prefix.frames >= 1 && prefix.frames < video.frames)) throw new Error(`${def.id}: prefix.frames must be in [1, ${video.frames})`)
  return {
    version: 1,
    fonts: {},
    poster: 'last',
    meta: () => ({}),
    ...def,
    video,
    prefix,
  }
}
