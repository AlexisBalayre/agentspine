import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Stack, Tool } from "./detect.utils.js";

export type Action =
  | { kind: "create"; target: string; content: string }
  | { kind: "splice"; target: string; content: string; hashComments?: boolean }
  | { kind: "merge-json"; target: string; value: Record<string, unknown> }
  | { kind: "symlink"; target: string; to: string }
  | { kind: "copy-dir"; target: string; from: string }
  | { kind: "copy"; target: string; from: string }
  | { kind: "skip"; target: string; reason: string };

/** Installed with every scaffold: it confirms the inferred gate and writes the map other skills read. */
export const CORE_SKILLS = ["adapt-to-project"] as const;

export const PACKS = {
  thinking: [
    "grilling", "grill-me", "grill-with-docs", "codebase-design", "domain-modeling",
    "improve-codebase-architecture", "handoff", "prototype", "zoom-out", "writing-for-agents",
    "research", "wait-what", "to-questionnaire", "caveman",
  ],
  engineering: ["tdd", "diagnosing-bugs", "resolving-merge-conflicts", "wizard", "find-dead-code"],
  planning: ["to-spec", "to-tickets", "wayfinder", "implement"],
  review: ["review-changes", "address-review-comments", "pr-description"],
  "ci-review": ["pr-ci-review", "review-retro"],
} as const;

/** Packs whose skills invoke another pack's skills by name, so installing one alone would dangle. */
const PACK_REQUIRES: Partial<Record<Pack, Pack[]>> = {
  planning: ["thinking", "engineering"],
  "ci-review": ["review"],
};

export function resolvePacks(requested: Pack[]): Pack[] {
  const wanted = new Set<Pack>();
  const visit = (pack: Pack) => {
    if (wanted.has(pack)) return;
    wanted.add(pack);
    for (const required of PACK_REQUIRES[pack] ?? []) visit(required);
  };
  requested.forEach(visit);
  return (Object.keys(PACKS) as Pack[]).filter((pack) => wanted.has(pack));
}

/** The review pack dispatches named subagents, which only three of the five hosts support. */
const PACKS_NEEDING_AGENTS: Pack[] = ["review"];

const AGENT_DIRS: Partial<Record<Tool, string>> = {
  "claude-code": ".claude/agents",
  opencode: ".opencode/agent",
  cursor: ".cursor/agents",
};

export type Pack = keyof typeof PACKS;

export type PlanOptions = {
  root: string;
  templates: string;
  tools: Tool[];
  stacks: Stack[];
  symlink: boolean;
  hooks: boolean;
  /** Gate commands nobody confirmed are written commented out, never silently active. */
  confirmed: boolean;
  packs: Pack[];
  /** Pinned into emitted CI, which installs this exact agentspine to run its review tooling. */
  version: string;
};

const AGENTS_BODY = `## Agent setup

Shared instructions for every coding agent in this repository. Tool-specific layers point here
rather than repeating it.

- Conventions, skills and hooks live in \`.agents/\`.
- The project's commands, trunk, tracker and doc locations are in the \`## Project map\` section of
  this file. If it is missing, the \`adapt-to-project\` skill writes it; skills read it rather
  than assuming a layout.
- The quality gate reads \`.agents/quality.toml\`.
- Work on a change in its own worktree: \`.agents/scripts/worktree-create.sh <name>\`, configured by
  \`.agents/worktree.env\`. \`.agents/scripts/worktree-clean.sh\` removes those whose branch merged.
- Hook policies are shared shell scripts; each tool has a thin adapter in
  \`.agents/hooks/adapters/\`. The contract is \`.agents/hooks/CONTRACT.md\`.

Managed by agentspine. Edit outside the markers, or edit \`.agents/\` directly.`;

const CLAUDE_BODY = "@AGENTS.md";

const WORKTREE_ENV = `# Read by .agents/scripts/worktree-create.sh and worktree-clean.sh. Sourced as shell.
#
# WORKTREE_INSTALL        run inside each new worktree, which starts with no dependencies
#                         installed; empty skips it. A failing command fails the create.
# WORKTREE_BRANCH_PREFIX  new branches are <prefix>/<name>; clean only touches this prefix

WORKTREE_INSTALL=""
WORKTREE_BRANCH_PREFIX="feature"
`;

const claudeHooks = (hooks: boolean) =>
  hooks
    ? {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: HOOK_COMMANDS["claude-code"]("git-safety"),
                  timeout: 5,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: HOOK_COMMANDS["claude-code"]("quality-gate"),
                  timeout: 300,
                },
              ],
            },
          ],
        },
      }
    : {};


