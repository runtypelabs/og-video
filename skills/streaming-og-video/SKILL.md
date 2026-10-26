---
name: streaming-og-video
description: Build, debug, or deploy streaming-og-video: animated og:video link previews rendered in a Cloudflare Worker. Covers writing a new scenario, using the hosted og.video URLs, configuring createHandler (R2, KV, rate limits, signatures) and diagnosing slow, choppy or non-playing videos.
---

# streaming-og-video

streaming-og-video renders short MP4s (laid out at 1200x630 and rendered at 960x504 by default, 30 fps, 7 s) inside a Cloudflare Worker, with no browser, and streams them out faster than they play:
- a Rust/wasm compositor draws each frame;
- x264 (wasm) encodes it;
- the MP4 goes out as fragments while later frames are still rendering.

The first request for given params renders; every later request is served from cache (Cache API, then R2).

Use this skill to:
- add a video type (a **scenario**);
- make preview URLs for the hosted service (https://og.video) or a self-hosted Worker;
- wire up the Worker;
- debug output.

## The mental model (read this first)

1. **A scenario is a pure function of (params, frame index).**
   - `state(i)` returns plain data. It must give the same result whatever frame you start from: ranges of separate renders, cache keys and prefixes all depend on byte-identical output.
   - Never use `Math.random()` or `Date`. Seed any randomness from params.
2. **Rasterize once, compose per frame.**
   - In `setup(ctx, params)`, shape the text and build sprites and paths.
   - In `draw(g, state)`, only transform, fade, blur, mask or clip them.
   - Blur is cheap now (about 2 ms for a full frame), but the encoder is not: every frame where half the picture moves costs 1–2 ms in x264. For scenes like that, lower `video.fps` (the built-ins run at 60) or raise `video.qp`.
3. **Unchanged costs nothing.**
   - Frames whose state stringifies the same as the previous frame's are skipped entirely.
   - `g.layer(key, paint)` restores a cached backdrop with one memcpy while `key` is unchanged.
   - Only the 16x16 blocks that overlays touch are re-checked and re-encoded.
   - So: put everything that has finished animating into a layer keyed by "what has settled", and draw only what's moving.
4. **The prefix is the latency trick.**
   - Frames `[0, prefix.frames)` must depend only on `prefix.key(params)`. They're encoded once per key, cached, and sent before any rendering starts.
   - A long, param-independent opening (a logo reveal, a grid sweep) gives every later request a head start. Longer is safer under bursts.
   - Verify it with `sogv prefix`.
5. **Budget.**
   - A whole 7 s card should render in about 100–300 ms locally; the edge is 2–3x slower.
   - One render engine (~38 MB) per isolate. Concurrent renders queue, and under load live tails skip frames rather than stall. Skipped-frame renders are never cached.

## Workflow for a new scenario

1. Copy a built-in scenario as a starting point:
   - `title-card.js` (sprites, layers, GSAP) or `diagram.js` (items that bake as they settle);
   - `dot-matrix.js` (halftone dot fields that dissolve);
   - `falling-words.js` (physics precomputed in setup, rotated sprites, sleepers baked per epoch);
   - `gallery.js` (image params, whole-pixel scrolling that loops);
   - `terminal.js` and `pr.js` (monospace text, typing reveals; shared pieces in `code-kit.js`);
   - `race.js` (rank changes over time). See `references/authoring.md` for the full API.
2. Define `params` with `p.object({...})`. Bound every field, since params come from strangers' URLs. Give every field a default so the bare URL looks good.
3. Iterate with stills: `npx sogv stills path/to/scenario.js#name --params '{"title":"..."}' --at 0.5,2,4,last -o out/x`. Then look at the PNGs.
4. Render and time it:
   - `npx sogv render ... -o out/x.mp4 --png`
   - `npx sogv bench ... --runs 5`
5. Check the prefix: `npx sogv prefix ... --vary '[{"title":"Other"},{"title":"Longer title here"}]'`. It must print no `FAIL` lines.
6. Register the scenario in your Worker's `createHandler({ scenarios: [...] })`. Bump `version` whenever its output changes, which invalidates its cached renders.

## Using the hosted service (og.video)

- Video: `https://og.video/v1/<scenario>.mp4?<params>`
- Poster: `.png`
- Share page with og:video tags: no extension

Put the share page URL (or your own page with `og:video` pointing at the `.mp4`) where you want the preview. Params are query strings; arrays and objects go as JSON or packed:
- `GET /v1/<scenario>.json?<params>` shows the resolved params, the content id, and a packed `?s=` URL.
- `POST /v1/<scenario>` with a JSON body stores long params and returns a short `/v1/<scenario>/<id>.mp4`.

## Self-hosting

See `references/deploy.md`:
- wrangler config (R2 bucket, KV namespace, rate limit, secret);
- `createHandler` options;
- signed URLs with `videoUrl()`;
- the `onEvent` hook for analytics.

## Debugging

| Symptom | Likely cause and fix |
|---|---|
| `a frame must start with g.clear() or g.layer()` | `draw()` drew overlays with no backdrop. Start with a layer that clears, or call `g.clear()` first. |
| Visual trails or stale pixels | Something drawn in a layer changed but its key didn't. Include every input of the layer's paint function in its key. |
| Video is choppy | The render was degraded under load (`frames` < expected in events, `degraded: true`). It isn't cached, so the next request renders it fully. Lengthen the prefix if this happens often. |
| Slow first byte | No prefix yet for this `prefix.key`: the first request for a new key encodes it (~50–300 ms), then it's cached in R2 and memory. |
| `live encoder parameters differ from the prefix` | The frame size or encoder changed since a prefix was cached. Bump the scenario `version`. |
| iPhone won't play | iOS uses Range requests. Check `curl -H 'Range: bytes=0-1' -I` returns 206 with `content-range`. |
| `sogv prefix` FAIL | Something visible before `prefix.frames` depends on a param outside `prefix.key`. Delay it, or add that param to the key. |
| Same params, different bytes | Nondeterminism: random numbers, time, or iteration over unordered data in `setup`/`state`. |
