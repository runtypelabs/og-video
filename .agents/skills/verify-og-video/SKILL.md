---
name: verify-og-video
description: "Render the og:video scenarios that a streaming-og-video change touches, at the PR's base and head, and post the evidence as one PR comment: inline MP4 players, posters, contact sheets, side-by-side frames where bytes changed, sogv bench timings and the determinism, prefix and cache-version invariants. Use after any change to src/, wasm/, fonts/, crates/ or x264/, again after every push to that PR, or when asked to verify, render or compare scenarios."
---

# Verify og-video

Proves a change to the library the way its users see it: as the MP4 and poster a scenario
renders. Renders are deterministic, so the strongest evidence is a byte comparison. Identical
bytes at base and head mean nothing visible changed. Changed bytes come with the frames side by
side. Everything lives in `scripts/`. Paths below are relative to the repo root.

## When to run

- **Every push to a PR that can change rendered bytes:** `src/` (except `src/worker/`),
  `wasm/`, `fonts/`, `crates/`, `x264/`, `package-lock.json`. Each run rewrites the same comment.
- **Worker-only changes** (`src/worker/`) don't change bytes. Drive the routes instead
  ([features/worker.md](features/worker.md)) and say so in the PR body.
- **Skip** README, docs, `test/`, `skills/` and `.agents/` changes. With nothing affected, the
  script still posts a short "no scenario affected" run if you pass `--post`.

## Launch

There is no server. A run builds two detached worktrees under `.verify/trees/`: the PR's merge
base and its head. If a tree's `package-lock.json` matches this checkout's, it links this
checkout's `node_modules`; otherwise it runs `npm ci`. The run imports the library from each
tree, so the scripts always come from *this* checkout, even when the base predates the skill.
The trees are removed when the run exits.

Needs: Node 20+, `npm ci` done here, ffmpeg with an h264 decoder, and `gh` 2.99+ logged in with
write access to the repo.

## Doctor

```bash
.agents/skills/verify-og-video/scripts/doctor.sh [--pr <n>]
```

This check is read-only. It confirms this is the streaming-og-video checkout, and checks Node,
`node_modules`, the wasm and fonts, and that ffmpeg decodes h264. It renders title-card twice in
two processes and confirms the bytes match. It checks the gh version, and confirms you have the
write permission that attachments need. It also reports leftover worktrees. Run it first, and
again whenever a run fails oddly.

## Drive: one command per PR

```bash
.agents/skills/verify-og-video/scripts/run.sh --pr <n>            # render + compare, no posting
.agents/skills/verify-og-video/scripts/run.sh --pr <n> --post --notes notes.md
.agents/skills/verify-og-video/scripts/run.sh --base origin/main --head HEAD   # local, unpushed
```

The run steps through the stages below in order. It prints the run directory last. It exits 1
if an invariant failed, and it still posts in that case.

1. **Affected scenarios.** `scripts/affected.mjs --base <rev> --head <rev>` walks each
   scenario's static import closure under `src/` at both revisions. A changed file in a
   scenario's closure affects that scenario; `showcase-kit.js`, for example, affects kinetic,
   metric, bars and release. The engine, the Node entry, wasm, fonts, crates, x264 and the
   lockfile affect all of them. It also warns when `crates/ogfx` changed but
   `wasm/ogfx.wasm` did not, because renders use the committed wasm. Override the set with
   `--scenarios a,b` or `--scenarios all`.
2. **Render each side.** `scripts/render.mjs --checkout <tree> --out <run>/<base|head>
   --scenarios <ids>` renders the base first, then the head, never in parallel, since the bench
   numbers depend on it. Each scenario gets two param sets: `default` (`{}`) and `showcase`
   (its entry in [`showcase.json`](showcase.json), which hits paths the defaults skip). Per
   set it writes:
   - `.mp4`: the whole file.
   - `.png`: the poster (`engine.poster`, which is what `og:image` serves).
   - `.sheet.png`: a 3x2 contact sheet of frames at 0.5, 1.5, 3, 4.5 and 6 s plus the last
     frame, decoded from the MP4.
   - `.md5`: the ffmpeg framemd5.

   It also records `sogv bench` (median and min ms), size and sha256 in `manifest.json`.
3. **Compare.** `scripts/compare.mjs --run <run>` writes `report.json`. For each changed render
   it finds the first frame whose decoded pixels differ and the number of frames that differ.
   It writes `compare/<id>.<set>.frame.png` (base and head side by side at that frame) and
   `compare/<id>.<set>.diff.png` (the difference of the contact sheets, amplified 4x).
4. **Post.** `scripts/post.mjs --pr <n> --run <run> [--notes f] [--dry-run]` uploads the files
   as GitHub attachments and upserts the comment that starts with `<!-- verify-og-video -->`.
   `--dry-run` prints the Markdown with local paths and uploads nothing.

The stages also run on their own, which is how you re-post a run or compare by hand.

### Invariants checked on every render

| Check | Meaning | Fails when |
| --- | --- | --- |
| `deterministic` | the prefix path, a fresh in-process render and `sogv render` in a separate process give identical bytes | any of the three differ |
| `prefixIsStart` | the prefix's bytes are the first bytes of the file | the streamed prefix and the cached file diverge |
| `posterIsPng` | the poster is a PNG of the video's size | the poster's signature or size is wrong |
| cache key | bytes that changed under the same content id came with a new `ENGINE_VERSION` (`src/engine/engine.js`) or scenario `version` | caches would keep serving the old video |

