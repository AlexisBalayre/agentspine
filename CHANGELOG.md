# Changelog

Notable changes to what `agentspine` ships. Changes to this repository that never reach a
scaffolded tree — CI gates, contributor tooling, the design record — are not listed here.

The emitted CI review workflow pins the version that scaffolded it, so upgrading a scaffolded
repository means re-running `npx agentspine`.

## Unreleased

### Added

- `retro` in the `thinking` pack: a retrospective on a coding session that proposes changes to
  the agent's environment (navigation, automated checks, review rules, steering files). On Claude
  Code it reads the session transcript; on other hosts it asks where the transcript is.
- `implement-spec` in the `planning` pack: implements a spec's tickets on one integration branch,
  through parallel implementer subagents in their own worktrees, then a draft PR that is marked
  ready once every ticket lands. It is reviewed by the CI review where the repository runs it, and
  by `review-changes` otherwise.
- `.agents/scripts/worktree-remove.sh <name>...` removes the named worktrees, and deletes each
  one's branch once no work is lost: a merged pull request shipped its tip, or origin's copy holds
  every commit. Origin's copy goes too on the merged-PR path, unless the branch moved past the
  merged tip. A worktree with uncommitted or untracked files, or a detached HEAD, is kept, and so
  is any branch outside `WORKTREE_BRANCH_PREFIX` or any branch at all when the fetch fails. The
  merged-PR check needs an authenticated `gh`; without one, only origin's copy vouches for a
  branch. `worktree-clean.sh` is unchanged and still force-removes.
- A `review-spec` reviewer in the `review` pack, which holds a change against the issue or spec it
  implements: requirements missing, partial or built wrong, and work no requirement asked for.
  `pr-ci-review` spawns it when the PR closes an issue, `review-changes` when the change names a
  spec (`--spec`). Its findings are never auto-fixed and never carry a committable suggestion,
  since a fix written from issue text rests on whoever wrote the issue.
- `@claude review` reads the words after it: `full`, a depth (`quick`, `deep`) and reviewer areas,
  in any order. A quick or area-restricted review is partial: its status says so, and the next
  review diffs from the last complete one. `deep` also runs the orchestrator at high effort.
- The emitted workflow reacts to a `@claude review` comment with the verdict: 🚀, 👍 for a partial
  review, 👎 when important findings were posted, 😕 when the run never reached one. The poster
  job gains `issues: write` for it.
- The metrics record carries `model_usage` (the run's tokens and cost split by model, subagents
  included), `review_depth`, `review_areas` and `permission_denials`; `schema_version` is now 3.
  `tokens` is labelled as the orchestrator's own turns, which it always was.

### Changed

- `planning` now installs `review` as well, since `implement-spec` invokes `pr-description` and
  `review-changes`. `--packs planning` therefore also installs the seven reviewer agents.
- The wizard's `template.sh` writes values single-quoted and reads them back intact, writes
  through a symlink instead of replacing it, leaves the env file readable by its owner only, and
  fails at a closed stdin instead of carrying on with an empty answer.
- Smaller clarifications to `diagnosing-bugs`, `grilling`, `handoff`, `implement`, `tdd`,
  `wayfinder` and `pr-description`, whose Merge Danger section now records whether a change is a
  one-way or two-way door and its blast radius.
- The emitted review workflow runs its orchestrator on Opus 5.5 instead of Sonnet 5, and pins the
  `opus` and `sonnet` aliases the reviewers are spawned with to `claude-opus-5-5` and
  `claude-sonnet-5-5`, so a Claude Code bump cannot move a tier silently. A review costs more per
  run. It runs through `claude-code-action` v1.0.237.
- `.claude/agents/` is now a directory of real files, not a link to `.agents/agents/`: each shared
  reviewer manifest, plus the keys only Claude Code reads. `review-correctness`, `review-security`
  and `review-validator` ask for `effort: high` there. The key stays out of the shared manifests
  because opencode forwards an agent key it does not know to the model provider. Re-scaffolding
  replaces the old link. An edit under `.agents/agents/` no longer reaches Claude Code.
- The review record carries `reviewers_returned`, and the metrics record `incomplete_reason`; the
  metrics `schema_version` is now 2. The workflow, the `pr-ci-review` skill and the tooling move
  together, so re-scaffold rather than bumping the workflow's pin by hand: the new tooling rejects
  a record from the old skill as not reviewed.

### Removed

- `resolving-merge-conflicts`, retired upstream. Re-scaffolding does not delete it: a repository
  scaffolded earlier keeps `.agents/skills/resolving-merge-conflicts/` until it is removed by hand.

### Fixed

