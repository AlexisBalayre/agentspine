# Contributing

Thanks for looking. This project ships files into other people's repositories, which shapes most of
the rules below.

## Which path is canonical

**`templates/` is canonical. `.agents/` in this repository is a symlink into it.**

```
.agents/skills  -> templates/agents/skills
.agents/agents  -> templates/agents/agents
.agents/hooks   -> templates/agents/hooks
.agents/scripts -> templates/agents/scripts
```

That is deliberate: this repository is scaffolded by its own tool, so editing a skill while working
here edits the shipped skill, and any breakage surfaces here before it reaches anyone else. Edit
either path; they are the same bytes. What you must not do is add a file under `.agents/` that has
no counterpart in `templates/`, because `agentspine --check` compares the committed tree against
what the generator would emit and will fail.

`.github/workflows/claude-code-review.yml` is generated from
`templates/github/workflows/claude-code-review.yml` by `scripts/render-review-workflow.mjs`. Edit
the template or the script, then re-run `node scripts/render-review-workflow.mjs --write`.

## Getting set up

```bash
npm install
npm test          # vitest, no network, no API keys
npm run typecheck
npm run build
```

`jq` and bash >= 3.2 are needed to exercise the hooks. On macOS, `brew install jq shellcheck`.

## What CI holds you to

| Gate | What it catches |
| :-- | :-- |
| `npm test` | Golden files, adapter contract fixtures, the pure hook and review logic |
| `npm run typecheck` / `build` | Types, and that `dist/` still compiles |
| `agentspine --check` | The committed tree drifting from what the generator emits |
| `scripts/verify-package.sh` | A package that installs but cannot scaffold: a file missing from `files`, a lost exec bit, a path that only resolves inside this repository |
| `shellcheck -s bash` | Every shell file we ship, targeting bash 3.2 |
| `scripts/audit-templates.sh` | Employer, personal or originating-repo references in shipped content, and pointers to docs a scaffolded repo will not have |
| `scripts/audit-authors.sh` | A commit authored or committed by an address outside `.github/allowed-authors.txt` |

## House rules

[`AGENTS.md`](AGENTS.md) holds them, and every coding agent in this repository reads it, so it is
the one copy: Node-free output, near-zero runtime dependencies, never claiming parity a tool does
not have, never shipping employer-specific content, the naming taxonomy, and the comment rule. Read
it before your first change.

### Commit identity

AGENTS.md has the rule. The practical part: check `git config user.email` before your first
commit, because `scripts/audit-authors.sh` reads the whole history, so a bad identity fails CI
long after the commit that introduced it.

### Private leak-audit terms

`scripts/audit-templates.sh` checks shipped content for employer and vendor fingerprints. The
employer-specific terms are deliberately not in the script, because naming them in a public
repository would itself be the leak. Supply them as one term per line in an untracked
`.audit-fingerprints` (or another path via `AUDIT_FINGERPRINTS_FILE`), or as a regex alternation
in `AUDIT_EXTRA_FINGERPRINTS`; CI reads the latter from a secret. With neither, the script says so
on stderr and checks the public terms only. A list that does not compile as a regex fails the run
outright rather than matching nothing and reading as clean.

One thing it does not say, because it is about reviewing rather than writing:

- **A guard nobody has seen fail is not yet a guard.** If you add a check, break the thing it
  protects, watch it fail, then say so in the pull request.

## Cutting a release

The version bump and the changelog entry go in a **pull request**, like any other change: edit
`version` in `package.json`, run `npm install --package-lock-only` so the lockfile agrees, and add
the `CHANGELOG.md` section. `npm version` is the wrong tool here, because it commits to whatever
branch is checked out, and the trunk takes no commits.

Once that merges, the trunk is already at the release version, so tagging is all that is left:

```bash
git checkout main && git pull
git tag v1.2.3
git push origin v1.2.3
```

Push the tag on its own. `git push origin main --follow-tags` pushes the trunk as well as the tag,
which is a direct push to the trunk, and the git-safety policy blocks it for exactly that reason.
Create the tag before pushing it, in a separate command: the policy recognises a tag push by
resolving the ref, so a tag that does not exist yet when the hook reads the command looks like an
ordinary branch push.

The tag is the trigger. `.github/workflows/release.yml` runs the same gates ci.yml runs, verifies
the package from its own tarball, publishes to npm with provenance, and opens a GitHub release
from the `CHANGELOG.md` section matching the tag. It refuses a tag that disagrees with
`package.json`, and one with no changelog entry.

List in the changelog only what a scaffolded repository receives. Changes to CI, contributor
tooling or the design record never reach one.

The emitted review workflow pins the version that scaffolded it, so a release is also what new
scaffolds will install.

## Design decisions

Anything architectural is recorded in [`docs/design/0001-architecture.md`](docs/design/0001-architecture.md),
including the cost each decision accepts. If you want to change one of those, say in the pull
request which decision you are revisiting and why; that file is the argument, not decoration.

## Reporting a bug

Open an issue; the form asks for what it needs. `agentspine doctor --json` is worth attaching when
the repository is already scaffolded, because it names each tool, whether the wiring is present, and
whether a probe hook actually blocked.
