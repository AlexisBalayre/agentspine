#!/usr/bin/env bash
# Create an isolated worktree for one change, on its own branch, with dependencies installed.
#   .agents/scripts/worktree-create.sh <name>  ->  .worktrees/<name> on branch <prefix>/<name>
# Branch prefix and install command come from .agents/worktree.env.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# shellcheck disable=SC1091
[ -f .agents/worktree.env ] && . .agents/worktree.env
PREFIX="${WORKTREE_BRANCH_PREFIX:-feature}"

NAME="${1:?Usage: .agents/scripts/worktree-create.sh <name>}"
# worktree-remove.sh holds names to the same rule, so it can remove whatever this creates.
case "$NAME" in
  '' | -* | .* | */* | *..* | *[!A-Za-z0-9._-]*)
    echo "Error: '$NAME' is not a worktree name (letters, digits, . _ - only; no leading . or -)." >&2
    exit 1 ;;
esac
WORKTREE_DIR=".worktrees/$NAME"
BRANCH="$PREFIX/$NAME"

if [ -d "$WORKTREE_DIR" ]; then
  echo "Error: worktree '$WORKTREE_DIR' already exists." >&2
  exit 1
fi

mkdir -p .worktrees
git worktree add "$WORKTREE_DIR" -b "$BRANCH"

# A fresh worktree has no installed dependencies. A failed install leaves the worktree in
# place for inspection but exits non-zero, so an agent cannot mistake it for a ready one.
if [ -n "${WORKTREE_INSTALL:-}" ]; then
  if ! (cd "$WORKTREE_DIR" && sh -c "$WORKTREE_INSTALL"); then
    echo "Error: install command failed in $WORKTREE_DIR: $WORKTREE_INSTALL" >&2
    exit 1
  fi
fi

echo ""
echo "Worktree created:"
echo "  Directory: $WORKTREE_DIR"
echo "  Branch:    $BRANCH"
echo ""
echo "cd $WORKTREE_DIR"
