---
name: retro
description: "Conduct a retrospective on a coding session."
disable-model-invocation: true
---

The user has asked for a **retrospective**. You are suggesting improvements to the coding agent's **environment** to improve future runs. (The CI review pipeline, where the repository runs it, has its own retrospective over its run records: the `review-retro` skill.)

## Steps

1. Invoke the `writing-for-agents` skill for the writing style guide.

2. Read the primary sources for the session the user specifies. If the user doesn't specify a session, default to the current one. Claude Code keeps each session's transcript at `~/.claude/projects/<project path with every character but letters and digits replaced by "-">/<session id>.jsonl`; that naming is observed, not documented, so if the directory is not there, ask the user which one under `~/.claude/projects/` is this project's. On any other host, ask the user where its transcript is, or work from the current conversation when that is the session; never guess a path.

3. Look for candidates for improvement in these categories.

- **Navigation**: how easy was it for the agent to find the right files? Are there hidden dependencies between files? Would a **navigation pointer** make it easier? _Use when_ the session took a long time to find a piece of information.
- **Automated checks**: are there automated checks that could catch errors the agent made? Linting, typing, tests, filesystem linters? Read the repo's own checks first (the lint, typecheck and test commands in the project map in `AGENTS.md`; the quality gate in `.agents/quality.toml`, which runs lint and typecheck at every turn end but never tests; the hook policies under `.agents/hooks/policies/`; and the workflows under `.github/workflows/`), so a check that already exists but sits unwired or silently broken is the finding, not a reinvention. A gate command left commented out in `.agents/quality.toml` is one of those: the `adapt-to-project` skill confirms and activates it. A repo with no **guardrail** (no gate commands, and no CI job running lint/typecheck/test) is itself a finding: an un-linted repo is a standing missed opportunity, not a neutral default. _Use when_ the agent made a mistake an automated check could have caught, or the repo has no guardrail at all.
- **Coding standards**: should the **reviewer agents**, where the `review` pack installs them (`review-conventions`, which `review-changes` and `pr-ci-review` dispatch), be given a new rule to enforce? Should an existing rule be removed or clarified? Classify the violation first: a **mechanical** one (a fixed syntactic pattern, a banned API, an import shape, a file-location rule) gets a deterministic check, full stop: a rule in the repo's own linter, a command in `.agents/quality.toml`, a policy under `.agents/hooks/policies/` (`.agents/hooks/CONTRACT.md` is the contract a new one follows), or a CI job, whichever the repo's language and existing guardrail make cheapest. Default to building the check over writing the rule. Reserve the project's convention docs (the project map says where they live) for genuine **judgement calls** (cross-file consistency, "matches the surrounding style," anything no guardrail could ever substitute for). _Use when_ a reviewer agent failed to catch a mistake.
- **Global AGENTS.md**: are there any steering instructions in `AGENTS.md`, or in a tool-specific file such as `CLAUDE.md`, that should be moved to the convention docs (or automated checks) instead? _Use when_ those files are particularly large - in the repo OR the user's global scope (on Claude Code, `~/.claude/CLAUDE.md`).
- **Tool economy**: did the agent make expensive tool calls that could be streamlined? Is there any custom tooling (CLI's, MCP's) that is particularly token-inefficient? _Use when_ the agent made an expensive tool call.
- **No-ops**: look for instructions in steering files that don't modify the agent's behavior. _Use when_ the steering files are large and unwieldy.
- **Information access**: look for opportunities to increase the agent's access to information. Teeing dev server logs, readonly access to third-party services. _Use when_ a crucial piece of information was not available to the agent.

4. Present these candidates to the user, in order of severity.

## Reference

### Implementation vs Review

Remember that all work goes through two stages: implementation and review. The implementation agent has the most **context pressure**. They are responsible for exploration, writing code, and debugging failures.

The review agent has the least context pressure - it receives a diff, so no exploration needed. It often does not need to write code or debug.

This means that the review agents should be responsible for imposing coding standards, not the implementation agent.

### Files

You have access to several files in the repo:

- `AGENTS.md`, and the tool-specific files that import it (`CLAUDE.md`): these are pushed to the context window of any agent working in this repo. They should be used incredibly sparingly, usually only for **navigation pointers** to other files. Its project map is one.
- The convention docs, wherever the project map says they live: the coding standards, which the reviewer agents enforce on the diff. Point a doc at other docs rather than growing it past 1,000 lines.
- Docs: reference files, pointed to by other files. Look for existing docs before writing new ones.
- Skills, under `.agents/skills/`: use skills for docs (since their description goes into the agent's context window), or for user-invoked commands. Follow the advice in the `writing-for-agents` skill.
