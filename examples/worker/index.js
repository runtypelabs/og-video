// A complete Worker: the built-in scenarios, cached in R2 and the edge cache, with stored params
// in KV. Run it with `npm run dev`; deploy with `npx wrangler deploy -c examples/worker/wrangler.jsonc`.
import { createHandler, kvStore } from 'streaming-og-video/worker'
import { titleCard, diagram } from 'streaming-og-video/scenarios'

export default createHandler({
  scenarios: [titleCard, diagram],
  bucket: 'RENDERS',
  store: kvStore({ kv: 'STATE', r2: 'RENDERS' }),
  // Unsigned params are fine for a public demo; set a secret and drop this line to require &sig=.
  signatures: 'off',
  writes: 'public',
  rateLimit: 'RENDER_LIMIT',
  // An AV1 variant at 120 fps (/:scenario.av1.mp4), offered to browsers that decode it in hardware.
  av1: true,
  siteName: 'streaming-og-video',
})
