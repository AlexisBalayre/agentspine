# Changelog

Notable changes to what `agentspine` ships. Changes to this repository that never reach a
scaffolded tree — CI gates, contributor tooling, the design record — are not listed here.

The emitted CI review workflow pins the version that scaffolded it, so upgrading a scaffolded
repository means re-running `npx agentspine`.

## 0.1.1 — 2026-09-21

### Fixed

- The `git-safety` hook policy blocked pushing a release tag from the trunk. A tag push publishes
  a ref that points at the trunk; it does not move the trunk, so the branch-first rule never
  applied to it. Pushes that carry no tag are still blocked on the trunk.

## 0.1.0 — 2026-09-18

First published release. `npx agentspine` scaffolds `.agents/` and wires Claude Code, Codex,
opencode, Mistral Vibe and Cursor to read one copy of it.

- `init` writes conventions, skills, hook policies and worktree scripts into `.agents/`, then
  links or copies that tree into each tool's directory. Existing markdown is edited only between
  `<!-- agentspine:start -->` markers, JSON is deep-merged and TOML is text-spliced.
- `doctor` fires a probe hook at each locally installed tool and reports whether the block landed.
- `review preflight|schema|post|metrics` backs the emitted GitHub Actions review workflow.
- Skill packs `thinking`, `engineering`, `planning`, `review` and `ci-review`, all opt-in.
- On a host that refuses symlinks the shared tree is copied instead, and the outcome says which
  one you got.
