# Capability matrix

What each target tool actually supports, and therefore what `agentspine` emits for it.

**Verified: 2026-09-14** against each tool's own documentation, or its source where the docs are
silent. Versions are not pinned yet. These five move fast; treat any row older than a release
cycle as unverified, and re-run `agentspine doctor` after upgrading a tool.

## Discovery paths

| | Project memory | Skills | Hooks | Agents |
| :-- | :-- | :-- | :-- | :-- |
| **Claude Code** | `CLAUDE.md` importing `@AGENTS.md` | `.claude/skills/<name>/SKILL.md` | `.claude/settings.json` | `.claude/agents/*.md` |
| **opencode** | `AGENTS.md` native | `.agents/skills/`, `.claude/skills/`, `.opencode/skills/` — all native | JS plugins only, `.opencode/plugins/` | `.opencode/agent/*.md` |
| **Codex** | `AGENTS.md` native | `.agents/skills/` native, scanned CWD -> repo root; also `.codex/skills/` | `.codex/hooks.json`, or `[hooks]` in `.codex/config.toml` | `[agents]` in `config.toml` |
| **Mistral Vibe** | `AGENTS.md` native | `.agents/skills/`, `.vibe/skills/`, plus `skill_paths` | `.vibe/hooks.toml` | `~/.vibe/agents/*.toml` (user-global) |
| **Cursor** | `AGENTS.md` native, plus `.cursor/rules/*.mdc` | `.agents/skills/` native, plus `.cursor/skills/`, and `.claude/skills/` for compatibility | `.cursor/hooks.json` | subagents (2026) |

## Hook interfaces

The part that actually differs, and the reason adapters exist.

| | Events used | Input | How a hook blocks |
| :-- | :-- | :-- | :-- |
| **Claude Code** | `PreToolUse`, `PostToolUse`, `Stop` | JSON on stdin | **exit 2**, reason on stderr |
| **Codex** | same names, same fields | JSON on stdin | **exit 2**, reason on stderr — or `{"decision": "block"}` |
| **Cursor** | `beforeShellExecution`, `afterFileEdit`, `stop` | JSON on stdin | **exit 2**, documented as equivalent to `permission: "deny"` |
| **Mistral Vibe** | `pre_tool`, `post_tool`, `post_agent` | JSON on stdin | **exit 0 + `{"decision": "deny", "reason": …}` on stdout** |
| **opencode** | `tool.execute.before/after`, `event` (`session.idle`) | JS objects | **throw** from the hook |

Two consequences the design absorbs:

- **Codex is Claude-shaped.** Same event names, same stdin fields, same exit-2 convention, so both
  are served by one `claude-shaped.sh` and two three-line wrappers.
- **Vibe inverts the convention.** Exit 2 means nothing to it; a denial is exit 0 with JSON on
  stdout, and stdout is reserved for that JSON. Its adapter translates, and keeps every other byte
  on stderr. This is exactly why policies never speak a host's protocol directly.

**A Claude Code hook that fails or times out lets the call through.** A `PreToolUse` command hook
that reaches its `timeout` is cancelled and does not block the tool call, and on most events a
failing hook does not stop the action either. `"onFailure": "block"`, from 2.1.295, makes both
block (https://code.claude.com/docs/en/hooks, "Timeouts" and "Block the action when a hook fails",
read 2026-10-18). agentspine sets `timeout: 5` on git-safety and leaves `onFailure` unset, since its
adapters fail open (decision 12).

## The two findings the design rests on

1. **`SKILL.md` is a de facto standard.** All five follow the Anthropic Agent Skills spec: `name`
   and `description` frontmatter, unknown fields ignored. Shipped skills need no format
   translation — only placement.
2. **`.agents/skills/` is already a neutral cross-tool convention.** Codex, opencode, Mistral Vibe
   and Cursor all read it natively, without configuration — four of the five. Only Claude Code
   needs the symlink. Cursor documents it as a project-level path alongside `.cursor/skills/`
   (read 2026-09-18); it was on the symlink side until then.

Neither holds for agents. See decision 8 in [`design/0001-architecture.md`](design/0001-architecture.md).

## What we emit per tool

