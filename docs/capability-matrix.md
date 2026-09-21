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
| **Claude Code** | `CLAUDE.md` -> `@AGENTS.md` | symlink | `settings.json`, deep-merged | symlink (v0.3) |
| **opencode** | native | nothing: native | JS plugin shim | symlink (v0.3) |
| **Codex** | native | nothing: native | managed block in `config.toml` | none |
| **Mistral Vibe** | native | nothing: native | managed block in `hooks.toml` | none |
| **Cursor** | native | nothing: native | `hooks.json`, deep-merged | symlink (v0.3) |

## Skill invocation control

Some shipped skills are meant to run only when a human names them: the four `planning` skills,
`adapt-to-project`, `grill-me`, `find-dead-code` and others. They say so with Claude Code's
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

## Known gaps

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
