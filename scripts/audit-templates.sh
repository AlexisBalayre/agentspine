#!/usr/bin/env bash
# Fails if shipped content carries a specific project's or person's fingerprints.
# Shipped content goes into strangers' repositories, so a leak here is permanent and
# public. This runs in CI so the check cannot be forgotten when a skill is ported.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# quality.toml deliberately shows a real toolchain as a commented-out example.
EXCLUDE="templates/agents/quality.toml"

# Vendor and workflow identifiers that betray a specific employer or person. Naming the
# employer here would itself leak it, so employer-specific terms stay out of this file and
# arrive at runtime instead.
FINGERPRINTS='sonarqube|sonar_|wiz_|linear\.app|atlassian|TRACKER_[A-Z_]+|OBSIDIAN_|\.internal\b'

# Private terms, as a regex alternation, from an untracked file or the environment. CI supplies
# them from a secret. Absence is reported rather than passed over: a guard that quietly stops
# checking half of what it claims to check is the failure this project exists to avoid.
PRIVATE_FILE="${AUDIT_FINGERPRINTS_FILE:-.audit-fingerprints}"
PRIVATE=""
if [ -f "$PRIVATE_FILE" ]; then
  # Surrounding whitespace on a hand-edited line would otherwise become part of the
  # alternative and quietly stop it matching.
  PRIVATE=$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$PRIVATE_FILE" \
    | grep -vE '^(#|$)' | paste -sd '|' -)
elif [ -n "${AUDIT_EXTRA_FINGERPRINTS:-}" ]; then
  PRIVATE="$AUDIT_EXTRA_FINGERPRINTS"
fi
if [ -n "$PRIVATE" ]; then
  FINGERPRINTS="$FINGERPRINTS|$PRIVATE"
else
  printf 'audit-templates: no private fingerprint list; checking public terms only.\n' >&2
fi

# The private list is hand-written and reaches us through a secret, so it can be malformed.
# An uncompilable pattern makes grep match nothing, which would read as "clean" -- the guard
# would report success having scanned nothing at all. Refuse to run instead.
pattern_error=$(printf '' | grep -E "$FINGERPRINTS" 2>&1 >/dev/null)
pattern_status=$?
# 0 matched, 1 no match; both mean the pattern compiled. Anything higher does not.
if [ "$pattern_status" -gt 1 ]; then
  if [ -n "$PRIVATE" ]; then
    # Some greps quote the offending pattern back in their diagnostic, and the pattern now
    # carries the private terms, so repeating it here would leak exactly what this script
    # exists to keep out of shipped content and logs.
    printf 'audit-templates: the fingerprint pattern does not compile. The private list forms\n' >&2
    printf 'part of it, so the error is withheld rather than echoed; check the private terms.\n' >&2
  else
    printf 'audit-templates: fingerprint pattern does not compile (%s).\n' "$pattern_error" >&2
  fi
  exit 1
fi
# Names and paths that only exist in the repository this content was extracted from.
COUPLING='acme|docs/conventions/|pnpm-lock|_journal\.json|PROJ-[0-9]'
# agentspine's own docs never land in a scaffolded repo, so shipped content citing them sends the
# reader to a file they do not have.
OWN_DOCS='docs/capability-matrix|docs/design/'

status=0
scan() {
  local label="$1" pattern="$2"
  local raw rc hits
  # grep's stderr is kept and its status inspected: 0 matched, 1 clean, anything else is a
  # failure to scan, which must never be mistaken for a clean result.
  raw=$(grep -rniE "$pattern" templates/)
  rc=$?
  if [ "$rc" -gt 1 ]; then
    printf '%s: scan failed (grep exit %d); treating as a failure, not as clean.\n' "$label" "$rc" >&2
    status=1
    return
  fi
  hits=$(printf '%s' "$raw" | grep -v "^$EXCLUDE:")
  if [ -n "$hits" ]; then
    printf '%s:\n%s\n\n' "$label" "$hits" >&2
    status=1
  fi
}

scan "Employer or personal fingerprints in shipped content" "$FINGERPRINTS"
scan "References to the originating repository" "$COUPLING"
scan "References to agentspine's own docs, which a scaffolded repo does not have" "$OWN_DOCS"

if [ "$status" -eq 0 ]; then
  printf 'templates/ clean: no employer, personal, or originating-repo references.\n'
fi
exit "$status"
