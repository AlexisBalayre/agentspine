---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the tracker this session can reach (or its file under `docs/plans/` when there is no tracker) and state its title before starting. If the reference is ambiguous, ask. A worktree has its own `docs/plans/` only when the project commits it; when it is ignored, read it by absolute path from the main checkout.

Invoke the `tdd` skill where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end. The project map in `AGENTS.md` names the commands; a check the project does not have is skipped, and a command you had to guess is reported as a guess.

Once done, review the diff against the spec or tickets: every acceptance criterion met, nothing built beyond them.

Commit your work to the current branch. If that branch is the trunk (the repository's default branch), create a feature branch and commit there instead.
