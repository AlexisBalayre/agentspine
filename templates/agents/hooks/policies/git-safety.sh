#!/usr/bin/env bash
# Blocks destructive and trunk-endangering shell commands.
# Contract: ../CONTRACT.md
set -euo pipefail

[ "${AGENT_EVENT:-}" = "pre-tool:bash" ] || exit 0
COMMAND="${AGENT_COMMAND:-}"
[ -n "$COMMAND" ] || exit 0

PROJECT_DIR="${AGENT_PROJECT_DIR:-.}"
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi
TRUNK="${GIT_TRUNK:-main}"

block() {
  printf 'BLOCKED by agentspine git-safety: %s\n' "$1" >&2
  exit 2
}

# Patterns are assembled rather than written literally so that this file does not
# trip the very rules it defines when an agent writes it through a shell heredoc.
RECURSIVE_FORCE_ROOT="rm -""rf /"
HARD="--""hard"

# Splits a command line into the separate commands a shell would run, one per line. Quoting is
# tracked, so a separator inside an argument does not end the command, and a newline inside one
# becomes a space: left as a newline it would reach grep as a line of its own, which is the very
# confusion this exists to remove. With strip=1 the quote characters are dropped as well.
# The $0 below is awk's whole-record variable, so the quotes must stay single.
# shellcheck disable=SC2016
SPLIT_COMMANDS='
  function flush() { if (buf ~ /[^ \t]/) print buf; buf = "" }
  {
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      # A backslash escapes the next character everywhere but inside single quotes. Reading an
      # escaped quote as the end of the argument hands the rest of the line the wrong state,
      # and a command after it is then read as more of the argument.
      if (c == "\\" && quote != "\047") { i++; buf = buf c substr($0, i, 1); continue }
      if (quote != "") {
        if (c == quote) { quote = ""; if (!strip) buf = buf c } else buf = buf c
        continue
      }
      if (c == "\"" || c == "\047") { quote = c; if (!strip) buf = buf c; continue }
      if (c == ";" || c == "|" || c == "&") { flush(); continue }
      buf = buf c
    }
    if (quote == "") flush(); else buf = buf " "
  }
  END { flush() }
'

# The commands the line would run, as the rules below read it. The raw string cannot tell
# running a command from naming one: a commit message, an echo or a grep pattern that quotes
# `git push origin <trunk>` is text, and every rule here used to block on it.
#
# Quotes survive the first split and are dropped only by the last, because the middle step
# unwraps a shell runner -- the payload of `bash -c ...` is code, not text -- and a pass that
# had already dropped them would split `sed 's|x|y|'` into commands of its own. One level of
# unwrapping: this is a safety net, not a shell.
shell_commands() {
  printf '%s' "$COMMAND" \
    | awk -v strip=0 "$SPLIT_COMMANDS" \
    | sed -E 's/^[[:space:]]*(sudo[[:space:]]+)?(bash|sh|zsh|env)[[:space:]]+-c[[:space:]]+//; s/^[[:space:]]*eval[[:space:]]+//' \
    | awk -v strip=1 "$SPLIT_COMMANDS"
}

# git's global options sit between `git` and the subcommand: `-C <path>`, `-c <k=v>`,
# `--no-pager`. Stepping over them is what lets a rule name a subcommand and still recognise
# `git -C <worktree> push`. Leading VAR=value assignments are stepped over for the same reason.
GIT_PREFIX='^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|--[A-Za-z][A-Za-z0-9-]*(=[^[:space:]]+)?))*[[:space:]]+'

# Every git invocation of one subcommand, or nothing.
git_runs() {
  shell_commands | grep -E "${GIT_PREFIX}$1([[:space:]]|\$)" || true
}

# Unlike the git rules, this one still reads the whole string. A command that merely mentions it
# is blocked too, which is the wrong answer in the same way -- but being wrong about a command
# that destroys the machine costs a retry, and being wrong the other way costs the machine.
case "$COMMAND" in
  *"$RECURSIVE_FORCE_ROOT"*) block 'recursive force delete of an absolute path.' ;;
esac

PUSHES=$(git_runs push)
COMMITS=$(git_runs commit)

if printf '%s' "$PUSHES" | grep -qE -- '(^|[[:space:]])(--force|-f)([[:space:]]|$)'; then
  block 'force push. Push normally, or ask the user.'
fi

if git_runs reset | grep -qE -- "(^|[[:space:]])$HARD([[:space:]]|\$)"; then
  block 'a hard reset discards work. Revert, or branch instead.'
fi

# The session's directory, not the repository root: with a git worktree they are different
# checkouts on different branches, and the branch that matters is the one being worked in. Reading
# the root's branch instead blocks every commit made from a worktree while the root sits on trunk.
CURRENT_BRANCH=$(git -C "${AGENT_CWD:-$PROJECT_DIR}" branch --show-current 2>/dev/null || echo '')
[ -n "$CURRENT_BRANCH" ] || exit 0

# Pushing a tag from the trunk is how releases are cut: it publishes a ref that points at
# trunk, it does not move trunk. Only a push that carries no tag falls under the rule below.
is_tag_push() {
  [ -n "$PUSHES" ] || return 1
  printf '%s' "$PUSHES" | grep -qE -- '--tags|--follow-tags|refs/tags/' && return 0
  for word in $PUSHES; do
    git -C "${AGENT_CWD:-$PROJECT_DIR}" rev-parse --verify --quiet "refs/tags/$word" >/dev/null 2>&1 && return 0
  done
  return 1
}

if [ "$CURRENT_BRANCH" = "$TRUNK" ]; then
  [ -z "$COMMITS" ] || block "you are on $TRUNK. Branch first; this project works on branches only."
  if [ -n "$PUSHES" ] && ! is_tag_push; then
    block "you are on $TRUNK. Branch first; this project works on branches only."
  fi
fi

# Naming the trunk as a refspec pushes it, whatever branch the push is made from, and
# `--follow-tags` carries the trunk alongside the tag rather than instead of it.
if printf '%s' "$PUSHES" | grep -qE "[[:space:]]$TRUNK([[:space:]]|$)"; then
  block "direct push to $TRUNK. Open a pull request instead."
fi

exit 0