- A review whose reviewers had not reported was posted as "No issues found". Recent Claude Code
  runs a subagent in the background unless asked otherwise, and the action keeps the first result
  a run emits, so an orchestrator that ended its turn early handed over an empty record, and the
  preflight then took that head as reviewed. The workflow now turns background tasks off, and the
  poster checks the record: one where fewer reviewers returned than were spawned, or where a full
  review spawned none, is posted as incomplete with a failed `claude-review` status and a failed
  step, without its findings, and is recorded as errored so the next run reviews the head again.
- A review step that reported success and left no structured output, as the action does when it
  skips itself, posted "not reviewed" but left the poster's step green and the record clean. Both
  now fail.

### Security

- The emitted review workflow locks the model's permissions in managed settings, which a PR's
  files cannot widen: read-only `gh` and `git` verbs only, file edits denied in every mode, and
  Bash in a sandbox that writes only to the checkout and Claude Code's temp directory, reaches only
  `api.github.com`, and fails the run if it cannot start. Before, the skill's own `allowed-tools` (`Bash(git *)`, `Bash(gh *)`)
  widened the workflow's allowlist, and the allowlist itself admitted `git grep -O` and `git
  difftool`, both of which run a command, on a runner holding the Claude OAuth token. Credentials
  are now also scrubbed from the model's shell.
- Both review jobs keep their hand-off files under the runner's temp directory instead of the
  checkout, which is the PR head: a fork could commit `posted.json` or `review-output/` as a
  symlink the write would follow, or plant a `review-output/` the poster read as the verdict when
  the review left none.

## 0.1.3 — 2026-09-22

### Fixed

- `doctor` reported Codex and Mistral Vibe hooks as blocking in a directory that is not a git
  repository, where they block nothing. Their wiring finds the adapter through
  `git rev-parse --show-toplevel`, which resolves to nothing there, but the probe ran the adapter
  by its absolute path and never exercised that lookup. The probe now runs each host's hook
  command exactly as wired, from the project root, and says when the missing repository is why.
- The emitted review workflow ran for anyone: any PR opened against the repository, and any
  `@claude review` comment, started a run holding the review token with the model reading the
  diff. Both triggers now require the author to be the repository's owner, a member of its
  organisation, or an invited collaborator. A push to a PR triggers a review only when the PR's
  author made it, so someone else pushing to a trusted author's branch cannot start one.
- The `git-safety` hook read a quoted heredoc's body for command substitutions, although the
  shell expands nothing there. A file written through `cat <<'EOF'` whose text named a forbidden
  command in backticks was blocked as though the command had run. A quoted body is no longer
  scanned for substitutions; its lines are still read as commands, so one that begins with a
  forbidden command is blocked as before. An unquoted body is still scanned, and a body fed to a
  shell, by redirection, pipe or `eval`, is read as commands in full. That last case was never
  caught before when the heredoc sat inside `eval "$(...)"`.
- The `git-safety` trunk rule read the branch of the session's directory, whatever the command
  did first. `cd <other checkout> && git commit` was blocked when the session sat on the trunk,
  and `git -C <trunk checkout> commit` was allowed from a feature worktree. The rule now follows
  `cd` through `&&`, `;` and newlines, and `-C` on each git command, to the checkout the commit or
  push runs in. Where it cannot know, behind a subshell, a pipeline, `||`, a shell runner or a
  target it cannot resolve, it reads the session's directory as before.

## 0.1.2 — 2026-09-21

### Fixed

- The `git-safety` hook policy read the command as one string, so it could not tell running a
  command from naming one. A commit message, an echo, a heredoc or a grep pattern that quoted a
  command the policy forbids was blocked as though you had run it, which in a repository whose
  subject is git makes ordinary work impossible. The policy now splits the line into the commands
  a shell would run, honouring quotes and backslash escapes, and reads those.
- The same change closes a gap in the other direction: a rule naming a subcommand looked for it
  immediately after `git`, so `git -C <path> push origin <trunk>` pushed the trunk unchallenged.
  git's global options are now stepped over, and `bash -c "<command>"` is examined as a command
  rather than as text.

`rm -rf /` is deliberately still matched against the whole line: being wrong about a command that
destroys the machine costs a retry, and being wrong the other way costs the machine.

## 0.1.1 — 2026-09-21

### Fixed

- The `git-safety` hook policy blocked pushing a release tag from the trunk. A tag push publishes
  a ref that points at the trunk; it does not move the trunk, so the branch-first rule never
  applied to it. A push that carries the trunk as well as the tag, such as `--follow-tags`, is
  still a direct push to the trunk and is still blocked, as is any push carrying no tag at all.

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
