# Render and poster

`sogv` renders any scenario locally into the same MP4 and PNG poster the Worker serves. Authors
use it to iterate, and `bench` tells them whether a scene stays faster than realtime.

## Sub-features

- `render` writes the MP4, and the poster with `--png`.
- `stills` writes PNGs of chosen frames (`--at 0.5,1,last`).
- `bench` reports the median and min ms per whole render over `--runs`.
- `poster` is the frame `og:image` uses (`scenario.poster`, the last frame by default).

## How to get to it (user POV)

- `npx sogv render <id|path.js#export> [--params json] [-o file] [--png]`
- `npx sogv stills <id> [--at list] [-o dir]`
- `npx sogv bench <id> [--params json] [--runs n]`
- In this repo, `node src/node/cli.js …` is the same binary.

## Driving it with sogv

Preconditions:

- Run from the repo root with `node_modules` installed.

- **Render.** Run `node src/node/cli.js render title-card -o .verify/scratch/tc.mp4 --png`.
  It prints `…: 358 KB, 210 frames; prefix 84 frames in … ms, whole file … ms` and the PNG
  path, and exits 0.
- **Determinism across processes.** Render again to `tc2.mp4`. `cmp` on the two files prints
  nothing. `render.mjs` does this for every render (`deterministic`).
- **Stills.** Run `node src/node/cli.js stills kinetic --at 0.5,1.5,last -o .verify/scratch/k`.
  It writes three PNGs named by frame index (`015.png`, `045.png`, `209.png`).
- **Bench.** Run `node src/node/cli.js bench gallery --runs 5`. It prints
  `gallery: median N ms, min M ms over 5 renders (7 s of video)`. `render.mjs` parses this line.
- **Proof.** The PR comment shows each poster under the head contact sheet, and the size and
  bench for base and head in the summary table.

## Gotchas

- `bench` renders without a prefix (`engine.file(scenario, params)`), so its time is the whole
  file. `render` prints the prefix and tail times separately.
- `stills` and the poster come from the compositor (RGBA to PNG), not from the H.264 decode.
  Contact sheets are decoded from the MP4, so they show encoder artifacts.
- `--params` is validated: an unknown enum value or a too-long string exits non-zero with a
  `ParamError`.
