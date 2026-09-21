#!/usr/bin/env bash
# Verifies the package a release would publish, from the packed tarball installed into a
# throwaway prefix. The test suite runs from source, so everything the tarball adds -- a
# template left out of "files", a lost exec bit, a path that only resolves inside the repo --
# is invisible to it. A package that installs but cannot scaffold would ship green.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT=$(pwd)

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ALL_TOOLS="claude-code,opencode,codex,mistral-vibe,cursor"
ALL_PACKS="thinking,engineering,planning,review,ci-review"

step() { printf '\n== %s\n' "$1"; }
die() { printf 'verify-package: %s\n' "$1" >&2; exit 1; }

# Hook policies shell out to jq, and the scaffold refuses to wire hooks without it. Skipping
# the hook half of the verification on a machine that lacks jq would report a package as
# verified having never tested the part most likely to be broken.
command -v jq >/dev/null 2>&1 || die "jq is not installed; the hook checks below cannot run."

[ -f dist/cli.js ] || die "dist/ is not built. Run: npm run build"

EXPECTED_VERSION=$(node -p "require('$ROOT/package.json').version")

step "Packing $EXPECTED_VERSION"
npm pack --pack-destination "$WORK" --loglevel error >/dev/null
TARBALL=$(find "$WORK" -maxdepth 1 -name '*.tgz' -print -quit)
[ -n "$TARBALL" ] || die "npm pack produced no tarball."

step "Installing the tarball into a throwaway prefix"
npm install --prefix "$WORK/prefix" --no-save --no-audit --no-fund --loglevel error "$TARBALL" >/dev/null
PKG="$WORK/prefix/node_modules/agentspine"
BIN="$WORK/prefix/node_modules/.bin/agentspine"
[ -x "$BIN" ] || die "the installed package exposes no executable agentspine binary."

REPORTED_VERSION=$("$BIN" --version)
[ "$REPORTED_VERSION" = "$EXPECTED_VERSION" ] \
  || die "installed binary reports $REPORTED_VERSION, package.json says $EXPECTED_VERSION."

step "Checking what the tarball carries"
[ -d "$PKG/templates/agents" ] || die "templates/ did not survive packing."
# npm preserves the exec bit, but only on files it packs. A policy or adapter that arrives
# without it fails at the moment a hook fires, in a stranger's repository.
NOT_EXECUTABLE=$(find "$PKG/templates" -name '*.sh' ! -perm -u+x)
if [ -n "$NOT_EXECUTABLE" ]; then
  die "packed but not executable:
$NOT_EXECUTABLE"
fi
printf 'every packed .sh is executable\n'

step "Scaffolding a fresh repository with every tool and pack"
REPO="$WORK/repo"
mkdir -p "$REPO"
git init -q "$REPO"
: > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=verify -c user.email=verify@example.invalid commit -qm "initial"
"$BIN" init --dir "$REPO" --tools "$ALL_TOOLS" --packs "$ALL_PACKS" --yes >/dev/null \
  || die "init failed against a fresh repository."

step "Probing the wiring the scaffold just wrote"
# Each probe feeds a host-shaped payload straight to the adapter, so this proves the hooks
# block without any of the five tools being installed here.
"$BIN" doctor --dir "$REPO" --tools "$ALL_TOOLS" || die "doctor reported a broken scaffold."

step "Re-checking the tree against what init would emit"
"$BIN" init --check --dir "$REPO" --tools "$ALL_TOOLS" --packs "$ALL_PACKS" >/dev/null \
  || die "--check reports drift against the tree init had just written."

step "Emitting the CI review schema"
"$BIN" review schema | node -e 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))' \
  || die "review schema did not emit parseable JSON."

step "Creating a worktree with the emitted script"
(cd "$REPO" && ./.agents/scripts/worktree-create.sh smoke >/dev/null) \
  || die "the emitted worktree-create.sh could not create a worktree."
[ -d "$REPO/.worktrees/smoke" ] || die "worktree-create.sh reported success but wrote no worktree."

printf '\nagentspine %s verified from the packed tarball.\n' "$EXPECTED_VERSION"
