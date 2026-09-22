import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const TSX = path.resolve("node_modules/.bin/tsx");
const CLI = path.resolve("src/cli.ts");

function runCli(args: string[]) {
  const result = spawnSync(TSX, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A repository shaped like the common case: existing agent config the user cares about. */
function demoRepo({ commit = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentspine-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, "package.json"), '{ "name": "demo" }\n');
  writeFileSync(path.join(dir, "AGENTS.md"), "# Demo\n\nOur house rules.\n");
  mkdirSync(path.join(dir, ".claude"));
  writeFileSync(
    path.join(dir, ".claude", "settings.json"),
    '{\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n',
  );
  if (commit) {
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  }
  return dir;
}

let repo: string;
beforeEach(() => {
  repo = demoRepo();
});

describe("init", () => {
  it("writes nothing on a dry run", () => {
    const { status } = runCli(["--dir", repo, "--dry-run"]);
    expect(status).toBe(0);
    expect(existsSync(path.join(repo, ".agents"))).toBe(false);
  });

  it("refuses a dirty tree without --force", () => {
    writeFileSync(path.join(repo, "dirty.txt"), "x");
    const { status, stderr } = runCli(["--dir", repo, "--yes"]);
    expect(status).toBe(1);
    expect(stderr).toContain("dirty");
  });

  // Non-interactive without --yes must never guess on someone's repository.
  it("refuses to write unconfirmed when there is no TTY", () => {
    const { status } = runCli(["--dir", repo]);
    expect(status).toBe(2);
    expect(existsSync(path.join(repo, ".agents"))).toBe(false);
  });

  it("keeps the user's prose and adds a single managed block", () => {
    runCli(["--dir", repo, "--yes"]);
    const agents = readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("Our house rules.");
    expect(agents.match(/agentspine:start/g)).toHaveLength(1);
  });

  it("merges into settings.json without discarding the user's keys", () => {
    runCli(["--dir", repo, "--yes"]);
    const settings = JSON.parse(readFileSync(path.join(repo, ".claude/settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it("is idempotent: a second run duplicates nothing", () => {
    runCli(["--dir", repo, "--yes"]);
    runCli(["--dir", repo, "--yes", "--force"]);
    const agents = readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    const settings = JSON.parse(readFileSync(path.join(repo, ".claude/settings.json"), "utf8"));
    expect(agents.match(/agentspine:start/g)).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  // Decision 10: a gate the user believes is running but is not is worse than an unfinished one.
  it("leaves inferred gate commands commented out", () => {
    runCli(["--dir", repo, "--yes"]);
    const gate = readFileSync(path.join(repo, ".agents/quality.toml"), "utf8");
    expect(gate).toContain("# lint =");
    expect(gate).not.toMatch(/^lint =/m);
  });

  it("symlinks skills by default and copies with --no-symlink", () => {
    runCli(["--dir", repo, "--yes"]);
    expect(lstatSync(path.join(repo, ".claude/skills")).isSymbolicLink()).toBe(true);

    const other = demoRepo();
    runCli(["--dir", other, "--yes", "--no-symlink"]);
    expect(lstatSync(path.join(other, ".claude/skills")).isSymbolicLink()).toBe(false);
  });

  it("rejects an unsupported tool by name", () => {
    const { status, stderr } = runCli(["--dir", repo, "--tools", "aider", "--yes"]);
    expect(status).toBe(1);
    expect(stderr).toContain("Unsupported tool");
  });

  it("wires every supported tool when asked", () => {
    const { status, stderr } = runCli(["--dir", repo, "--tools", "claude-code,opencode,codex,mistral-vibe,cursor", "--yes"]);
    expect(status, stderr).toBe(0);

    const codex = readFileSync(path.join(repo, ".codex/config.toml"), "utf8");
    expect(codex).toContain("[[hooks.PreToolUse]]");
    expect(codex).toContain("codex.sh git-safety");

    const vibe = readFileSync(path.join(repo, ".vibe/hooks.toml"), "utf8");
    expect(vibe).toContain('type = "pre_tool"');
    // `match` is only valid on tool hooks, so the post_agent entry must not carry one.
    expect(vibe.split("[[hooks]]")[2]).not.toContain("match =");

    const cursor = JSON.parse(readFileSync(path.join(repo, ".cursor/hooks.json"), "utf8"));
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.beforeShellExecution).toHaveLength(1);

    // Cursor documents `.agents/skills/` as a project-level path (matrix, read 2026-09-18), so
    // nothing is emitted for it, the same as Codex, opencode and Vibe.
    expect(existsSync(path.join(repo, ".cursor/skills"))).toBe(false);
    expect(existsSync(path.join(repo, ".codex/skills"))).toBe(false);
    // Claude Code is the one host that still needs the link.
    expect(lstatSync(path.join(repo, ".claude/skills")).isSymbolicLink()).toBe(true);
    // opencode's shim is a real file copied from templates: a path the generator names but does
    // not ship makes init throw, and every assertion above still passes on the half-written tree.
    expect(existsSync(path.join(repo, ".opencode/plugins/agentspine.js"))).toBe(true);
  });

  // TOML is spliced as text precisely so a user's comments and ordering survive.
  it("keeps existing TOML comments when splicing into codex config", () => {
    mkdirSync(path.join(repo, ".codex"), { recursive: true });
    writeFileSync(path.join(repo, ".codex/config.toml"), '# my notes\nmodel = "gpt-5"\n');
    runCli(["--dir", repo, "--tools", "codex", "--yes", "--force"]);
    const codex = readFileSync(path.join(repo, ".codex/config.toml"), "utf8");
    expect(codex).toContain("# my notes");
    expect(codex).toContain('model = "gpt-5"');
    expect(codex).toContain("[[hooks.PreToolUse]]");
  });
});

describe("doctor", () => {
  it("fails before anything is scaffolded and passes afterwards", () => {
    expect(runCli(["doctor", "--dir", repo]).status).toBe(1);
    runCli(["--dir", repo, "--yes"]);
    const after = runCli(["doctor", "--dir", repo]);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain("probe blocked as expected");
  });
});

describe("doctor probes every adapter it can", () => {
  it("confirms each wired tool actually blocks", () => {
    runCli(["--dir", repo, "--tools", "claude-code,codex,mistral-vibe,cursor", "--yes"]);
    const { status, stdout } = runCli([
      "doctor", "--dir", repo, "--tools", "claude-code,codex,mistral-vibe,cursor",
    ]);
    expect(status).toBe(0);
    for (const tool of ["claude-code", "codex", "mistral-vibe", "cursor"]) {
      expect(stdout).toContain(`${tool} blocking`);
    }
    expect(stdout).not.toContain("NOT blocked");
  });
});

describe("doctor outside a git repository", () => {
  // The Codex and Vibe wiring locates the repo root with git, so outside a repository the host
  // runs a path that does not exist and blocks nothing, however healthy the adapter is.
  it("fails the probe for wiring that needs a repo root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentspine-nogit-"));
    runCli(["--dir", dir, "--tools", "mistral-vibe,codex,claude-code", "--yes"]);
    const { status, stdout } = runCli(["doctor", "--dir", dir, "--tools", "mistral-vibe,codex,claude-code"]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/FAIL\s+mistral-vibe blocking.*not a git repository/);
    expect(stdout).toMatch(/FAIL\s+codex blocking.*not a git repository/);
    expect(stdout).toMatch(/ok\s+claude-code blocking/);
  });
});

describe("skill packs", () => {
  it("installs no pack by default, only the skill that adapts the setup to the project", () => {
    runCli(["--dir", repo, "--yes"]);
    expect(existsSync(path.join(repo, ".agents/skills/tdd"))).toBe(false);
    expect(existsSync(path.join(repo, ".agents/skills/adapt-to-project/SKILL.md"))).toBe(true);
  });

  // wayfinder invokes grilling and research, implement invokes tdd: a planning pack without
  // them would name skills that are not there.
  it("installs the packs that planning skills invoke", () => {
    const { stdout } = runCli(["--dir", repo, "--yes", "--packs", "planning"]);
    expect(existsSync(path.join(repo, ".agents/skills/wayfinder/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".agents/skills/grilling/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".agents/skills/tdd/SKILL.md"))).toBe(true);
    expect(stdout).toContain(".agents/skills/grilling");
  });

  it("names every shipped skill after its directory", () => {
    const root = path.resolve("templates/agents/skills");
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = readFileSync(path.join(root, entry.name, "SKILL.md"), "utf8");
      expect(skill, entry.name).toMatch(new RegExp(`^---\nname: ${entry.name}\n`));
    }
  });

  it("ships every template skill in exactly one pack", async () => {
    const { CORE_SKILLS, PACKS } = await import("../src/plan.utils.js");
    const shipped = [...CORE_SKILLS, ...Object.values(PACKS).flat()].sort();
    const onDisk = readdirSync(path.resolve("templates/agents/skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(shipped).toEqual(onDisk);
  });

  it("installs only the requested packs", () => {
    runCli(["--dir", repo, "--yes", "--packs", "engineering"]);
    expect(existsSync(path.join(repo, ".agents/skills/tdd/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".agents/skills/grilling"))).toBe(false);
  });

  it("ships skills that every tool can discover", () => {
    runCli(["--dir", repo, "--yes", "--packs", "thinking,engineering"]);
    const skill = readFileSync(path.join(repo, ".agents/skills/tdd/SKILL.md"), "utf8");
    // The Agent Skills spec all five tools implement: name + description frontmatter.
    expect(skill).toMatch(/^---\nname: tdd\ndescription: /);
  });

  it("rejects an unknown pack", () => {
    const { status, stderr } = runCli(["--dir", repo, "--yes", "--packs", "nonsense"]);
    expect(status).toBe(1);
    expect(stderr).toContain("Unknown pack");
  });
});

describe("ci-review pack", () => {
  it("emits the review workflow pinned to this version, with the review pack it runs", () => {
    const { stdout } = runCli(["--dir", repo, "--yes", "--packs", "ci-review", "--tools", "claude-code"]);
    const workflow = readFileSync(path.join(repo, ".github/workflows/claude-code-review.yml"), "utf8");
    const { version } = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    expect(workflow).toContain(`AGENTSPINE_VERSION: "${version}"`);
    expect(workflow).not.toContain("__AGENTSPINE_VERSION__");
    expect(existsSync(path.join(repo, ".agents/skills/pr-ci-review/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".agents/skills/review-changes/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".agents/agents/review-security.md"))).toBe(true);
    expect(stdout).toContain(".github/workflows/claude-code-review.yml");
  });

  it("emits no workflow, and says why, when Claude Code is not a target", () => {
    const { stdout } = runCli(["--dir", repo, "--yes", "--packs", "ci-review", "--tools", "codex"]);
    expect(existsSync(path.join(repo, ".github/workflows/claude-code-review.yml"))).toBe(false);
    expect(stdout).toMatch(/skip\s+\.github\/workflows\/claude-code-review\.yml \(.*claude-code-action/);
  });

  it("never overwrites a workflow the project has edited", () => {
    runCli(["--dir", repo, "--yes", "--packs", "ci-review", "--tools", "claude-code"]);
    const target = path.join(repo, ".github/workflows/claude-code-review.yml");
    writeFileSync(target, "edited\n");
    runCli(["--dir", repo, "--yes", "--force", "--packs", "ci-review", "--tools", "claude-code"]);
    expect(readFileSync(target, "utf8")).toBe("edited\n");
  });
});

describe("review pack and the agents layer", () => {
  it("installs the reviewers and links them where the host supports named agents", () => {
    runCli(["--dir", repo, "--yes", "--packs", "review", "--tools", "claude-code,opencode,cursor"]);

    expect(existsSync(path.join(repo, ".agents/agents/review-security.md"))).toBe(true);
    for (const dir of [".claude/agents", ".opencode/agent", ".cursor/agents"]) {
      expect(lstatSync(path.join(repo, dir)).isSymbolicLink()).toBe(true);
      expect(existsSync(path.join(repo, dir, "review-docs.md"))).toBe(true);
    }
  });

  // Decision 8: Claude's `tools` list and opencode's `tools` map are incompatible, and
  // agents are not documented to ignore unknown frontmatter the way skills are.
  it("ships agents with intersection-only frontmatter", () => {
    runCli(["--dir", repo, "--yes", "--packs", "review"]);
    const agent = readFileSync(path.join(repo, ".agents/agents/review-security.md"), "utf8");
    const frontmatter = agent.split("---")[1];
    expect(frontmatter).toContain("name:");
    expect(frontmatter).toContain("description:");
    expect(frontmatter).not.toContain("tools:");
    expect(frontmatter).not.toContain("model:");
  });

  it("emits no agents for hosts without project-scoped subagents", () => {
    const { stdout } = runCli(["--dir", repo, "--dry-run", "--packs", "review", "--tools", "codex,mistral-vibe"]);
    expect(stdout).toContain("degrades to inline briefs");
    expect(stdout).not.toContain(".codex/agents");
  });

  it("does not install the agents layer for packs that do not need it", () => {
    runCli(["--dir", repo, "--yes", "--packs", "thinking"]);
    expect(existsSync(path.join(repo, ".agents/agents"))).toBe(false);
  });
});

describe("--check", () => {
  it("reports drift and writes nothing when the tree was never scaffolded", () => {
    const { status, stdout } = runCli(["--dir", repo, "--check"]);
    expect(status).toBe(1);
    expect(stdout).toContain("drift");
    expect(existsSync(path.join(repo, ".agents"))).toBe(false);
  });

  it("passes once the tree matches what init emits", () => {
    runCli(["--dir", repo, "--yes", "--packs", "engineering"]);
    const { status, stdout } = runCli(["--dir", repo, "--check", "--packs", "engineering"]);
    expect(status).toBe(0);
    expect(stdout).toContain("matches what init would emit");
  });

  // Content, not inodes: a project that symlinks the shared tree to one source is not drifted.
  it("accepts a shared tree that is symlinked rather than copied", () => {
    runCli(["--dir", repo, "--yes", "--packs", "engineering"]);
    const skills = path.join(repo, ".agents/skills");
    const stash = path.join(repo, "shared-skills");
    renameSync(skills, stash);
    symlinkSync("../shared-skills", skills);
    expect(runCli(["--dir", repo, "--check", "--packs", "engineering"]).status).toBe(0);
  });

  it("runs on a dirty tree, since it writes nothing", () => {
    runCli(["--dir", repo, "--yes", "--packs", "engineering"]);
    writeFileSync(path.join(repo, "dirty.txt"), "x");
    expect(runCli(["--dir", repo, "--check", "--packs", "engineering"]).status).toBe(0);
  });
});
