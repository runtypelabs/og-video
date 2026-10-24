# og-video verification map

This map is the maintained source for verifying what users of `streaming-og-video` get: MP4s,
posters and the Worker routes that serve them. Read this index, find the features your diff
touches, and use each feature file as the recipe. Keep it current with
`/maintain-verification-skill`.

## Baseline preconditions

- `npm ci` has run in the checkout, and `scripts/doctor.sh` exits 0.
- There is no seed data and no network. Every input is a URL param. `showcase.json` holds one
  non-default set per scenario, and its images are data URIs.
- Renders run in worktrees that `run.sh` creates. Never render "base" by checking out an old
  revision in your working tree.

## Driving conventions

- Drive through the public surfaces only: `sogv` (`src/node/cli.js`), the `streaming-og-video`
  and `/node` exports, and the Worker's HTTP routes. Don't call `src/engine/*` internals to make
  a proof pass.
- Name scenarios by id (`title-card`), not by export name (`titleCard`).
- Params are JSON to `sogv --params` and a query string to the Worker. Both validate through
  the same schema, so equal params give equal bytes.

## Proof and skip reporting

- Proof is a base/head comparison: bytes, the first differing frame, contact sheets, and the
  MP4 playing inline on the PR.
- A scenario you didn't render is reported as skipped, with the reason (for example "not in
  the import closure of any changed file").
- A render error or failed invariant gets posted, not retried away.

## Mapping a diff to what to verify

| Changed path | Verify |
| --- | --- |
| `src/scenarios/<id>.js` | [Scenarios](scenarios.md): that scenario, both param sets |
| `src/scenarios/showcase-kit.js`, `twemoji.json`, `src/gfx.js`, `src/text.js`, `src/pixelfont.js`, `src/physics.js`, `src/gsap.js`, `src/schema.js`, `src/scenario.js` | every scenario whose import closure includes it (`affected.mjs` computes this) |
| `src/engine/`, `src/node/`, `wasm/`, `fonts/`, `crates/`, `x264/`, `package-lock.json` | all scenarios, plus [Render and poster](render-and-poster.md) and [Prefix](prefix.md) |
| `src/params.js` | all scenarios (content ids) and [Worker routes](worker.md) (`?s=` packing, signatures) |
| `src/worker/` | [Worker routes](worker.md). No byte change is expected. |
| `src/node/cli.js` | [Render and poster](render-and-poster.md) for each `sogv` command touched |

## Features

- [Scenarios](scenarios.md): the nine built-in scenarios, what each one animates, and what
  the showcase params add.
- [Render and poster](render-and-poster.md): `sogv render`, `stills` and `bench`, plus the
  poster frame.
- [Prefix](prefix.md): the pre-encoded opening frames that let a video start instantly, and
  their contract.
- [Worker routes](worker.md): `.mp4`, `.png`, `.json`, share pages and byte ranges from
  `createHandler`.
