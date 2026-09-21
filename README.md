# agentspine

[![npm](https://img.shields.io/npm/v/agentspine?color=cb3837&logo=npm)](https://www.npmjs.com/package/agentspine)
[![ci](https://github.com/AlexisBalayre/agentspine/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexisBalayre/agentspine/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-5fa04e?logo=node.js&logoColor=white)](package.json)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

**Five coding agents, five config directories, one setup.** `agentspine` writes your conventions,
skills and blocking hooks **once** into `.agents/`, then wires **Claude Code, Codex, opencode,
Mistral Vibe and Cursor** to read them.

```bash
npx agentspine
```

- **One copy of everything.** Edit a skill once, every tool sees it.
- **Hooks that actually block.** Shared policies, a per-tool adapter for each host's protocol, and
  `doctor` to prove the block landed rather than assuming it.
- **Opt-in skill packs.** Multi-agent code review, TDD, diagnosis, planning: installed once, read
  by every tool.

Architecture and the reasoning behind each decision: [`docs/design/0001-architecture.md`](docs/design/0001-architecture.md).
What each tool actually supports, with sources and dates: [`docs/capability-matrix.md`](docs/capability-matrix.md).

## The problem

Every one of these tools wants its own directory. Maintain five and they drift: a skill written
three times, a hook wired four ways, a convention updated in one file and stale in the rest.

`agentspine` writes **one** real copy of the content under `.agents/` and points each tool at it.

```
.agents/
├── skills/          # SKILL.md — read natively by four of the five tools
├── agents/          # intersection-only frontmatter, symlinked where portable
├── hooks/
│   ├── policies/    # tool-agnostic shell: git safety, quality gate, naming
│   └── adapters/    # per-tool input parsing and exit-code mapping
├── scripts/         # worktree-create.sh, worktree-clean.sh
├── worktree.env     # install command and branch prefix for new worktrees
└── quality.toml     # per-path lint/typecheck commands, detection-seeded

.claude/skills -> ../.agents/skills
.cursor/skills -> ../.agents/skills
...
```

Two facts make this work, both verified in
[`docs/capability-matrix.md`](docs/capability-matrix.md): all five tools follow the Anthropic
Agent Skills spec, and `.agents/skills/` is already read natively by **four of them** — Codex,
opencode, Mistral Vibe and Cursor. Only Claude Code needs the symlink.

## Design in one table

| | |
| :-- | :-- |
| **Scaffolder, not sync engine** | Writes once. Templates bundled in the package, offline-safe. |
| **Emitted output is Node-free** | Markdown and POSIX shell. A Go or Python repo gets no `package.json`. |
| **One content copy** | `.agents/` is canonical; symlinks reconcile, `--no-symlink` copies. |
| **Three normalised hook events** | `pre-tool:bash`, `post-edit`, `turn-end`; policies written once. |
| **Stack-agnostic quality gate** | Commands live in `.agents/quality.toml`, per-path array. |
| **Core plus opt-in packs** | `adapt-to-project` always; `--packs thinking,engineering,planning,review,ci-review`. |
| **Honest tiers** | What a tool cannot do is documented, not emulated. |

## Support matrix

| Tool | Memory | Skills | Hooks | Blocking verified by `doctor` |
| :-- | :-- | :-- | :-- | :-- |
| Claude Code | `CLAUDE.md` -> `AGENTS.md` | symlink | `settings.json` | yes |
| Codex | native | native | `config.toml` block | yes |
| Cursor | native | native | `hooks.json` | yes |
| Mistral Vibe | native | native | `hooks.toml` block | yes |
| opencode | native | native | JS plugin shim | no — needs a live session |

Skills need no translation: all five follow the Anthropic Agent Skills spec. Hooks do — each host
names its events differently, and Mistral Vibe denies by printing JSON rather than by exit code —
so shared policies are written once and a per-tool adapter speaks each host's protocol.

## Skill packs

One skill ships with every scaffold: **`adapt-to-project`**. Run it once after `init`. It runs
each inferred quality-gate command, activates the ones that pass once you confirm them, and writes
a **project map** into `AGENTS.md`: the lint, typecheck and test commands, the trunk, the issue
tracker, and where the glossary, ADRs and conventions live.

Everything else is opt-in and off by default:

```bash
npx agentspine --packs thinking,engineering
```

| Pack | Skills |
| :-- | :-- |
| `thinking` | `grilling`, `grill-me`, `grill-with-docs`, `codebase-design`, `domain-modeling`, `improve-codebase-architecture`, `prototype`, `handoff`, `zoom-out`, `writing-for-agents`, `research`, `wait-what`, `to-questionnaire`, `caveman` |
| `engineering` | `tdd`, `diagnosing-bugs`, `resolving-merge-conflicts`, `wizard`, `find-dead-code` |
| `planning` | `to-spec`, `to-tickets`, `wayfinder`, `implement`; installs `thinking` and `engineering` too, since it invokes their skills |
| `review` | `review-changes` (six-area multi-agent review), `address-review-comments`, `pr-description`, and the seven reviewer subagents they dispatch |
| `ci-review` | `pr-ci-review`, `review-retro`, and a GitHub Actions workflow that reviews every PR; installs `review` too. Claude Code only, and it needs setup: see below |

They install once into `.agents/skills/`, where three of the five tools find them with no further
wiring. Each is written against no particular stack: where a skill needs project conventions, a
command or a tracker, it reads the project map rather than assuming a layout. The planning skills
publish to whatever issue tracker the session can reach, or write local markdown under
`docs/plans/` when there is none.

Several of these skills are meant to run only when you name them. Claude Code and Cursor honour
that from frontmatter, and Codex gets the same effect from a file emitted beside each one. On
opencode and Mistral Vibe the model can still fire them itself. See
[the matrix](docs/capability-matrix.md#skill-invocation-control).

The `review` pack also installs `.agents/agents/` and links it into Claude Code, opencode and
Cursor. Codex and Mistral Vibe have no project-scoped subagents, so nothing is emitted for them and
`review-changes` degrades to dispatching the reviewer briefs inline — the review shrinks in
mechanism, never silently to nothing.

**Prerequisites:** Node >= 20 to run the scaffolder, and `jq`, `awk`, `sed` and bash >= 3.2 on any
machine where the hooks run.

## Reviewing every pull request

`--packs ci-review` emits `.github/workflows/claude-code-review.yml`: a deterministic preflight
decides full versus incremental, Claude Code reviews the PR through the `review` pack's six
reviewers, and a poster writes the verdict. **The model has no write access to the PR.** It emits a
structured record; the poster renders it, anchors each important finding to a line in the diff, and
pins a `claude-review` commit status. A run that dies still posts "this PR has not been reviewed",
because green silence reads exactly like a clean review.

The workflow's deterministic steps are `agentspine review preflight|schema|post|metrics`, installed
from npm at the version that scaffolded the file, so the repository gets a workflow and no
toolchain of its own. Re-scaffold to move that pin.

Two setup steps, both in the comment at the top of the emitted workflow: add the
`CLAUDE_CODE_OAUTH_TOKEN` secret, and create the `ci/review-metrics` orphan branch that stores each
run's record for `review-retro` to mine.

GitHub and Claude Code only, because it runs through `anthropics/claude-code-action`. On any other
host, `review-changes` reviews the same six areas locally.

## Install safety

Refuses a dirty git tree without `--force` — git is the backup. Existing markdown is edited only
between `<!-- agentspine:start -->` markers. JSON config is deep-merged, never clobbered. TOML gets
a text-spliced managed block so comments survive. Re-runs are idempotent.

## Usage

```
agentspine [init]      Scaffold .agents/ and wire each detected tool
agentspine doctor      Probe the wiring and verify hooks actually block
agentspine review <step>   CI review tooling, run by the emitted workflow

--tools <list>     claude-code, opencode, codex, mistral-vibe, cursor (default: detected)
--packs <list>     thinking, engineering, planning, review, ci-review (default: none)
--dir <path>       Target repository (default: cwd)
--no-symlink       Copy shared content instead of symlinking it
--skip-hooks       Scaffold content but wire no hooks
--dry-run          Print the plan, write nothing
--check            Exit non-zero if the tree differs from what init would emit
--yes              Apply without confirming
--json             Machine-readable output
--force            Proceed even though the git tree is dirty
```

Every prompt has a flag, so an interactive run is always reproducible as one command — and an
agent driving the CLI never hits a prompt that hangs. Without a TTY and without `--yes`, `init`
prints its plan and exits non-zero rather than guessing.

## Verify it actually works

```bash
npx agentspine doctor
```

Fires a probe hook against each locally installed tool and checks the block landed. Hooks that
silently fail to block are the main risk in a five-tool port; `doctor` is how you catch them, and
`--json` makes its output worth attaching to a bug report.

## Contributing

`.agents/` in this repository symlinks into `templates/`, so editing a skill here edits the shipped
skill. [`CONTRIBUTING.md`](CONTRIBUTING.md) says which path is canonical and what CI will hold you
to. Bug reports are welcome.

## Licence

[MIT](LICENSE)
