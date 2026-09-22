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

# Splits a line into the separate commands a shell would run, one per line. Quoting and
# backslash escapes are tracked, so a separator inside an argument does not end the command and
# an escaped quote does not end the argument. A newline inside an argument becomes a space,
# because left as a newline it would reach grep as a line of its own, which is the confusion
# this exists to remove. With strip=1 the quote characters are dropped as well.
# The $0 below is awk's whole record, so the quotes must stay single.
# shellcheck disable=SC2016
SPLIT_COMMANDS='
  function flush() { if (buf ~ /[^ \t]/) print buf; buf = "" }
  {
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
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

# The body of every command substitution. Substitution runs its contents, and runs them inside
# double quotes too, so these are commands however the line reads around them. Emitted alongside
# the ordinary commands rather than spliced into them: a rule can then only ever see more
# commands, never fewer, which is the safe direction for this file to be wrong in.
# With literal=1 a single quote is an ordinary character, as it is in an unquoted heredoc body.
# shellcheck disable=SC2016
SUBSTITUTION_BODIES='
  {
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (c == "\\") { i++; if (depth) body = body substr($0, i, 1); continue }
      if (depth) {
        if (c == ")" || c == "`") { if (body ~ /[^ \t]/) print body; body = ""; depth = 0 }
        else body = body c
        continue
      }
      if (sq) { if (c == "\047") sq = 0; continue }
      if (c == "\047" && !literal) { sq = 1; continue }
      if (c == "`" || (c == "$" && substr($0, i + 1, 1) == "(")) { depth = 1; if (c == "$") i++ }
    }
  }
  END { if (body ~ /[^ \t]/) print body }
'

