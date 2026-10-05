# templates/

Everything here is copied or symlinked into a user's repository. Two hard rules:

- **Node-free.** Markdown and POSIX shell only.
- **Repo-agnostic.** No references to a specific project's convention paths, tracker, or stack.
  A skill that needs project conventions asks for them; it does not assume a layout.

Layout mirrors what is emitted:

```
agents/skills/<name>/SKILL.md    Anthropic Agent Skills spec: name + description frontmatter
agents/agents/<name>.md          intersection-only frontmatter (name, description, body);
                                 Claude Code's copy is rendered from it, plus Claude-only keys
agents/hooks/policies/*.sh       tool-agnostic; read the normalised AGENT_* contract
agents/hooks/adapters/*.sh       per-tool input parsing and exit-code mapping
agents/scripts/*.sh              worktree helpers, emitted to .agents/scripts/
github/workflows/*.yml           emitted to .github/workflows/ by the ci-review pack
```

`__AGENTSPINE_VERSION__` in an emitted file is replaced at scaffold time with the version that
wrote it, so CI installs the tooling its workflow was written against.
