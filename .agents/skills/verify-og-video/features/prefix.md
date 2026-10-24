# Prefix

A scenario's opening frames depend only on a few params (its prefix key). They are encoded once
per key and written before the live tail renders, so players start instantly. Users see this
as a video that starts at once on a cold request. They would see a broken or glitchy video if
the prefix and the tail disagreed.

## Sub-features

- `prefix-start`: the prefix bytes are the first bytes of the whole file.
- `prefix-contract`: frames `[0, prefix.frames)` are identical for any two param sets with the
  same `prefix.key`.

## How to get to it (user POV)

- Any cold `GET /<id>.mp4` on the Worker streams the prefix first.
- `npx sogv prefix <id> --params '<json>' --vary '[<json>, …]'` checks the contract.

## Driving it with sogv and run.sh

Preconditions:

- `doctor.sh` passes.

- **Prefix is the start.** Every `render.mjs` render checks it. In
  `<run>/<side>/manifest.json`, each entry has `checks.prefixIsStart: true` and `prefixBytes`.
- **Contract, same key.** Vary a param outside the key. For title-card, run
  `node src/node/cli.js prefix title-card --params '{"title":"A"}' --vary '[{"title":"B"},{"kicker":"New"}]'`.
  It prints `ok` for each variant, `prefix: 84 frames (2.80 s), … KB, key "OG VIDEO|#3b82f6"`,
  and exits 0.
- **Contract, different key.** Run `--vary '[{"accent":"#ff0000"}]'`. It prints
  `ok … (different prefix key)`.
- **Proof.** For a PR that touches a scenario's opening or its `prefix` declaration, paste the
  `sogv prefix` output into the notes. A changed render whose first differing frame is below
  `prefix.frames` with unchanged key params means the prefix changed, which needs a version bump.

## Gotchas

- The contract check hashes every 7th byte of each RGBA frame. It catches visible changes, not
  single-pixel ones.
- A prefix whose key omits a param the opening frames read passes `prefixIsStart`, but
  `sogv prefix --vary` fails it with `FAIL … same prefix key, but frame N differs`.