# Separates heredoc bodies from the lines around them. want=code prints what the shell runs: every
# line outside a body, and a body fed to a shell. want=fed prints only the bodies fed to a shell,
# so they can be read as commands of their own: in place, they may sit inside the quotes of
# `eval "$(cat <<'EOF' ...)"`, where a split would take them for text. want=expanded prints an
# unquoted body, which is data but still expands its substitutions. A quoted body (<<'EOF',
# <<"EOF", <<\EOF) expands nothing and is printed by none of them.
#
# A delimiter is only recognised outside quotes, and inside $( ) where quoting starts afresh:
# `git commit -m "$(cat <<'EOF' ...)"` is how a multi-line message is usually written. A body
# with no terminator is printed as code, because guessing that a line is data is the unsafe way
# to be wrong. Any shell anywhere on the opening line makes that line's bodies code: a heredoc
# can reach one through a pipe as easily as by redirection.
# shellcheck disable=SC2016
HEREDOCS='
  function runs_shell(seg) {
    sub(/^[ \t]*/, "", seg)
    while (match(seg, /^((sudo|doas|exec|nohup|command|time|env|nice|xargs)[ \t]+|[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+|-[^ \t]+[ \t]+)/))
      seg = substr(seg, RLENGTH + 1)
    return seg ~ /^(bash|sh|zsh|ksh|dash|eval|source|\.)([ \t]|$)/
  }
  function openers(line,   i, c, q, seg, d, quoted, tabs_, j, rest, depth, shell, first) {
    q = ""; seg = ""; depth = 0; shell = 0; first = n + 1
    for (i = 1; i <= length(line); i++) {
      c = substr(line, i, 1)
      if (c == "\\" && q != "\047") { seg = seg c substr(line, i + 1, 1); i++; continue }
      if (c == "$" && substr(line, i + 1, 1) == "(" && q != "\047") {
        if (runs_shell(seg)) shell = 1
        outer[++depth] = q; q = ""; i++; seg = ""
        continue
      }
      if (q != "") { if (c == q) q = ""; seg = seg c; continue }
      if (c == ")" && depth) { if (runs_shell(seg)) shell = 1; q = outer[depth--]; seg = ""; continue }
      if (c == "\"" || c == "\047") { q = c; seg = seg c; continue }
      if (c == ";" || c == "|" || c == "&" || c == "(") { if (runs_shell(seg)) shell = 1; seg = ""; continue }
      if (c == "<" && substr(line, i, 2) == "<<" && substr(line, i + 2, 1) != "<") {
        i += 2; tabs_ = 0; quoted = 0
        if (substr(line, i, 1) == "-") { tabs_ = 1; i++ }
        while (substr(line, i, 1) ~ /[ \t]/) i++
        c = substr(line, i, 1)
        if (c == "\047" || c == "\"") {
          j = index(substr(line, i + 1), c)
          if (!j) continue
          quoted = 1; d = substr(line, i + 1, j - 1); i += j
        } else {
          if (c == "\\") { quoted = 1; i++ }
          rest = substr(line, i)
          if (!match(rest, /^[A-Za-z0-9_.-]+/)) continue
          d = substr(rest, 1, RLENGTH); i += RLENGTH - 1
        }
        n++; delim[n] = d; lit[n] = quoted; tabs[n] = tabs_; code[n] = 0
        seg = seg " "
        continue
      }
      seg = seg c
    }
    if (runs_shell(seg)) shell = 1
    if (shell) for (j = first; j <= n; j++) code[j] = 1
  }
  function emit(l, h) {
    if (code[h]) { if (want == "code" || want == "fed") print l }
    else if (!lit[h]) { if (want == "expanded") print l }
  }
  {
    if (head) {
      line = $0
      if (tabs[head]) sub(/^\t+/, "", line)
      if (line == delim[head]) {
        for (k = 1; k <= nb; k++) emit(body[k], head)
        nb = 0
        if (++head > n) { head = 0; n = 0 }
        next
      }
      body[++nb] = $0
      next
    }
    if (want == "code") print
    openers($0)
    if (n) head = 1
  }
  END { if (head && (want == "code" || want == "fed")) for (k = 1; k <= nb; k++) print body[k] }
'

# Words that run another command, and the option or duration tokens that belong to them. A rule
# naming a subcommand has to see past these, or `sudo git push origin <trunk>` is a push the
# policy never sees -- which the raw string match, for all its faults, always caught.
WRAPPER='(sudo|doas|exec|nohup|command|time|timeout|stdbuf|setsid|nice|ionice|env|xargs|eval)'
LEAD="(${WRAPPER}|-[^[:space:]]+|[0-9]+[smhd]?|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)"

# A shell runner carries code in its argument, and so does `eval`. Stripping the runner and the
# quotes around its payload lets the pass below read that payload as the commands it is. Any
# number of wrappers may stand in front of the runner: `exec bash -c ...` is still `bash -c`.
# One level of unwrapping only.
#
# The two quote cases are written out rather than captured and back-referenced, because a
# backreference is not part of POSIX ERE and BSD sed quietly declines to match one.
unwrap_runners() {
  sed -E "s/^[[:space:]]*(${LEAD}[[:space:]]+)*((bash|sh|zsh|ksh)[[:space:]]+-c|eval)[[:space:]]+//" \
    | sed -E "s/^\"(.*)\"[[:space:]]*\$/\\1/; s/^'(.*)'[[:space:]]*\$/\\1/"
}

CODE=$(printf '%s\n' "$COMMAND" | awk -v want=code "$HEREDOCS")
EXPANDED=$(printf '%s\n' "$COMMAND" | awk -v want=expanded "$HEREDOCS")
FED=$(printf '%s\n' "$COMMAND" | awk -v want=fed "$HEREDOCS")
SPLIT=$(printf '%s' "$CODE" | awk -v strip=0 "$SPLIT_COMMANDS")

# Everything the line would run, as the rules below read it. The raw string cannot tell running
# a command from naming one: a commit message, an echo or a grep pattern that quotes
# `git push origin <trunk>` is text, and every rule here used to block on it.
#
# Quotes survive the first split and are dropped only by the last, because the middle step
# unwraps a runner's payload and a pass that had already dropped them would split
# `sed 's|x|y|'` into commands of its own.
#
# Substitutions are collected from the unwrapped payload as well as from the code. Single
# quotes stop the outer shell expanding a substitution, but they do not survive into what a
# runner is handed: `bash -c '$(...)'` expands inside that runner. An unquoted heredoc body is
# read for its substitutions only, with its quotes taken literally, as the shell reads it.
PAYLOADS=$(printf '%s\n' "$SPLIT" | unwrap_runners)
MAIN_COMMANDS=$(printf '%s\n' "$PAYLOADS" | awk -v strip=1 "$SPLIT_COMMANDS")
SUBSTITUTED=$(
  { printf '%s\n' "$CODE"; printf '%s\n' "$PAYLOADS"; } | awk "$SUBSTITUTION_BODIES"
  printf '%s\n' "$EXPANDED" | awk -v literal=1 "$SUBSTITUTION_BODIES"
)
SUBSTITUTED=$(printf '%s\n%s\n' "$SUBSTITUTED" "$FED" | awk -v strip=1 "$SPLIT_COMMANDS")

# Computed once. This runs before every shell command the agent makes, and each rule below would
# otherwise re-run the whole pipeline.
COMMANDS=$(printf '%s\n%s\n' "$MAIN_COMMANDS" "$SUBSTITUTED")

# git's own global options sit between `git` and the subcommand: `-C <path>`, `-c <k=v>`,
# `--no-pager`. Stepping over them is what makes `git -C <worktree> push` visible to a rule.
GIT_PREFIX="^[[:space:]]*(${LEAD}[[:space:]]+)*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|--[A-Za-z][A-Za-z0-9-]*(=[^[:space:]]+)?))*[[:space:]]+"

# Every git invocation of one subcommand, or nothing.
git_runs() {
  printf '%s\n' "$COMMANDS" | grep -E "${GIT_PREFIX}$1([[:space:]]|\$)" || true
}

# Unlike the git rules, this one still reads the whole string, and a command that merely names it
# is blocked too. The two errors do not cost the same: being wrong about a command that names a
# force push costs a retry, and being wrong about one that empties the disk costs the disk.
case "$COMMAND" in
  *"$RECURSIVE_FORCE_ROOT"*) block 'recursive force delete of an absolute path.' ;;