| | Memory | Skills | Hooks | Agents |
| :-- | :-- | :-- | :-- | :-- |
| **Claude Code** | `CLAUDE.md` -> `@AGENTS.md` | symlink | `settings.json`, deep-merged, plus a sandbox write deny on `.agents/` | rendered copy, plus Claude-only keys |
| **opencode** | native | nothing: native | JS plugin shim | symlink (v0.3) |
| **Codex** | native | nothing: native | managed block in `config.toml` | none |
| **Mistral Vibe** | native | nothing: native | managed block in `hooks.toml` | none |
| **Cursor** | native | nothing: native | `hooks.json`, deep-merged | symlink (v0.3) |

## Skill invocation control

Some shipped skills are meant to run only when a human names them: the five `planning` skills,
`adapt-to-project`, `grill-me`, `find-dead-code`, `retro` and others. They say so with Claude Code's
`disable-model-invocation: true` in frontmatter, which is the authoritative list. Verified
2026-09-17 (**D** documented, **S** read in source):

| | Honours `disable-model-invocation` | Native equivalent | Name a skill explicitly |
| :-- | :-- | :-- | :-- |
| **Claude Code** | **yes** (D) | also `skillOverrides: "user-invocable-only"` in settings (D) | `/skill-name` (D) |
| **Cursor** | **yes** (D) | — | `/skill-name` (D) |
| **Codex** | no: key ignored (S) | **emitted**: `agents/openai.yaml` beside each user-invoked `SKILL.md`, `policy.allow_implicit_invocation: false` (D + S) | `$skill-name`, or `/skills` (D) |
| **opencode** | no: key ignored (D) | `permission.skill.<name>: "deny"` in `opencode.json` removes it from the model's list (D). Not emitted: see the gap below | `/skill-name` (S) |
| **Mistral Vibe** | no: key ignored (S) | none. `user-invocable: false` is the opposite switch (model-only) | `/skill-name` (D) |

Unknown frontmatter keys are ignored by Codex, opencode and Vibe, so the key does no harm; it
also does nothing there.

**What the Codex file buys, read in source at `openai/codex@fcf0545`:** `hidden_from_prompt()`
clears `prompt_visible` (`ext/skills/src/provider/host.rs:147-149`,
`ext/skills/src/catalog.rs:256-262`), and every model-facing surface filters on
`is_model_visible()`, so the description is never injected. Explicit selection filters on `enabled`
only (`ext/skills/src/selection.rs:66-75`), so `$skill-name` still works. The file is read from
`<skill>/agents/openai.yaml` (`ext/skills/src/loader/mod.rs:20-21`), and a file Codex cannot parse
is **warned about and ignored** (`ext/skills/src/loader/metadata.rs:117-140`), which silently
restores implicit invocation. A test asserts the emitted payload for that reason.

## Who can rewrite `.agents/` from a sandboxed command

Read 2026-10-18. Hooks read their policies from `.agents/hooks/`, and the turn-end gate its
commands from `.agents/quality.toml`; git-safety reads `GIT_TRUNK` from `.env`, as data. Where a
hook runs outside the sandbox, a sandboxed command that can write `.agents/` chooses what the
next hook runs with the user's full access (decision 34).

| Tool | Where hooks run | `.agents/` from a sandboxed command |
| :-- | :-- | :-- |
| **Claude Code** | outside the sandbox, "with your full access" | writable by default; the emitted `settings.json` denies it |
| **Codex** | outside the sandbox | read-only, protected by Codex itself |
| **Cursor** | not documented | writable; `sandbox.json` has no key that denies it |
| **opencode** | on the host | no sandbox: "OpenCode does **not** sandbox the agent" |
| **Mistral Vibe** | on the host | no sandbox, outside an experimental mode |

- **Claude Code** protects the `.claude` settings files and its `skills`, `agents`, `commands`
  and `hooks` directories from sandboxed commands, but not `.agents/`, so `.claude/settings.json`
  is protected and the policy scripts it names are not. `sandbox.filesystem.denyWrite` closes
  that: `./` resolves from the project root in project settings, entries merge across settings
  files, and a repository's deny entries still apply while the sandbox is admin-required. A
  wildcard in `denyWrite` is skipped on Linux and WSL2, which is why the entry names one path. A
  git command that must replace a file under it fails with `unable to unlink old`, and Claude
  offers to rerun it outside the sandbox.