A changed render whose content id also changed doesn't need a bump. A new default param, for
example, produces a new cache key on its own. The comment labels each change: `version bumped`,
`params changed`, or `NOT bumped`. `NOT bumped` is a failure.

### Notes for the reviewer

```bash
cat > notes.md <<'EOF'
**What changed:** kinetic's highlight block now wipes in from the left.
**Expect:** kinetic changed from ~1.4 s on; every other scenario identical. kinetic.version 1 -> 2.
EOF
```

Say what should have changed and what should not have changed. The table then confirms or
contradicts you. Don't claim a frame or state that the run didn't capture.

## Evidence and the PR comment

Evidence stays in `.verify/runs/<timestamp>-pr<n>-<head7>/` (gitignored). That covers both
sides' MP4s, PNGs, sheets, manifests, `report.json`, the posted `comment.md` and `uploads.json`
(the attachment URLs).

The comment holds, in order:
1. A header with base and head SHAs and `ENGINE_VERSION`.
2. Your notes, the affected set and why, warnings, and the invariant result.
3. A summary table: status per scenario and set, size and `sogv bench` median at base and head,
   and the checks.
4. For each changed render:
   - the first differing frame side by side;
   - base and head contact sheets and posters in a two-column table;
   - the diff, folded;
   - the head MP4 as an inline player, with the base MP4 folded.
5. For each unchanged render, folded: sha256, the contact sheet, the poster and the MP4.

Up to 3 earlier runs fold under "Earlier runs". If the PR head moved after the run, a caution
banner says the evidence is stale.

**Why GitHub attachments.** `gh` 2.99+ uploads images and videos as attachments with the token
`gh auth login` already holds (`gh pr comment --attach`). Attachments have several advantages:
- MP4s render as real inline players, which raw or release URLs never do. A video plays only
  when its URL sits alone in its paragraph.
- Images render inline.
- Nothing is written to the repo: no evidence branch, tag or release on a public npm library.

The catch is that `--attach` can only create a comment or edit your *last* one, and it can't
update a marked comment by id. So `post.mjs` makes the same upload request gh makes:
`POST https://uploads.github.com/user-attachments/assets?name&content_type&repository_id`
through `gh api`, as in cli/cli `internal/attachments/client.go`. It then PATCHes the comment
by id. Uploads are cached per run in `uploads.json`, so re-posting doesn't upload again. Limits:
10 MB per image, and 10 MB per video on free plans (100 MB on paid plans). These MP4s are
0.1-1 MB.

**If uploads fail** (the endpoint changes, or a 404 means the token can't write):
1. Run `post.mjs --dry-run > comment.md` from inside the run directory. It writes paths
   relative to the run, which `--attach` resolves against the body file's directory.
2. Delete the old marker comment.
3. Run `gh pr comment <n> --body-file comment.md --attach <each file>` (up to 50 files). gh
   rewrites every `./path` it uploads.

That fallback is still one comment per PR, but it's a new comment on each run.

## Proof standards

- Compare base and head. Don't post a head render alone. Identical bytes are the proof that
  nothing changed, and only a comparison can show a regression.
- Render both param sets. A change can hide behind defaults: `theme=light`, starred words,
  images and the graph shorthand only run with showcase params.
- A failed invariant or render error gets posted as is and called out in your notes. Don't
  rerun until it's green, and don't drop the scenario from `--scenarios`.
- When you add a scenario or a param that changes behaviour, extend `showcase.json` so the
  next run covers it.

## Cleanup

```bash
.agents/skills/verify-og-video/scripts/cleanup.sh
```

`run.sh` removes its own worktrees on exit. `cleanup.sh` removes any left under `.verify/trees/`
by a killed run, and only those. Evidence in `.verify/runs/` is kept. Delete it by hand when
you no longer need it; the posted attachments don't depend on it.

## Gotchas

- `sogv bench` timings are machine- and load-dependent. Compare base with head from the same
  run, never across runs, and treat differences under ~10% as noise.
- The encoder drops unchanged frames, so an MP4 decodes to fewer frames than the scenario has.
  Sheets and frame comparisons resample to the scenario's fps first, which holds the dropped
  frames as a player would. Don't pick frames with a raw `select=eq(n,…)`.
- For a few seconds after a push, `gh pr view`'s `headRefOid` and `refs/pull/<n>/head` still
  point at the old commit. For same-repo PRs, `run.sh` reads the branch tip with
  `git ls-remote` and says so when the two disagree. For fork PRs, wait about 10 s after the
  push. Check the head SHA in the run header against what you pushed.
- Base is the merge base, not `origin/main`'s tip, so commits that landed on main after the
  branch point don't show up as changes.
- A Rust change without a rebuilt `wasm/ogfx.wasm` renders identically. That's the warning in
  the comment, not proof that the change does nothing.
- `showcase.json` images are data URIs, so the gallery's image path renders without the
  network. Don't put http(s) URLs there: a failed fetch renders without the image.
- If base lacks a scenario, the comment shows it as `added`, with no comparison.
- The comment edits are yours: they're made with your `gh` token and show your name.