esac

PUSHES=$(git_runs push)

if printf '%s' "$PUSHES" | grep -qE -- '(^|[[:space:]])(--force|-f)([[:space:]]|$)'; then
  block 'force push. Push normally, or ask the user.'
fi

if git_runs reset | grep -qE -- "(^|[[:space:]])$HARD([[:space:]]|\$)"; then
  block 'a hard reset discards work. Revert, or branch instead.'
fi

SESSION_DIR="${AGENT_CWD:-$PROJECT_DIR}"

# A cd or -C target as an absolute directory, or nothing when the hook cannot know where it leads.
resolve_dir() {
  local target="$2"
  case "$target" in
    '' | - | *'$'* | *'`'* | *'*'* | *'?'*) return 0 ;;
    '~') target="$HOME" ;;
    '~/'*) target="$HOME/${target#\~/}" ;;
    /*) ;;
    *) target="$1/$target" ;;
  esac
  (cd "$target" 2>/dev/null && pwd -P) || true
}

# Where one git invocation runs: its -C options applied in order to the directory it starts in.
# An option the hook cannot resolve leaves the session's directory, which is what it read before.
git_dir() {
  local dir="$1" next
  set -f
  # shellcheck disable=SC2086
  set -- $2
  set +f
  while [ "$#" -gt 0 ] && [ "$1" != git ]; do shift; done
  [ "$#" -gt 0 ] && shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C) next=$(resolve_dir "$dir" "${2:-}"); dir="${next:-$SESSION_DIR}"; shift ;;
      -c) shift ;;
      -*) ;;
      *) break ;;
    esac
    [ "$#" -gt 0 ] && shift
  done
  printf '%s\n' "$dir"
}

# A cd is followed only through `&&`, `;` and newlines, where it persists into the next command.
# A subshell, a pipeline, a background job, `||` or an unwrapped runner scopes or conditions it in
# ways this does not model, so any of them means every command is read against the session's
# directory, as before. That fallback is the old behaviour, never a looser one.
# shellcheck disable=SC2016
SCOPED='
  {
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1); p = substr($0, i - 1, 1); n = substr($0, i + 1, 1)
      if (c == "\\" && q != "\047") { i++; continue }
      if (q != "") { if (c == q) q = ""; continue }
      if (c == "\"" || c == "\047") { q = c; continue }
      if (c == "(" && p != "$") found = 1
      if (c == "|") found = 1
      if (c == "&" && n != "&" && p != "&" && p != ">" && n != ">") found = 1
    }
  }
  END { print found ? 1 : 0 }
'
# bash's own =~ rather than grep per line: this loop runs for every command a line holds.
IS_CD='^[[:space:]]*cd([[:space:]]|$)'
IS_COMMIT="${GIT_PREFIX}commit([[:space:]]|\$)"
IS_PUSH="${GIT_PREFIX}push([[:space:]]|\$)"

# Pushing a tag from the trunk is how releases are cut: it publishes a ref that points at
# trunk, it does not move trunk. Only a push that carries no tag falls under the rule below.
is_tag_push() {
  local word
  case "$2" in *--tags* | *--follow-tags* | *refs/tags/*) return 0 ;; esac
  for word in $2; do
    git -C "$1" rev-parse --verify --quiet "refs/tags/$word" >/dev/null 2>&1 && return 0
  done
  return 1
}

# The branch of the checkout each commit and push runs in, not the repository root's: with a
# git worktree they are different checkouts on different branches. A cd or -C moves it, which
# is how a command reaches another repository or worktree from the session's directory.
check_trunk() {
  local dir branch
  dir=$(git_dir "$1" "$2")
  branch=$(git -C "$dir" branch --show-current 2>/dev/null || true)
  [ "$branch" = "$TRUNK" ] || return 0
  if [[ $2 =~ $IS_COMMIT ]] || { [[ $2 =~ $IS_PUSH ]] && ! is_tag_push "$dir" "$2"; }; then
    block "you are on $TRUNK. Branch first; this project works on branches only."
  fi
}

if [ -n "$PUSHES" ] || [ -n "$(git_runs commit)" ]; then
  FOLLOW_CD=1
  [ "$(printf '%s\n' "$CODE" | awk "$SCOPED")" = 0 ] || FOLLOW_CD=0
  [ "$PAYLOADS" = "$SPLIT" ] || FOLLOW_CD=0
  case "$CODE" in *pushd* | *popd*) FOLLOW_CD=0 ;; esac

  dir="$SESSION_DIR"
  while IFS= read -r line; do
    if [ "$FOLLOW_CD" = 1 ] && [[ $line =~ $IS_CD ]]; then
      target="${line#"${line%%[![:space:]]*}"}"
      target="${target#cd}"
      target="${target#"${target%%[![:space:]]*}"}"
      target="${target%"${target##*[![:space:]]}"}"
      next=$(resolve_dir "$dir" "${target:-$HOME}")
      dir="${next:-$SESSION_DIR}"
    elif [[ $line =~ $IS_COMMIT ]] || [[ $line =~ $IS_PUSH ]]; then
      check_trunk "$dir" "$line"
    fi
  done <<EOF
$MAIN_COMMANDS
EOF

  while IFS= read -r line; do
    if [[ $line =~ $IS_COMMIT ]] || [[ $line =~ $IS_PUSH ]]; then
      check_trunk "$SESSION_DIR" "$line"
    fi
  done <<EOF
$SUBSTITUTED
EOF
fi

# Naming the trunk as a refspec pushes it, whatever branch the push is made from, and
# `--follow-tags` carries the trunk alongside the tag rather than instead of it.
if printf '%s' "$PUSHES" | grep -qE "[[:space:]]$TRUNK([[:space:]]|$)"; then
  block "direct push to $TRUNK. Open a pull request instead."
fi

exit 0
