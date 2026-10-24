// Stored params ("state"): what `/:scenario/:id.mp4` renders. Two kinds of id share one key space:
//   content ids  hash(scenario, params), minted by POST; immutable, so caches can hold them forever
//   names        chosen by the writer (PUT /:scenario/:name); mutable
//
// Workers KV is the read path (fast, cached at the edge) but eventually consistent: a key written
// in one location can read as missing elsewhere for about a minute, and KV caches that miss. So
// every write also goes to R2 (strongly consistent), and a KV miss falls back to one R2 read,
// which repopulates KV. A link minted a second ago works everywhere.

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Whether `id` is acceptable as a name (content ids are 22 base64url characters). */
export const isName = (id) => NAME.test(id) && id.length !== 22

const key = (scenario, id) => `state/${scenario}/${id}`

/**
 * @param {{ kv?: string, r2?: string }} bindings binding names: a KV namespace and/or an R2
 *   bucket. Either alone works; both is the recommended setup.
 */
export function kvStore({ kv, r2 } = {}) {
  if (!kv && !r2) throw new Error('kvStore needs a KV namespace and/or an R2 bucket binding name')
  return {
    async get(env, ctx, scenario, id, { mutable = false } = {}) {
      const k = key(scenario, id)
      if (kv) {
        // Content ids never change, so the edge may cache them for a day; names for 30 s (the minimum).
        const hit = await env[kv].get(k, { type: 'json', cacheTtl: mutable ? 30 : 86400 })
        if (hit) return hit
      }
      if (r2) {
        const obj = await env[r2].get(`${k}.json`)
        if (!obj) return null
        const value = await obj.json()
        if (kv) ctx.waitUntil(env[kv].put(k, JSON.stringify(value)).catch(() => {}))
        return value
      }
      return null
    },
    async put(env, scenario, id, value) {
      const body = JSON.stringify(value)
      await Promise.all([
        r2 && env[r2].put(`${key(scenario, id)}.json`, body, { httpMetadata: { contentType: 'application/json' } }),
        kv && env[kv].put(key(scenario, id), body),
      ])
    },
  }
}
