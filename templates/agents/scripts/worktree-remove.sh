#!/usr/bin/env bash
# Remove worktrees made by worktree-create.sh, and their branches when no work is lost.
#   .agents/scripts/worktree-remove.sh <name>...  ->  removes .worktrees/<name> and its branch
#   .agents/scripts/worktree-remove.sh --merged   ->  the same for every worktree whose tip a merged
#                                                     pull request shipped
# A worktree with uncommitted or untracked files, a detached HEAD, or a branch outside <prefix>/
# is kept; ignored files (.env, node_modules) go with it. Its branch is deleted once a pull request
# merged into the default branch shipped its tip (and origin's copy too, while still at that tip),
# or once origin's copy holds every commit; otherwise it is kept. A failed fetch keeps every
# branch. --merged exits 1 when the fetch fails, removing nothing, or when gh cannot answer for a
# worktree, which it keeps. The merged-PR check needs an authenticated `gh`.
# Branch prefix comes from .agents/worktree.env (default: feature).
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# shellcheck disable=SC1091
[ -f .agents/worktree.env ] && . .agents/worktree.env
PREFIX="${WORKTREE_BRANCH_PREFIX:-feature}"

USAGE="Usage: .agents/scripts/worktree-remove.sh <name>... | --merged"
[ $# -gt 0 ] || { echo "$USAGE" >&2; exit 1; }
MERGED_ONLY=0
for ARG in "$@"; do
  [ "$ARG" != "--merged" ] || MERGED_ONLY=1
done
[ "$MERGED_ONLY" = 0 ] || [ $# -eq 1 ] || { echo "$USAGE" >&2; exit 1; }
STATUS=0

# A stale origin ref could vouch for commits the remote no longer has, so without a fresh fetch
# every branch is kept.
FETCHED=1
git fetch --prune --quiet origin || { FETCHED=0; echo "Fetch failed: keeping every branch" >&2; }
[ "$FETCHED" = 1 ] || [ "$MERGED_ONLY" = 0 ] || exit 1

# Only a PR into the default branch shipped anything: one merged into another feature branch, as
# a stacked PR is, has not reached it yet.
TRUNK=""
[ "$FETCHED" = 1 ] && TRUNK=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)

if [ "$MERGED_ONLY" = 1 ]; then
  set --
  for DIR in .worktrees/*/; do
    [ -d "$DIR" ] && set -- "$@" "$(basename "$DIR")"
  done
fi

for NAME in "$@"; do
  # worktree-create.sh holds names to the same rule. No leading dot: the glob above skips those.
  case "$NAME" in
    '' | -* | .* | */* | *..* | *[!A-Za-z0-9._-]*)
      echo "Skipped '$NAME': not a worktree name (letters, digits, . _ - only; no leading . or -)" >&2
      continue ;;
  esac
  WORKTREE_DIR=".worktrees/$NAME"
  if [ ! -d "$WORKTREE_DIR" ]; then
    echo "Skipped $NAME: no worktree at $WORKTREE_DIR" >&2
    continue
  fi

  if ! BRANCH=$(git -C "$WORKTREE_DIR" branch --show-current 2>/dev/null); then
    echo "Kept $WORKTREE_DIR: git cannot read it as a worktree" >&2
    continue
  fi
  if [ -z "$BRANCH" ]; then
    echo "Kept $WORKTREE_DIR: detached HEAD, whose commits no branch may hold" >&2
    continue
  fi
  # Before the removal: .worktrees/ can also hold worktrees other tools made, on branches of
  # their own.
  case "$BRANCH" in
    "$PREFIX"/*) ;;
    *) echo "Kept $WORKTREE_DIR: $BRANCH is not a $PREFIX/ branch" >&2; continue ;;
  esac

  TIP=$(git rev-parse "refs/heads/$BRANCH")
  # A squash merge leaves the tip off the trunk, so only the forge knows it shipped. Without a
  # working gh that question gets no answer, and only origin's own copy can vouch for the branch.
  CHECKED=0
  SHIPPED=0
  if [ "$FETCHED" = 1 ] && [ -n "$TRUNK" ] &&
    MERGED_TIPS=$(gh pr list --head "$BRANCH" --base "$TRUNK" --state merged --json headRefOid --jq '.[].headRefOid' 2>/dev/null); then
    CHECKED=1
    printf '%s\n' "$MERGED_TIPS" | grep -Fx "$TIP" >/dev/null && SHIPPED=1
  fi
  if [ "$MERGED_ONLY" = 1 ] && [ "$SHIPPED" = 0 ]; then
    if [ "$CHECKED" = 1 ]; then
      echo "Kept $WORKTREE_DIR: no PR merged into $TRUNK has its tip as head (pull what the forge added, then retry)" >&2
    else
      echo "Kept $WORKTREE_DIR: gh could not say whether a merged PR shipped its tip" >&2
      STATUS=1
    fi
    continue
  fi

  # No --force: git refuses a worktree with uncommitted or untracked files.
  if ! git worktree remove "$WORKTREE_DIR"; then
    echo "Kept $WORKTREE_DIR" >&2
    continue
  fi
  echo "Removed $WORKTREE_DIR"
  [ "$FETCHED" = 1 ] || continue

  # A commit made in the worktree since the lookup is the branch's too, and no PR shipped it.
  NOW=$(git rev-parse "refs/heads/$BRANCH")
  [ "$NOW" = "$TIP" ] || { TIP=$NOW; SHIPPED=0; }
  REMOTE_TIP=$(git rev-parse -q --verify "refs/remotes/origin/$BRANCH" || true)
  if [ "$SHIPPED" = 1 ]; then
    git branch -D "$BRANCH"
    if [ "$REMOTE_TIP" = "$TIP" ]; then
      # The lease has origin refuse the delete if the branch moved since the fetch.
      git push --quiet --force-with-lease="refs/heads/$BRANCH:$TIP" origin --delete "refs/heads/$BRANCH" ||
        echo "Kept origin/$BRANCH: delete refused (see git's error above)" >&2
    elif [ -n "$REMOTE_TIP" ]; then
      echo "Kept origin/$BRANCH: it moved past the merged tip" >&2
    fi
  elif [ -n "$REMOTE_TIP" ] && git merge-base --is-ancestor "$TIP" "$REMOTE_TIP"; then
    git branch -D "$BRANCH"
  elif [ "$CHECKED" = 1 ]; then
    echo "Kept branch $BRANCH: no merged PR shipped it, and it has commits origin does not hold" >&2
  else
    echo "Kept branch $BRANCH: it has commits origin does not hold, and gh could not say whether a merged PR shipped them" >&2
  fi
done
exit "$STATUS"
