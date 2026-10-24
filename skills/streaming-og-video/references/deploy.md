# Deploying on Cloudflare

## Bindings

| Binding | Cloudflare primitive | Why |
|---|---|---|
| `bucket` (R2) | R2 bucket | Rendered MP4s, posters and prefixes, global and durable. Strongly consistent, so it also backs stored params right after a write. |
| (built in) | Cache API | A per-location copy in front of R2, so hot videos cost about 2 ms. |
| `store: kvStore({ kv, r2 })` | Workers KV (+ R2 fallback) | Stored params for `/:scenario/:id`. KV reads are fast at the edge; R2 covers KV's ~60 s propagation gap. |
| `rateLimit` | Rate Limiting binding | Per-IP limit on cache misses (renders) and public writes. |
| `secret` | Secret (`wrangler secret put`) | HMAC key for `&sig=` and the bearer token for writes. |

```jsonc
// wrangler.jsonc
{
  "name": "my-og-video",
  "main": "src/index.js",
  "compatibility_date": "2026-10-01",
  "limits": { "cpu_ms": 30000 },
  "r2_buckets": [{ "binding": "RENDERS", "bucket_name": "my-og-video" }],
  "kv_namespaces": [{ "binding": "STATE", "id": "…" }],
  "ratelimits": [{ "name": "RENDER_LIMIT", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } }]
}
```

```js
// src/index.js
import { createHandler, kvStore } from 'streaming-og-video/worker'
import { titleCard } from 'streaming-og-video/scenarios'
import { myCard } from './my-card.js'

export default createHandler({
  scenarios: [titleCard, myCard],
  bucket: 'RENDERS',
  store: kvStore({ kv: 'STATE', r2: 'RENDERS' }),
  secret: 'OGV_SECRET',          // signatures required by default once a secret is set
  rateLimit: 'RENDER_LIMIT',
  onEvent: (event, { env }) => {
    // e.g. env.ANALYTICS.writeDataPoint({ blobs: [event.type, event.scenario, event.cache], doubles: [event.bytes ?? 0] })
  },
})
```

Wasm and fonts load through wrangler's default module rules (`.wasm` and `.bin`), so you don't need any `rules` config.

## Signed URLs

With a secret, inline params need `&sig=`. Mint URLs on your server:

```js
import { videoUrl } from 'streaming-og-video/worker'
const { video, image, page } = await videoUrl('https://og.example.com', titleCard, { title: 'Launch' }, { secret })
```

The signature covers the validated params, so key order and spelling (`#F0A` vs `#ff00aa`) don't matter.

## Stored params

- `POST /:scenario` with a JSON body (bearer token, or anyone if `writes: 'public'`) returns `{ id, video, image, page }`. The id is a content hash, so posting the same params twice gives the same id. Add `?warm` to render it right away.
- `PUT /:scenario/:name` (token) stores mutable params under a readable name. Each edit renders a new video, because cache keys use the params' content hash.

## Caching and invalidation

Render cache key: `ENGINE_VERSION / scenario.id / scenario.version / contentId(params)`.

To invalidate a scenario's renders, bump `version`. Old objects can be expired with an R2 lifecycle rule on the `renders/` prefix.

## Request path

1. Cache API hit: about 2 ms, served with `content-length`, and Range is sliced in memory.
2. R2 hit: streamed, and copied into the Cache API in the background.
3. Miss:
   - The prefix (memory → R2 → encoded now) is written first.
   - The live tail is rendered and streamed one fragment per frame.
   - When no frames were skipped, the full file goes to R2 and the Cache API.
   - A Range or HEAD request on a miss renders the whole file first. That's still deterministic, so its bytes match the cached file.

## Events

`onEvent(event, { request, env, ctx })` runs once per request. For a streamed render it runs after the stream finishes.

Fields:
- `type`, `scenario`, `status`;
- `cache` (edge, r2, miss);
- `source` (inline, stored, named);
- `prefix` (memory, r2, built);
- `bytes`, `frames`, `degraded`, `queued`, `ms`, `error`.

Write them to Workers Analytics Engine, Logpush or anything else.
