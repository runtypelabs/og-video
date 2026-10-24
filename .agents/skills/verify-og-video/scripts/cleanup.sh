#!/usr/bin/env bash
# Remove the worktrees run.sh checks out under .verify/trees/ (left behind only if a run was
# killed). Never touches .verify/runs/: that is the evidence. Only removes worktrees under
# .verify/trees, never other worktrees of the repo.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
git -C "$ROOT" worktree list --porcelain | sed -n "s|^worktree \($ROOT/.verify/trees/.*\)|\1|p" | while read -r t; do
  git -C "$ROOT" worktree remove --force "$t" && echo "removed $t"
done
git -C "$ROOT" worktree prune
rmdir "$ROOT/.verify/trees" 2>/dev/null || true
echo "evidence kept in $ROOT/.verify/runs/"
