# Normalised hook contract

Policies are written once and know nothing about which agent invoked them. Adapters translate a
host tool's native input into this contract and translate the result back.

## Events

Exactly three. A host event with no counterpart here is not ported.

| Event | Fires | Populated |
| :-- | :-- | :-- |
| `pre-tool:bash` | before a shell command runs | `AGENT_COMMAND` |
| `post-edit` | after a file write or edit | `AGENT_FILES` |
| `turn-end` | after the agent finishes responding | — |

## Environment

| Variable | Meaning |
| :-- | :-- |
| `AGENT_EVENT` | one of the three above |
| `AGENT_TOOL` | host id: `claude-code`, `opencode`, `codex`, `mistral-vibe`, `cursor` |
| `AGENT_COMMAND` | the shell command about to run (`pre-tool:bash` only) |
| `AGENT_FILES` | newline-separated paths (`post-edit` only) |
| `AGENT_PROJECT_DIR` | repository root |
| `AGENT_CWD` | the session's working directory, which in a git worktree is not the repository root; falls back to `AGENT_PROJECT_DIR` |

## Exit codes

| Code | Meaning |
| :-- | :-- |
| `0` | allow |
| `2` | **block** — the reason is written to stderr and shown to the agent |
| other | policy error; the adapter allows and warns, never blocks on its own bug |

Blocking is the least portable part of the design, so each adapter expresses exit 2 in its host's
own convention: Claude Code passes it through, an opencode plugin throws.

## Requirements

`bash` >= 3.2, `jq`, `awk` and `sed`. Shell JSON extraction is deliberately not hand-rolled: the
parsed field is the command under guard, so a parse bug an embedded quote can defeat is a bypass
of the only hook whose job is blocking. `awk` and `sed` are POSIX and present wherever bash is;
`git-safety` reads the command with them.

## Known limitation: reading the line

`git-safety` reads the commands a line would run rather than the line itself. It splits on the
shell's separators while tracking quotes and backslash escapes, unwraps one level of `bash -c`
or `eval`, and collects the body of each command substitution, in the line and in an unwrapped
payload alike. Each rule then anchors to the start of a
command, so a heredoc, a commit message or a `grep` pattern that merely *names* a forbidden
command is no longer mistaken for running one.

It is not a shell, and the distance between it and one is where a bypass would live:

- One level of runner unwrapping. A runner inside a runner payload is read as text, though a
  wrapper in front of a runner is not: `exec bash -c ...` is still read as `bash -c`.
- Command substitution is not nested: the body of the outer one is read, the inner is not.
- A wrapper is recognised from a list — `sudo`, `exec`, `nohup`, `timeout`, `env` and the rest
  named in the policy. One outside that list hides the command behind it.
- A heredoc line that *begins* with a forbidden command is still read as that command.

What this replaced matched patterns against the raw text, so every mention of a command was a
block. That was documented here as deliberate, on the grounds that a parser disagreeing with the
user's real shell is a bypass rather than an inconvenience. The inconvenience turned out to be the
larger cost — it blocked writing this repository's own release procedure — but the objection is
answered rather than dropped: the parser must never be more permissive than the string match was,
and the table of wrapped commands in `test/claude-code-adapter.test.ts` is what holds it there.

`rm -rf /` is still matched against the raw text. The two errors do not cost the same.
