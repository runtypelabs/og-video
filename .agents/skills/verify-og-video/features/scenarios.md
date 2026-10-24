# Scenarios

Each built-in scenario turns URL params into a 7 s, 1200x630 MP4 and a poster. Users see the
animation, the colours and text they passed, and how the scenario's defaults look when they
pass nothing.

## Sub-features

| Id | fps / frames | Prefix | What to look for (contact sheet times) | Showcase adds |
| --- | --- | --- | --- | --- |
| `title-card` | 30 / 210 | 84 | grid reveal and pixel wordmark (0.5-1.5 s), wordmark flips into the header (~2.3 s), kicker types and title words blur in (3-4.5 s) | kicker, badge, footer, url, custom brand and accent |
| `diagram` | 30 / 210 | 11 | lanes unfold, edges draw, packets travel, stats count up | `graph` shorthand with 3 lanes, stats, tagline |
| `kinetic` | 30 / 210 | 18 | headline rises word by word; `*starred*` words get the accent highlight; still after ~3.2 s | `theme=light`, two starred words, `by` |
| `metric` | 30 / 210 | 18 | odometer number roll, trend line draws, delta pill | `light`, decimals, prefix/suffix, falling data, negative delta |
| `bars` | 30 / 210 | 15 | staggered bar growth with counting values, highlight, average line | `light`, `highlight=last`, `average=false`, unit |
| `release` | 30 / 210 | 21 | huge version numeral rises, items slide in with icon tiles | `light`, 5 items with explicit icons |
| `dot-matrix` | 30 / 210 | 12 | right panel icons dissolve in and out dot by dot | 3 other icons (scrape, chart, code), new accent |
| `falling-words` | 24 / 168 | 12 | words rain, pile up, floor drops at the end (poster is at 5.6 s) | custom words, count 60, seed 42 |
| `gallery` | 24 / 168 | 8 | endless thumbnail wall scrolling 5 px per frame | three image params (PNG, JPEG, WebP data URIs) |

## How to get to it (user POV)

- `npx sogv render <id> --params '<json>' -o out/<id>.mp4 --png`
- `GET /<id>.mp4?<params>` on a Worker built with `createHandler` (see [worker.md](worker.md)).
- Programmatically: `createNodeEngine()` then `engine.file(scenario, params)`.

## Driving it with run.sh

Preconditions:

- `doctor.sh` passes. For a PR, it's pushed and `gh pr view <n>` works.

- **Render the affected set.** Run `scripts/run.sh --pr <n>`. stderr lists each
  `<id>.<set>` with KB, bench ms and `checks ok`. Then it prints the status per item:
  `identical`, `changed, first diff at frame N`, `added` or `removed`.
- **Force one scenario.** Run `scripts/run.sh --pr <n> --scenarios kinetic`. Only kinetic's
  two sets render.
- **Every scenario.** Run `scripts/run.sh --pr <n> --scenarios all`, for a check unrelated to
  any diff (about 1-2 minutes).
- **Look before posting.** Open `<run>/head/<id>.<set>.sheet.png` and
  `<run>/compare/<id>.<set>.frame.png`. The sheet shows six moments. The compare image shows
  base on the left and head on the right.
- **Proof.** Run `scripts/run.sh --pr <n> --post --notes notes.md`. stdout ends with the
  comment URL. Then run `gh pr view <n> --comments` and check that the comment lists every
  affected scenario.

## Gotchas

- Unchanged bytes for a scenario you edited usually mean the edit is in a code path the
  default and showcase params don't reach. Add a showcase param rather than claiming
  "no change".
- `kinetic` and `dot-matrix` hold still for long stretches, so a change late in the timeline
  may show only in the 4.5 s, 6 s or last tile.
- `falling-words` posters are frame 134 (5.6 s), not the last frame.