- **A deny reaches the path a write resolves to, not the link it went through.** Seatbelt
  "compares the kernel's canonical path" (sandbox-runtime `src/sandbox/sandbox-utils.ts:510`).
  Probed with sandbox-runtime 0.0.80 on macOS: a deny on `.agents` refused `.agents/x`,
  `.claude/skills/x` through the skills link, and renaming `.agents`, but let `.agents/hooks/x`
  land where that `hooks` link points. A scaffolded `.agents/` holds real directories, so the
  emitted entry covers all of it; this repository's `.agents/` links into `templates/agents/`,
  which its own settings deny too. The docs follow a link from a protected path only for settings
  files; the `.agents` deny covers the skills behind `.claude/skills` either way.
- **Codex** names `.agents` among its protected metadata paths
  (`codex-rs/protocol/src/permissions.rs:41`, `:46-51`), and makes a top-level `.agents`
  directory in each writable root read-only, along with the gitdir a `.git` file points to
  (`:2360-2402`). Hooks are spawned outside the sandbox
  (`codex-rs/hooks/src/engine/command_runner.rs:244-251`, `build_command` at `:406-432`).
- **Cursor's `sandbox.json`** takes `type`, `additionalReadwritePaths`, `additionalReadonlyPaths`
  ("Extra paths the agent can read"), `readBoundary` and a few more, none of which denies a write
  inside the workspace. It always protects the `.cursor` and `.claude` JSON files, `.vscode/`,
  `.code-workspace`, `.git/hooks/`, `.git/config`, `.git/info/attributes` and `.cursorignore`, so
  `.cursor/hooks.json` is protected and the policies it runs are not. Its hooks reference says
  whether a shell command ran sandboxed, not where a hook runs.
- **opencode:** `SECURITY.md:15-17`, "No Sandbox".
- **Mistral Vibe** runs hooks as host subprocesses (`vibe/core/hooks/executor.py:44`). Its one
  sandbox belongs to the experimental, hidden `--agent-socket` mode, where a server's sandbox
  runs the file and shell tools and hooks stay on the host (`README.md`, "Sandboxed sessions").

## Known gaps

