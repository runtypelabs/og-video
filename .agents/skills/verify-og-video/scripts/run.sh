#!/usr/bin/env bash
# Render evidence for a PR (or any two revisions), compare, and optionally post it.
#
#   run.sh --pr <n> [--post] [--notes notes.md] [--scenarios a,b | --scenarios all] [--runs 5]
#   run.sh --base <rev> --head <rev> [--scenarios ...]          # local, never posts
#
# Base is the merge base of the PR's base branch and its head, so main moving on doesn't show
# up as a change. Both revisions are checked out as detached worktrees under .verify/trees/ and
# removed on exit; the evidence stays in .verify/runs/<run>/. Prints the run directory last.
set -euo pipefail

SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(git rev-parse --show-toplevel)"
PR="" BASE="" HEAD="" POST=0 NOTES="" SCENARIOS="" RUNS=5
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --post) POST=1; shift ;;
    --notes) NOTES="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if [ -n "$PR" ]; then
  read -r BASE_REF HEAD HEAD_REF CROSS < <(gh pr view "$PR" --json baseRefName,headRefOid,headRefName,isCrossRepository \
    -q '"\(.baseRefName) \(.headRefOid) \(.headRefName) \(.isCrossRepository)"')
  # headRefOid (and refs/pull/<n>/head) lag a push by a few seconds; the branch itself doesn't.
  # Same-repo PRs read the branch tip so a run right after a push renders what was pushed.
  if [ "$CROSS" = false ]; then
    TIP="$(git -C "$ROOT" ls-remote origin "refs/heads/$HEAD_REF" | cut -f1)"
    if [ -n "$TIP" ] && [ "$TIP" != "$HEAD" ]; then
      echo "PR head not updated yet (${HEAD:0:7}); using the branch tip ${TIP:0:7}" >&2
      HEAD="$TIP"
    fi
    git -C "$ROOT" fetch -q origin "$BASE_REF" "refs/heads/$HEAD_REF"
  else
    git -C "$ROOT" fetch -q origin "$BASE_REF" "pull/$PR/head"
  fi
  BASE="$(git -C "$ROOT" merge-base "origin/$BASE_REF" "$HEAD")"
elif [ -z "$BASE" ] || [ -z "$HEAD" ]; then
  echo "usage: run.sh --pr <n> [--post] ... | --base <rev> --head <rev>" >&2
  exit 2
fi
BASE="$(git -C "$ROOT" rev-parse "$BASE^{commit}")"
HEAD="$(git -C "$ROOT" rev-parse "$HEAD^{commit}")"
[ "$POST" = 1 ] && [ -z "$PR" ] && { echo "--post needs --pr" >&2; exit 2; }

RUN="$ROOT/.verify/runs/$(date +%Y%m%d-%H%M%S)${PR:+-pr$PR}-${HEAD:0:7}"
mkdir -p "$RUN" "$ROOT/.verify/trees"
echo "base $BASE" >&2
echo "head $HEAD" >&2

(cd "$ROOT" && node "$SKILL/scripts/affected.mjs" --base "$BASE" --head "$HEAD") > "$RUN/affected.json"
if [ -z "$SCENARIOS" ]; then
  SCENARIOS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).scenarios.map((s) => s.id).join(","))' "$RUN/affected.json")"
fi
echo "scenarios: ${SCENARIOS:-none}" >&2

CREATED=()
cleanup() {
  for t in ${CREATED[@]+"${CREATED[@]}"}; do git -C "$ROOT" worktree remove --force "$t" 2>/dev/null || true; done
  git -C "$ROOT" worktree prune
}
trap cleanup EXIT

# Sets TREE to a detached worktree at <sha>, with node_modules: linked from this checkout when
# the lockfile matches, otherwise installed. Not run in a subshell, so CREATED reaches cleanup.
tree() {
  local sha="$1" dir="$ROOT/.verify/trees/$1"
  if [ ! -d "$dir" ]; then
    git -C "$ROOT" worktree add -q --detach "$dir" "$sha"
    CREATED+=("$dir")
  fi
  if [ ! -e "$dir/node_modules" ]; then
    if cmp -s "$dir/package-lock.json" "$ROOT/package-lock.json" && [ -d "$ROOT/node_modules" ]; then
      ln -s "$(cd "$ROOT/node_modules" && pwd -P)" "$dir/node_modules"
    else
      (cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund >&2)
    fi
  fi
  TREE="$dir"
}

if [ -n "$SCENARIOS" ]; then
  # Base first, then head, one at a time: bench numbers from overlapping renders mean nothing.
  for side in base head; do
    sha="$BASE"; [ "$side" = head ] && sha="$HEAD"
    tree "$sha"
    node "$SKILL/scripts/render.mjs" --checkout "$TREE" --out "$RUN/$side" --scenarios "$SCENARIOS" --runs "$RUNS"
  done
fi

status=0
node "$SKILL/scripts/compare.mjs" --run "$RUN" || status=$?
if [ "$POST" = 1 ]; then
  node "$SKILL/scripts/post.mjs" --pr "$PR" --run "$RUN" ${NOTES:+--notes "$NOTES"}
fi
echo "$RUN"
exit "$status"
