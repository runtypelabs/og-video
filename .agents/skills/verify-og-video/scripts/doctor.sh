#!/usr/bin/env bash
# Read-only: is this checkout and machine able to render, compare and post evidence?
#
#   doctor.sh [--pr <n>]      # with --pr, also checks the PR exists and you can attach files to it
#
# Exits 1 if anything a run needs is missing. Writes nothing outside a temp dir it deletes.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "FAIL not in a git checkout"; exit 1; }
PR=""
[ "${1:-}" = "--pr" ] && PR="${2:-}"
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

[ "$(node -p 'require(process.argv[1]).name' "$ROOT/package.json" 2>/dev/null)" = streaming-og-video ] \
  && ok "checkout is streaming-og-video ($ROOT)" || bad "$ROOT is not the streaming-og-video repo"

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$major" -ge 20 ] && ok "node $(node -v)" || bad "node >= 20 required (have $(node -v 2>/dev/null || echo none))"

[ -e "$ROOT/node_modules/gsap" ] && ok "node_modules installed" || bad "node_modules missing: run npm ci"
for f in wasm/ogfx.wasm wasm/x264.wasm fonts/Inter-Regular.ttf.bin; do
  [ -s "$ROOT/$f" ] || bad "$f missing"
done

if command -v ffmpeg >/dev/null; then
  decoders="$(ffmpeg -hide_banner -decoders 2>/dev/null)"
  grep -q ' h264 ' <<<"$decoders" && ok "ffmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3) decodes h264" || bad "ffmpeg has no h264 decoder"
else
  bad "ffmpeg not on PATH (brew install ffmpeg / apt-get install ffmpeg)"
fi

# A real render, twice, in two processes: the cheapest proof the engine works here.
tmp="$(mktemp -d)"
if node "$ROOT/src/node/cli.js" render title-card -o "$tmp/a.mp4" >/dev/null 2>"$tmp/err" &&
  node "$ROOT/src/node/cli.js" render title-card -o "$tmp/b.mp4" >/dev/null 2>>"$tmp/err"; then
  cmp -s "$tmp/a.mp4" "$tmp/b.mp4" && ok "sogv render title-card is deterministic ($(wc -c <"$tmp/a.mp4" | tr -d ' ') bytes)" || bad "two sogv renders of title-card differ"
else
  bad "sogv render failed: $(head -3 "$tmp/err")"
fi
rm -rf "$tmp"

if gh auth status >/dev/null 2>&1; then
  v="$(gh --version | head -1 | awk '{print $3}')"
  if [ "$(printf '%s\n2.99.0\n' "$v" | sort -V | head -1)" = 2.99.0 ]; then ok "gh $v (has --attach)"; else bad "gh $v: 2.99+ needed for attachment uploads"; fi
  perm="$(gh repo view --json viewerPermission -q .viewerPermission 2>/dev/null)"
  case "$perm" in ADMIN | MAINTAIN | WRITE) ok "gh can write to $(gh repo view --json nameWithOwner -q .nameWithOwner) ($perm), so it can attach files" ;; *) bad "gh permission '$perm': attachments need write access" ;; esac
else
  bad "gh not authenticated: run gh auth login"
fi

if [ -n "$PR" ]; then
  state="$(gh pr view "$PR" --json state -q .state 2>/dev/null)"
  [ -n "$state" ] && ok "PR #$PR is $state" || bad "PR #$PR not found"
fi

leftover="$(git -C "$ROOT" worktree list --porcelain | grep -c "^worktree $ROOT/.verify/trees/" || true)"
[ "$leftover" = 0 ] && ok "no leftover verify worktrees" || echo "warn $leftover leftover worktrees under .verify/trees (scripts/cleanup.sh removes them)"

exit "$fail"