- **Cursor cannot deny a sandboxed command writes to `.agents/`.** `sandbox.json` has no
  deny-write key and its protected paths leave `.agents/` out, so a sandboxed command there can
  rewrite a hook policy or `quality.toml`. See
  [who can rewrite `.agents/`](#who-can-rewrite-agents-from-a-sandboxed-command).
- **User-invoked skills are model-invocable on opencode and Mistral Vibe.** Their descriptions load
  into context and the model may fire them unprompted. Closed for Codex, which now gets
  `agents/openai.yaml` per user-invoked skill.
- **opencode's switch is not emitted, on purpose.** `permission.skill.<name>: "deny"` hides a skill
  from the model, which is documented. That a human can still run `/skill-name` afterwards is not:
  it holds in source (`packages/opencode/src/command/index.ts:134-158` builds the command list from
  `skill.all()` with no permission check, independently of the filter at
  `src/skill/index.ts:314`), but an undocumented behaviour can change in a patch release, and the
  failure mode is a skill no one can reach, which is worse than the gap. Revisit when opencode
  documents slash-command invocation of skills.
- **`retro` knows where to find a transcript only on Claude Code.** Claude Code documents that a
  session's transcript is a `<session id>.jsonl` under `~/.claude/projects/`, and hands hooks its
  path as `transcript_path` (D, read 2026-10-18). How the project directory under it is named is
  not documented, and there is no source to read: the public repository holds plugins and docs,
  and the npm package ships a native binary (2.1.302, checked 2026-10-18). Every character but
  letters and digits becomes `-`, observed 2026-10-18, so `retro` checks that directory exists
  and asks the user when it does not. The other four hosts' transcript locations are unverified,
  so there the skill asks the user rather than guess a path.

- **opencode cannot enforce at turn-end.** `session.idle` fires after the turn, and opencode
  offers no documented way to feed hook output back into the agent's context, so a failing gate is
  reported there and enforced on Claude Code.
- **opencode is the only adapter `doctor` cannot probe.** The other four are exercised with a real
  payload and asserted to block; opencode's shim is a plugin the host loads rather than a script
  that can be handed a payload. What is asserted instead is the shim's own half of the contract:
  Node loads the emitted plugin, calls its handlers, and checks that a blocked command throws and
  an ordinary one does not. Whether opencode calls those handlers, and with which argument shapes,
  is the half that still needs a live session.
- **Codex `Stop` wiring is inferred.** The documented example covers `[[hooks.PreToolUse]]`; the
  `Stop` block follows the same documented shape but has not been confirmed against a running
  Codex.
- **Three of five have never been run against.** Codex, opencode and Cursor wiring is derived from
  their documentation and has not been observed working by the host itself. Vibe's has: its own
  loader accepts the emitted `hooks.toml` in strict mode, asserted by a test that skips where Vibe
  is absent. opencode's is a half-measure by comparison: the emitted plugin is loaded and its
  handlers are called, but by Node, not by opencode.
- **Mistral Vibe agents are user-global launch profiles**, not project-scoped dispatched
  subagents. Not a like-for-like target, so nothing is emitted.
- **Claude-only:** `PreCompact`, the comment-pruner dispatch, and `Use PROACTIVELY` auto-dispatch.

## Agent frontmatter

Read 2026-10-05, from each tool's documentation. This is why Claude Code's agents are a rendered
copy and not the shared files (decision 28).

| | Keys that set reasoning effort | A key the tool does not know |
| :-- | :-- | :-- |
| **Claude Code** | `effort` (`low` to `max`); overrides the session's level, which a subagent otherwise inherits. A spawn can set a model, not an effort | ignored, no error (D) |
| **opencode** | none of its own; provider options such as `reasoningEffort` | **passed to the provider as a model option** (D) |
| **Cursor** | none documented (`name`, `description`, `model`, `readonly`, `is_background`) | not documented |

- **`effort: high` is emitted for Claude Code only**, on `review-correctness`, `review-security`
  and `review-validator`. On opencode and Cursor those reviewers run at whatever effort the
  session has. Nothing emulates the key there.
- **Cursor also reads `.claude/agents/`**, with `.cursor/agents/` winning on a name conflict (D).
  Wired for both, Cursor reads the shared manifests. Wired for Claude Code alone, a Cursor user
  in the same repository gets Claude's copies, `effort` key included, and Cursor does not
  document what it does with a key it does not know.

## The CI review's lock (Claude Code)

Read 2026-10-18, from Claude Code's documentation. The emitted review workflow writes these into
`/etc/claude-code/managed-settings.json`, the managed settings path on Linux (decision 31). The run
uses the Claude Code that `claude-code-action` v1.0.251 bundles, 2.1.301: its `bun.lock:40` at
`374f254` pins `@anthropic-ai/claude-agent-sdk` 0.3.301, whose published `package.json` gives
`claudeCodeVersion` 2.1.301. Dependabot moves this repository's pin (decision 32); 2.1.301 is
the version these facts were checked against.

| Setting or fact | What the docs say it does |
| :-- | :-- |
| `allowManagedPermissionRulesOnly` | ignores `allow`, `ask` and `deny` rules from user, project, local and `--settings` files, and `--allowedTools`; from 2.1.282, also skills' `allowed-tools` |
| `permissions.defaultMode: "dontAsk"` | denies every call that would otherwise prompt; reads in the working directory, allowed tools and the built-in read-only commands still run |
| Built-in read-only commands | `ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd` and read-only forms of `git` run without a prompt in every mode; the set is not configurable, and only an `ask` or `deny` rule for a command changes it |
| `--permission-mode` | overrides `defaultMode`, which is why `deny` holds the file tools rather than the mode |
| `disableAutoMode`, `permissions.disableBypassPermissionsMode` | `"disable"` turns each mode off; accepted in any settings file, not only managed ones. `disableAutoMode` is documented at the top level, and also accepted as `permissions.disableAutoMode` |
| `--allowedTools "Glob,Grep"` | on Linux, macOS and WSL both tools are absent by default, and `find` and `grep` run through Bash instead; naming either in `--allowedTools` restores both, while an allow rule in a settings file does not |
| `Bash(git diff *)` | the space before `*` stops it matching `git diff-index`; a `*` matches any text, spaces included, so `Bash(git diff*)` also matches `git difftool` |
| `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed` | Bash in a sandbox; exit at startup if it cannot start; no retry outside it; no auto-approval for sandboxed calls |
| `sandbox.network.allowedDomains`, `allowManagedDomainsOnly` | outbound hosts for sandboxed commands, locked to the managed list |
| Sandbox filesystem | writes only to the working directory and the per-user temp directory `$TMPDIR` points to, by default; reads are not restricted |
| Linux sandbox | needs `bubblewrap` and `socat`, which the workflow installs |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` | strips credentials, recognised by variable name or value shape, from the environments of the subprocesses Claude Code starts, Bash among them; leaves `GH_TOKEN` and `GITHUB_TOKEN` so `gh` keeps working |
| `--effort` | `low`, `medium`, `high`, `xhigh`, `max`; available levels depend on the model |
| Result message | `permission_denials` (`tool_name`, `tool_input`); `modelUsage` per model, subagents included; `usage` covers the main loop only |

- **`$TMPDIR` on the runner is not `RUNNER_TEMP`,** which holds `$GITHUB_ENV`: GitHub's runner sets
  `RUNNER_TEMP` and never `TMPDIR` (a search of `actions/runner` finds `TMPDIR` only in a vendored
  `dotnet-install.sh`, 2026-10-18). Were it set there, the sandbox would let a review write the
  job's environment file.
- **The Claude OAuth token is not named** in the scrub's documented list. The docs say only that
  "the Claude Code process keeps the credentials for its own API calls", and the token's name fits
  the credential-name rule. The emitted comment does not claim it by name.
- **Not documented, and not relied on:** that the scrub changes the permission mode. The
  template this pipeline is ported from says it forces default mode. The emitted comment says only
  that a run in any mode refuses an unlisted verb, since `dontAsk` denies it and a run in any other
  mode has nobody to answer the prompt.

## What the CI review rests on outside Claude Code

Read 2026-10-18. The emitted review workflow's comments cite these.

- **claude-code-action runs agent mode here, which sets no permission mode.** At v1.0.251
  (`374f254`), a `prompt` input selects agent mode on a comment event and on a pull request's
  `opened`, `synchronize`, `ready_for_review` and `reopened` (`src/modes/detector.ts:41-42` and
  `:73-74`), unless `track_progress` is set, which forces tag mode (`:20-31`). Agent mode passes
  the workflow's `claude_args` after its own `--mcp-config` and nothing else
  (`src/modes/agent/index.ts:122-132`). Tag mode adds `--permission-mode acceptEdits`
  (`src/modes/tag/index.ts:186`). The workflow sets `prompt` and never `track_progress`.
- **`gh api` turns into a POST on any field, and short flags bundle.** The manual: "The default
  HTTP request method is `GET` normally and `POST` if any parameters were added", with `-i` for
  `--include` and `-f` for `--raw-field` ([gh api](https://cli.github.com/manual/gh_api)). gh
  2.92.0 parses flags with `spf13/pflag` v1.0.10 (`go.mod:53`), whose `parseShortArg` reads each
  letter of `-if` as its own flag (`flag.go:1116-1121`). So `-if body=x` is a POST.
- **A reaction on a `@claude review` comment needs `issues: write`.** GitHub lists creating and
  deleting an issue comment's reaction under the "Issues" repository permission, write
  ([permissions for fine-grained tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)).
- **Ubuntu 24.04 restricts unprivileged user namespaces**, which the workflow lifts before the
  Linux sandbox starts: "In combination with the `apparmor` package, the Ubuntu kernel now restricts the use of
  unprivileged user namespaces", lifted by `kernel.apparmor_restrict_unprivileged_userns=0`
  ([24.04 release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890)).

## Verified against

| Tool | Version checked | Date | How |
| :-- | :-- | :-- | :-- |
| Claude Code | **2.1.270** | 2026-09-14 | docs, plus this repo dogfoods the emitted wiring daily |
| Mistral Vibe | **2.25.3** | 2026-09-14 | source, plus the emitted `hooks.toml` parsed by Vibe's own strict loader |
| Codex | not installed | 2026-09-17 | docs, plus its skills loader and provider read at `fcf0545` for the invocation switch |
| opencode | not installed | 2026-09-21 | docs, plus the emitted plugin loaded and its handlers exercised by Node |
| Cursor | not installed | 2026-09-14 | docs only |

"Docs only" means nobody has yet run `agentspine` against that tool and watched a hook fire. The
rows are honest about which claims are tested and which are read.

## Sources

- opencode skills — https://opencode.ai/docs/skills/
- opencode plugins — https://opencode.ai/docs/plugins/
- Codex skills — https://learn.chatgpt.com/docs/build-skills
- Codex hooks — https://learn.chatgpt.com/docs/hooks
- Codex advanced config — https://learn.chatgpt.com/docs/config-file/config-advanced
- Cursor hooks — https://cursor.com/docs/agent/hooks
- Cursor rules — https://cursor.com/docs/rules
- Mistral Vibe — https://github.com/mistralai/mistral-vibe (hook models and protocol read from
  `vibe/core/hooks/models.py`, which the docs do not cover)
- Agent frontmatter, all read 2026-10-05:
  - Claude Code — https://code.claude.com/docs/en/sub-agents ("Supported frontmatter fields"),
    https://code.claude.com/docs/en/model-config ("Adjust effort level")
  - opencode — https://opencode.ai/docs/agents/ ("Additional")
  - Cursor — https://cursor.com/docs/context/subagents
- Session transcripts, read 2026-10-18: Claude Code — https://code.claude.com/docs/en/hooks
  (`transcript_path` in the common input fields)
- The CI review's lock, all read 2026-10-18:
  - https://code.claude.com/docs/en/managed-settings ("Deploy a managed settings file", "Keys only
    a managed source can set")
  - https://code.claude.com/docs/en/settings-reference ("Permission settings", "Sandbox settings")
  - https://code.claude.com/docs/en/permissions ("Permission modes", "Wildcard patterns")
  - https://code.claude.com/docs/en/sandboxing ("Filesystem isolation", "Set up Linux and WSL2")
  - https://code.claude.com/docs/en/env-vars ("What the subprocess environment scrub removes")
  - https://code.claude.com/docs/en/cli-reference (`--effort`, `--permission-mode`)
  - https://code.claude.com/docs/en/headless ("Turn off permission prompts in unattended runs")
  - https://code.claude.com/docs/en/agent-sdk/cost-tracking ("Break down usage per model")
- Who can rewrite `.agents/`, all read 2026-10-18:
  - Claude Code: https://code.claude.com/docs/en/sandboxing ("What runs outside the sandbox",
    "Protected paths", "Repository settings under an admin-required sandbox", "A git command
    fails with `unable to unlink old`"), https://code.claude.com/docs/en/settings-reference
    ("Sandbox path prefixes", `sandbox.filesystem.denyWrite`); source
    `anthropic-experimental/sandbox-runtime@626a596`, `src/sandbox/sandbox-utils.ts`
  - The probe behind "A deny reaches the path a write resolves to": sandbox-runtime 0.0.80 (tag
    `v0.0.80`, `626a596`) on macOS 26.6.2, 2026-10-18. A `denyWrite` on `.agents` refused a
    sandboxed write under it and one through `.claude/skills`, and let one through a link out of
    it
  - Codex: source `openai/codex@8c07694`, `codex-rs/protocol/src/permissions.rs`,
    `codex-rs/hooks/src/engine/command_runner.rs`
  - Cursor: https://cursor.com/docs/reference/sandbox ("Protected paths"),
    https://cursor.com/docs/hooks
  - opencode: source `anomalyco/opencode@da9d436`, `SECURITY.md`
  - Mistral Vibe: source `mistralai/mistral-vibe@4ae5c59`, `vibe/core/hooks/executor.py`,
    `README.md` ("Sandboxed sessions")
- Skill invocation control, all read 2026-09-17:
  - Claude Code — https://code.claude.com/docs/en/skills ("Control who invokes a skill")
  - Cursor — https://cursor.com/docs/context/skills
  - Codex — https://learn.chatgpt.com/docs/build-skills; source `openai/codex@fcf0545`,
    `codex-rs/skills/src/parser.rs` (frontmatter read: name, description, metadata only)
  - opencode — https://opencode.ai/docs/skills/; source `anomalyco/opencode@5a83358`,
    `packages/opencode/src/skill/index.ts` (deny filters the model's list) and
    `src/command/index.ts` (every skill becomes a command)
  - Mistral Vibe — https://docs.mistral.ai/vibe/code/cli/skills; source
    `mistralai/mistral-vibe@d4b3223`, `vibe/core/skills/models.py` (`user-invocable`, extra keys
    allowed)