const REPO_ROOT_CMD = '"$(git rev-parse --show-toplevel)"';

/** Each host's hook command, exactly as wired. doctor runs these, not the adapter by path. */
export const HOOK_COMMANDS = {
  "claude-code": (policy: string) => `"$CLAUDE_PROJECT_DIR"/.agents/hooks/adapters/claude-code.sh ${policy}`,
  codex: (policy: string) => `${REPO_ROOT_CMD}/.agents/hooks/adapters/codex.sh ${policy}`,
  "mistral-vibe": (policy: string) => `${REPO_ROOT_CMD}/.agents/hooks/adapters/mistral-vibe.sh ${policy}`,
  cursor: (policy: string) => `./.agents/hooks/adapters/cursor.sh ${policy}`,
} satisfies Partial<Record<Tool, (policy: string) => string>>;

const codexHooks = `[[hooks.PreToolUse]]
matcher = "^(Bash|shell)$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = '${HOOK_COMMANDS.codex("git-safety")}'
timeout = 5

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = '${HOOK_COMMANDS.codex("quality-gate")}'
timeout = 300`;

// `match` is only valid on tool hooks, so post_agent must omit it.
const vibeHooks = `[[hooks]]
name = "agentspine-git-safety"
type = "pre_tool"
match = "*"
command = '${HOOK_COMMANDS["mistral-vibe"]("git-safety")}'
timeout = 5

[[hooks]]
name = "agentspine-quality-gate"
type = "post_agent"
command = '${HOOK_COMMANDS["mistral-vibe"]("quality-gate")}'
timeout = 300`;

const cursorHooks = {
  version: 1,
  hooks: {
    beforeShellExecution: [{ command: HOOK_COMMANDS.cursor("git-safety") }],
    stop: [{ command: HOOK_COMMANDS.cursor("quality-gate") }],
  },
};

export function renderQualityToml(stacks: Stack[], confirmed: boolean): string {
  const header = `# Quality gate — read by .agents/hooks/policies/quality-gate.sh at turn-end.
#
# One [[gate]] block per stack. A missing or empty value skips that step; a file with
# no gates is a silent no-op. Only \`key = "value"\` entries are supported, and escapes
# are not interpreted — put regexes in single-quoted literal strings.
#
#   paths      regex matched against the START of a changed path (omit = whole repo)
#   files      regex the changed file must match
#   lint_fix   run first; receives matched files as arguments
#   lint       must exit 0; receives matched files as arguments; non-zero blocks the turn
#   typecheck  run once, no arguments
`;

  const gates = (stacks.length > 0 ? stacks : [{ files: "" }]).map((stack) => {
    const prefix = confirmed ? "" : "# ";
    const lines = [
      "[[gate]]",
      `paths = ''`,
      `files = '${stack.files}'`,
      ...(["lintFix", "lint", "typecheck"] as const)
        .map((key) => {
          const value = stack[key];
          if (!value) return null;
          const name = key === "lintFix" ? "lint_fix" : key;
          return `${prefix}${name} = "${value}"`;
        })
        .filter((line): line is string => line !== null),
    ];
    return lines.join("\n");
  });

  const note = confirmed
    ? ""
    : `#
# The commands below were inferred from this repository, not confirmed by you, so they
# are commented out. A gate you believe is running but is not is worse than one that is
# obviously unfinished. Uncomment what is correct.
`;

  return `${header}${note}\n${gates.join("\n\n")}\n`;
}

