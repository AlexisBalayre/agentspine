---
name: review-changes
description: Multi-agent code review of local changes or a pull request across seven relevance-gated areas, consolidated into one verdict. Use when the user asks for a review of their changes, a diff, or a PR, or says "review this".
---

# Review Changes

Review local changes or a pull request across seven reviewer areas and report one consolidated
verdict. **You orchestrate: steer, gate, consolidate, act. You do not review the code yourself** —
the area reviewers do, each in its own context window.

## 1. Establish the change

- **Local (default):** the working tree against its merge base, plus the untracked files
  `git status --porcelain --untracked-files=all` lists, which no `git diff` shows. Read the diff and
  the intent from the branch's commits.
- **A pull request** (`pr [<number>]`): check it out, assert the tree is at the PR head and clean,
  and read the PR body for the author's stated intent and declared scope.
- **A spec** (`--spec <path | issue number or URL | ticket id>`, either source): what the change
  implements. An issue number takes no `#`, which would read as a PR.

When the change is empty, say so and stop: a clean tree or a mistyped PR number should cost nothing.

Run whatever lint/typecheck/test command the project defines — the project map in `AGENTS.md`
names them, and `.agents/quality.toml` holds the lint and typecheck gate — scoped to what changed. **If it fails, stop**: report the failures. A review
layered on a broken tree wastes both your effort and the author's.

## 2. Steer, yourself

Read the shape of the change before spawning anyone: what it does, what the author says it does,
and which surfaces it touches. Note anything the author declared intentional or out of scope;
reviewers must not re-raise it.

List the **spec sources**: the `--spec` argument, plus the issues and tickets the change closes
(closing keywords such as `closes`, `fixes` or `resolves` in the commit messages and the PR body, and
a PR's linked issues). Reading them is the spec reviewer's job; the exception is a ticket only one
of your own tools can fetch, whose body you paste into its brief.

## 3. Gate and spawn

Spawn a reviewer **only when its area is actually touched**. An untouched area is the cheapest cut
available.

| Reviewer | Spawn when |
| :-- | :-- |
| `review-correctness` | code with real logic changed; owns behavioural regressions tests do not cover |
| `review-security` | a trust boundary is touched (auth, routes, input handling, secrets, config) |
| `review-context` | spec, protocol or infrastructure surfaces touched (HTTP, CORS, containers, CI) |
| `review-conventions` | almost always: the project's documented rules and decision log govern this |
| `review-maintainability` | code with real logic changed |
| `review-docs` | the change adds or edits prose (docstrings, comments, markdown, copy) |
| `review-spec` | the steer found a spec source |

Skipping a reviewer that might apply is allowed — say so in the output, so coverage stays visible.

**Scale instances** only for `correctness`, `security` and `maintainability`, and only past a size
gate: roughly 400 changed lines, or 8 files spanning two or more top-level areas.

**If named subagents are unavailable**, this skill still works: read each reviewer's manifest from
`.agents/agents/<name>.md` and dispatch its body as the brief through whatever delegation primitive
the host offers. Only Claude Code, opencode and Cursor register these as named agents; the review
must not silently shrink to nothing on the others.

## 4. Brief each reviewer

The manifest defines the reviewer's expertise; your brief supplies everything else:

- The change and the author's intent, and how to fetch its own scoped slice of the diff.
- Its assignment: the part of the change it owns, and the direction where you split an area.
- For `review-spec`, the spec sources you listed.
- The steering context that concerns it: unresolved threads (do not re-raise, look harder where
  they point) and whatever the author declared intentional.
- The contract every finding meets: `{file, line, area, confidence (high/medium), tag,
  description}`, carrying the quote or citation its area requires.
- An instruction to surface separately any impediment that degraded its review.
- A reminder that its final message *is* the deliverable, not a human-facing report.

**Spawn together, then block.** The parallelism is the point, but the spawn is not the deliverable:
wait for every reviewer before consolidating, and never end a turn with one still running.

## 5. Consolidate, yourself

You hold every finding and have the only cross-area view.

- **Deduplicate.** One root issue often surfaces from several areas; merge into one finding, keeping
  the clearest description and the most severe tag.
- **The tag must match the body.** A finding whose own description concedes there is no reachable
  break consolidates as a `nit`, whatever the reviewer tagged it.
- **One area, citation-first.** A finding that rests on a spec requirement is `spec`; a defect the
  code alone proves is `correctness` or `security`, even when a requirement also names it.
- **Provenance-check.** An `important` premised on this change introducing the code must survive a
  diff check: if the line is not among the added lines, it is pre-existing — demote it. A `spec`
  finding that a requirement is missing is exempt: it rests on what the diff lacks.
- **Carry descriptions verbatim.** A description is written once, by its reviewer.
- **Respect declared scope**, and **doubt resolves to keep**: an unproven mechanism is dropped, a
  verified one with no reachable trigger stays as a `nit`.

## 6. Validate before acting, never before reporting

Validation buys precision, not recall, and precision is only worth paying for where something is
about to act loudly on the finding.

- **Reporting to a human:** spawn no validator. The human is the final judge.
- **Fixing:** spawn one `review-validator` per `important` before editing. `nit` findings are never
  auto-fixed.

## 7. Act

**Report** (default): each finding with its tag, file and line, the issue, why it was flagged, and
a suggested fix. Important findings first. If empty, say which areas ran and that nothing was found.

**Fix** (`--fix`): apply each confirmed finding, one scoped edit per finding — no adjacent
refactoring. Never a finding `review-spec` raised: a missing requirement is unbuilt work, not a fix,
and its fix would rest on issue text anyone may have written, so list those for the user instead. Re-run the project's checks afterwards to prove no regression, and report the result.
List anything you noticed but did not touch, and ask before editing it.

Impediments reported by reviewers never appear as findings.
