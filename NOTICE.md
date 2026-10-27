# Third-party components

The code in this repository is MIT licensed (see `LICENSE`), except for the components below,
which keep their own licenses.

| Component | Where | License |
|---|---|---|
| **x264** (H.264 encoder) | `wasm/x264.wasm`, built from `x264/` | **GPL-2.0-or-later**: see `x264/COPYING`. `x264/wrapper.c`, `x264/simd128.c`, `x264/simd128.patch` and `x264/check.c` are part of that build and are distributed under the same license. |
| Inter (typeface) | `fonts/Inter-*.ttf.bin` | SIL Open Font License 1.1: see `fonts/OFL.txt` |
| JetBrains Mono (typeface, Latin subset from Fontsource 5.3.0) | `fonts/JetBrainsMono-*.woff2.bin` | SIL Open Font License 1.1: see `fonts/OFL-JetBrainsMono.txt` |
| Twemoji graphics | `src/scenarios/twemoji.json` (converted outlines) | CC-BY 4.0, Copyright Twitter, Inc and other contributors: https://github.com/jdecked/twemoji |
| dithercn's Aurora field and noise helpers, ported from GLSL | `src/scenarios/dither.js` | MIT, Copyright (c) 2026 Leo (opencoredev): https://github.com/opencoredev/dithercn |
| tiny-skia | compiled into `wasm/ogfx.wasm` | BSD-3-Clause |
| fontkit, mp4-muxer | npm dependencies | MIT |
| GSAP | npm dependency, used by the built-in scenarios | GSAP Standard License: https://gsap.com/standard-license |

## What the x264 license means for you

`wasm/x264.wasm` is GPL-2.0-or-later. If you **distribute** a build that includes it (for
example, you ship a bundle containing it to someone else), you have to offer them the
corresponding source, which is `x264/` plus the x264 commit named in `x264/build.sh`.

Running it in your own Cloudflare Worker is not distribution under GPL-2.0, which has no network
clause.

The encoder sits behind a small interface (`src/engine/x264.js`). A permissively licensed H.264
encoder can replace it; see the roadmap in the README.

H.264 is also covered by patents. Via LA's AVC license currently charges no royalty for internet
video that is free to end users. Encoder licensing is a separate question. This is not legal
advice.