export function buildPlan(options: PlanOptions): Action[] {
  const { root, templates, tools, stacks, symlink, hooks, confirmed, version } = options;
  const packs = resolvePacks(options.packs);
  const actions: Action[] = [];
  const abs = (p: string) => path.join(root, p);

  actions.push({ kind: "copy-dir", target: ".agents/hooks", from: path.join(templates, "agents/hooks") });
  actions.push({ kind: "copy-dir", target: ".agents/scripts", from: path.join(templates, "agents/scripts") });
  actions.push(
    existsSync(abs(".agents/worktree.env"))
      ? { kind: "skip", target: ".agents/worktree.env", reason: "already configured" }
      : { kind: "create", target: ".agents/worktree.env", content: WORKTREE_ENV },
  );
  actions.push({ kind: "splice", target: ".gitignore", content: ".worktrees/", hashComments: true });
  actions.push({
    kind: "create",
    target: ".agents/skills/README.md",
    content: `# Skills\n\nOne directory per skill, each with a \`SKILL.md\` carrying \`name\` and \`description\`\nfrontmatter (the Anthropic Agent Skills spec).\n\nCodex, opencode and Mistral Vibe read this path natively. Claude Code and Cursor reach it\nthrough a symlink.\n`,
  });

  const wantsAgents = packs.some((pack) => PACKS_NEEDING_AGENTS.includes(pack));
  if (wantsAgents) {
    actions.push({ kind: "copy-dir", target: ".agents/agents", from: path.join(templates, "agents/agents") });
    for (const tool of tools) {
      const dir = AGENT_DIRS[tool];
      if (!dir) {
        // Vibe's agents are user-global launch profiles and Codex embeds them in config:
        // neither is a like-for-like target, so nothing is emitted and the skill degrades.
        actions.push({ kind: "skip", target: `${tool} agents`, reason: "no project-scoped subagents; review-changes degrades to inline briefs" });
        continue;
      }
      actions.push(
        symlink
          ? { kind: "symlink", target: dir, to: relativeToAgents(dir) }
          : { kind: "copy-dir", target: dir, from: abs(".agents/agents") },
      );
    }
  }

  for (const skill of [...CORE_SKILLS, ...packs.flatMap((pack) => PACKS[pack])]) {
    actions.push({
      kind: "copy-dir",
      target: `.agents/skills/${skill}`,
      from: path.join(templates, "agents/skills", skill),
    });
  }

  actions.push(
    existsSync(abs(".agents/quality.toml"))
      ? { kind: "skip", target: ".agents/quality.toml", reason: "already configured" }
      : { kind: "create", target: ".agents/quality.toml", content: renderQualityToml(stacks, confirmed) },
  );

  if (packs.includes("ci-review")) {
    const target = ".github/workflows/claude-code-review.yml";
    if (!tools.includes("claude-code")) {
      actions.push({ kind: "skip", target, reason: "the CI review runs through claude-code-action; add --tools claude-code" });
    } else if (existsSync(abs(target))) {
      actions.push({ kind: "skip", target, reason: "already present; never overwritten" });
    } else {
      const workflow = readFileSync(path.join(templates, "github/workflows/claude-code-review.yml"), "utf8");
      actions.push({ kind: "create", target, content: workflow.replaceAll("__AGENTSPINE_VERSION__", version) });
    }
  }

  actions.push(spliceOrCreate(root, "AGENTS.md", AGENTS_BODY));

  if (tools.includes("claude-code")) {
    actions.push(spliceOrCreate(root, "CLAUDE.md", CLAUDE_BODY));
    if (hooks) actions.push({ kind: "merge-json", target: ".claude/settings.json", value: claudeHooks(true) });
    actions.push(
      symlink
        ? { kind: "symlink", target: ".claude/skills", to: "../.agents/skills" }
        : { kind: "copy-dir", target: ".claude/skills", from: abs(".agents/skills") },
    );
  }

  if (tools.includes("codex")) {
    actions.push({ kind: "skip", target: ".codex/skills", reason: "codex reads .agents/skills natively" });
    if (hooks) actions.push({ kind: "splice", target: ".codex/config.toml", content: codexHooks, hashComments: true });
  }

  if (tools.includes("mistral-vibe")) {
    actions.push({ kind: "skip", target: ".vibe/skills", reason: "mistral-vibe reads .agents/skills natively" });
    if (hooks) actions.push({ kind: "splice", target: ".vibe/hooks.toml", content: vibeHooks, hashComments: true });
  }

  if (tools.includes("cursor")) {
    actions.push({ kind: "skip", target: ".cursor/skills", reason: "cursor reads .agents/skills natively" });
    if (hooks) actions.push({ kind: "merge-json", target: ".cursor/hooks.json", value: cursorHooks });
  }

  if (tools.includes("opencode")) {
    actions.push({ kind: "skip", target: ".opencode/skills", reason: "opencode reads .agents/skills natively" });
    if (hooks) {
      actions.push({
        kind: "copy",
        target: ".opencode/plugins/agentspine.js",
        from: path.join(templates, "agents/plugins/opencode/agentspine.js"),
      });
    }
  }

  return actions;
}

/** Depth-aware link target: `.claude/agents` needs `../.agents/agents`. */
function relativeToAgents(dir: string): string {
  const depth = dir.split("/").length - 1;
  return `${"../".repeat(depth)}.agents/agents`;
}

function spliceOrCreate(_root: string, target: string, body: string): Action {
  // splice handles a missing file too: an empty document becomes just the managed block.
  return { kind: "splice", target, content: body };
}
