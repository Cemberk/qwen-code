#!/bin/sh
# Update qwen-code and the llama.cpp fork on macOS or Linux, from the two
# checkouts side by side, and rebuild both:
#
#   cd qwen-code && sh scripts/update-local.sh
#
# It refuses to run when either checkout has local changes, fast-forwards
# qwen-code to adaptive-local-inference and llama.cpp to adaptive-moe,
# stops the local model pool (its engines must not run while they are
# rebuilt; it refuses while qwen sessions use it, unless FORCE=1), then runs
# scripts/install-local.sh, which takes the same environment (LLAMA_DIR,
# JOBS, DOWNLOAD_MODEL).

set -eu

QWEN_DIR=$(cd "$(dirname "$0")/.." && pwd)
LLAMA_DIR=${LLAMA_DIR:-$QWEN_DIR/../llama.cpp}

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

update() {
  dir=$1
  branch=$2
  [ -d "$dir/.git" ] || fail "No checkout at $dir."
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    fail "$dir has local changes: commit or stash them first."
  fi
  step "Updating $dir ($branch)"
  git -C "$dir" fetch origin "$branch"
  git -C "$dir" checkout "$branch"
  git -C "$dir" merge --ff-only "origin/$branch" ||
    fail "$dir has commits that are not on origin/$branch: rebase or push them first."
}

update "$QWEN_DIR" adaptive-local-inference
update "$LLAMA_DIR" adaptive-moe

if [ -f "$QWEN_DIR/dist/cli.js" ]; then
  SESSIONS=$(node "$QWEN_DIR/dist/cli.js" pool status 2>/dev/null |
    sed -n 's/.*qwen sessions attached: \([0-9]*\).*/\1/p')
  if [ "${FORCE:-0}" != 1 ] && [ "${SESSIONS:-0}" -gt 0 ]; then
    fail "$SESSIONS qwen session(s) use the local model pool: close them first (or FORCE=1; their next request then starts it again)."
  fi
  step 'Stopping the local model pool, if it runs'
  node "$QWEN_DIR/dist/cli.js" pool stop 2>/dev/null || true
  sleep 2
fi

export LLAMA_DIR
exec sh "$QWEN_DIR/scripts/install-local.sh"
