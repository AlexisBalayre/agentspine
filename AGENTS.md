# agentspine

A one-shot CLI that scaffolds a shared agent setup across Claude Code, Codex, opencode, Mistral
Vibe, and Cursor.

## Read first

- [`docs/design/0001-architecture.md`](docs/design/0001-architecture.md) — the 27 decisions and
  the cost accepted by each. Do not relitigate one without recording why.
- [`docs/capability-matrix.md`](docs/capability-matrix.md) — what each tool actually supports.
  Verified from docs, with dates. If a claim here is not in that file, verify it before relying on it.

## Rules specific to this repo

- **Emitted output is Node-free.** Anything written into a user's repository is markdown or POSIX
  shell. Node exists only while the scaffolder runs.
- **Near-zero runtime dependencies.** Every dependency is npx cold-start latency. A new one needs a
  justification in the PR.
- **Never claim parity a tool does not have.** A capability gap is documented in the matrix, not
  emulated. Silent degradation is the failure mode this project exists to avoid.
- **Never ship employer-specific or personal content.** No internal tracker IDs, security-scanner
  identifiers, org names, or internal URLs in templates, docs, or tests.
- **Facts about the five tools come from their docs**, with the source and date recorded in the
  matrix. Where the docs are silent, read the tool's source and cite file and line.

## Naming taxonomy

`*.script.ts` (entrypoints) · `*.utils.ts` (pure helpers) · `*.schemas.ts` (validation).

## Comments

Default to none. Add `//` only for a non-obvious why — an invariant, a unit, an ordering
constraint, a gotcha. Never narrate what the code does.

## Git workflow

Never commit to `main`. Branch per change, PRs only.

Commit as `alexis@balayre.com`. `scripts/audit-authors.sh` fails CI on any author or committer
outside [`.github/allowed-authors.txt`](.github/allowed-authors.txt), because a commit published
under the wrong account can only be withdrawn by rewriting public history.

<!-- agentspine:start -->
## Agent setup

Shared instructions for every coding agent in this repository. Tool-specific layers point here
rather than repeating it.

- Conventions, skills and hooks live in `.agents/`.
- The project's commands, trunk, tracker and doc locations are in the `## Project map` section of
  this file. If it is missing, the `adapt-to-project` skill writes it; skills read it rather
  than assuming a layout.
- The quality gate reads `.agents/quality.toml`.
- Work on a change in its own worktree: `.agents/scripts/worktree-create.sh <name>`, configured by
  `.agents/worktree.env`. `.agents/scripts/worktree-clean.sh` removes those whose branch merged.
- Hook policies are shared shell scripts; each tool has a thin adapter in
  `.agents/hooks/adapters/`. The contract is `.agents/hooks/CONTRACT.md`.

Managed by agentspine. Edit outside the markers, or edit `.agents/` directly.
<!-- agentspine:end -->
