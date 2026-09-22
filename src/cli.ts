#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_TOOLS, detectStacks, detectTools, gitState, hasJq, type Tool } from "./detect.utils.js";
import { apply, describe, wouldChange } from "./apply.utils.js";
import { HOOK_COMMANDS, PACKS, buildPlan, type Pack } from "./plan.utils.js";

const TEMPLATES = fileURLToPath(new URL("../templates", import.meta.url));

const USAGE = `agentspine — one shared agent setup for several coding agents

Usage
  npx agentspine [init]      Scaffold .agents/ and wire each detected tool
  npx agentspine doctor      Probe the wiring and verify hooks actually block
  npx agentspine review <step>
                             CI review tooling, run by the emitted workflow:
                             preflight, schema, post, metrics

Options
  --tools <list>     Comma-separated: ${SUPPORTED_TOOLS.join(", ")} (default: detected)
  --packs <list>     Skill packs to install: ${Object.keys(PACKS).join(", ")} (default: none)
  --dir <path>       Target repository (default: cwd)
  --no-symlink       Copy shared content instead of symlinking it
  --skip-hooks       Scaffold content but wire no hooks
  --dry-run          Print the plan, write nothing
  --check            Exit non-zero if the tree differs from what init would emit
  --yes              Apply without confirming
  --json             Machine-readable output
  --force            Proceed even though the git tree is dirty
  -h, --help         Show this message
  -v, --version      Show version
`;

type Options = {
  command: "init" | "doctor";
  dir: string;
  tools?: Tool[];
  packs: Pack[];
  symlink: boolean;
  hooks: boolean;
  dryRun: boolean;
  check: boolean;
  yes: boolean;
  json: boolean;
  force: boolean;
  explicit: boolean;
};

function parse(argv: string[]): Options | { error: string } {
  const options: Options = {
    command: "init",
    dir: process.cwd(),
    packs: [],
    symlink: true,
    hooks: true,
    dryRun: false,
    check: false,
    yes: false,
    json: false,
    force: false,
    explicit: argv.length > 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "init":
      case "doctor": options.command = arg; break;
      case "--no-symlink": options.symlink = false; break;
      case "--skip-hooks": options.hooks = false; break;
      case "--dry-run": options.dryRun = true; break;
      case "--check": options.check = true; break;
      case "--yes": case "-y": options.yes = true; break;
      case "--json": options.json = true; break;
      case "--force": options.force = true; break;
      case "--dir": options.dir = path.resolve(argv[++i] ?? "."); break;
      case "--packs": {
        const value = argv[++i] ?? "";
        const requested = value.split(",").map((p) => p.trim()).filter(Boolean);
        const unknown = requested.filter((p) => !(p in PACKS));
        if (unknown.length > 0) return { error: `Unknown pack(s): ${unknown.join(", ")}` };
        options.packs = requested as Pack[];
        break;
      }
      case "--tools": {
        const value = argv[++i] ?? "";
        const requested = value.split(",").map((t) => t.trim()).filter(Boolean);
        const unknown = requested.filter((t) => !SUPPORTED_TOOLS.includes(t as Tool));
        if (unknown.length > 0) return { error: `Unsupported tool(s): ${unknown.join(", ")}` };
        options.tools = requested as Tool[];
        break;
      }
      default: return { error: `Unknown option: ${arg}` };
    }
  }

  return options;
}

async function init(options: Options): Promise<number> {
  const git = gitState(options.dir);
  const root = git.root ?? options.dir;

  if (git.isRepo && !git.isClean && !options.force && !options.dryRun && !options.check) {
    fail(options, "The git tree is dirty. Commit or stash first, or pass --force. Git is your backup.");
    return 1;
  }

  const tools = options.tools ?? detectTools(root);
  if (tools.length === 0) {
    fail(options, `No supported tool detected in ${root}. Pass --tools ${SUPPORTED_TOOLS.join(",")}.`);
    return 1;
  }

  if (options.hooks && !hasJq()) {
    fail(options, "jq is not installed, and hook policies need it. Install jq (brew install jq / apt-get install jq), or re-run with --skip-hooks.");
    return 1;
  }

  const stacks = detectStacks(root);
  const interactive = process.stdin.isTTY === true && !options.explicit;
  const plan = buildPlan({
    root, templates: TEMPLATES, tools, stacks,
    symlink: options.symlink, hooks: options.hooks,
    confirmed: interactive,
    packs: options.packs,
    version: packageVersion(),
  });

  if (options.check) {
    // Drift gate. Content-compares what init would emit against what is committed, so a
    // project that symlinks the shared tree into one source still passes.
    const drifted = plan.filter((action) => wouldChange(action, root));
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ root, tools, drifted: drifted.map((a) => a.target) }, null, 2)}\n`);
    } else if (drifted.length === 0) {
      process.stdout.write(`agentspine --check: ${root} matches what init would emit.\n`);
    } else {
      process.stdout.write(`agentspine --check: ${drifted.length} path(s) differ from what init would emit\n\n`);
      for (const action of drifted) process.stdout.write(`  drift  ${action.target}\n`);
      process.stdout.write("\nRun agentspine to bring them back in line.\n");
    }
    return drifted.length === 0 ? 0 : 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ root, tools, stacks, plan, applied: false }, null, 2)}\n`);
    if (options.dryRun) return 0;
  } else {
    process.stdout.write(`agentspine -> ${root}\ntools: ${tools.join(", ")}\n\n`);
    for (const action of plan) process.stdout.write(`  ${describe(action)}\n`);
    process.stdout.write("\n");
  }

  if (options.dryRun) return 0;

  if (!options.yes) {
    if (!interactive) {
      // Never guess on someone's repository without a human or an explicit --yes.
      fail(options, "Refusing to write without confirmation. Re-run with --yes, or --dry-run to inspect the plan.");
      return 2;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Apply this plan? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("Nothing written.\n");
      return 0;
    }
  }

  const applied = apply(plan, root);
  if (options.json) process.stdout.write(`${JSON.stringify({ root, tools, applied }, null, 2)}\n`);
  else {
    for (const entry of applied) process.stdout.write(`  ${entry.outcome.padEnd(14)}${entry.target}\n`);
    process.stdout.write(`\nDone. Verify with: npx agentspine doctor\n`);
  }
  return 0;
}

function packageVersion(): string {
  const pkg = fileURLToPath(new URL("../package.json", import.meta.url));
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
}

type Check = { name: string; ok: boolean; detail: string };

/** A payload shaped like the host's own, carrying a command git-safety must refuse. */
const PROBE_COMMAND = ["git", "push", "--force", "origin", "main"].join(" ");

type Probe = { payload: (root: string) => unknown; blocked: (status: number | null, stdout: string) => boolean };

const PROBES: Partial<Record<Tool, Probe>> = {
  "claude-code": {
    payload: (root) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: PROBE_COMMAND } }),
    blocked: (status) => status === 2,
  },
  codex: {
    payload: (root) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: PROBE_COMMAND } }),
    blocked: (status) => status === 2,
  },
  cursor: {
    payload: (root) => ({ hook_event_name: "beforeShellExecution", command: PROBE_COMMAND, cwd: root, workspace_roots: [root] }),
    blocked: (status) => status === 2,
  },
  // Vibe denies by exiting 0 and printing a decision, so a zero exit proves nothing here.
  "mistral-vibe": {
    payload: (root) => ({ hook_event_name: "pre_tool", tool_name: "shell", cwd: root, tool_input: { command: PROBE_COMMAND } }),
    blocked: (status, stdout) => {
      if (status !== 0) return false;
      try {
        return (JSON.parse(stdout) as { decision?: string }).decision === "deny";
      } catch {
        return false;
      }
    },
  },
};

/** Where each tool looks for skills, when that is not the shared tree itself. */
const SKILL_PATHS: Partial<Record<Tool, string>> = {
  "claude-code": ".claude/skills",
};

const WIRING: Record<Tool, { file: string; needle: string }> = {
  "claude-code": { file: ".claude/settings.json", needle: ".agents/hooks/adapters" },
  opencode: { file: ".opencode/plugins/agentspine.js", needle: "" },
  codex: { file: ".codex/config.toml", needle: ".agents/hooks/adapters" },
  "mistral-vibe": { file: ".vibe/hooks.toml", needle: ".agents/hooks/adapters" },
  cursor: { file: ".cursor/hooks.json", needle: ".agents/hooks/adapters" },
};

function doctor(options: Options): number {
  const git = gitState(options.dir);
  const root = git.root ?? options.dir;
  // Only tools the project actually uses are checked: reporting a missing plugin for a
  // tool nobody installed trains people to ignore doctor's output.
  const tools = options.tools ?? detectTools(root);
  const checks: Check[] = [];

  const jq = hasJq();
  checks.push({ name: "jq", ok: jq, detail: jq ? "installed" : "missing — hook policies cannot run" });

  const hooksDir = existsSync(path.join(root, ".agents/hooks"));
  checks.push({ name: ".agents/hooks", ok: hooksDir, detail: hooksDir ? "present" : "not scaffolded" });

  if (tools.length === 0) checks.push({ name: "tools", ok: false, detail: "no supported tool detected here" });

  for (const tool of tools) {
    const wiring = WIRING[tool];
    const file = path.join(root, wiring.file);
    const wired = existsSync(file) && (wiring.needle === "" || readFileSync(file, "utf8").includes(wiring.needle));
    checks.push({ name: `${tool} wiring`, ok: wired, detail: wired ? `wired in ${wiring.file}` : `not wired in ${wiring.file}` });

    // A symlink that materialised as a text file, or a copy that never arrived, leaves a path
    // that leads nowhere: the tool then loads no skills at all and says nothing about it.
    const skills = SKILL_PATHS[tool];
    if (skills) {
      const dir = path.join(root, skills);
      const reachable = existsSync(dir) && readdirSync(dir).length > 0;
      checks.push({
        name: `${tool} skills`,
        ok: reachable,
        detail: reachable
          ? `${readdirSync(dir).length} entr(ies) under ${skills}`
          : `${skills} resolves to nothing — the tool will load no skills`,
      });
    }

    const probe = PROBES[tool];
    if (!probe) {
      checks.push({ name: `${tool} blocking`, ok: true, detail: "not probed: needs a live session" });
      continue;
    }
    if (!hooksDir || !jq) continue;

    // The only check that matters: a hook that fails to block exits 0 and looks healthy.
    // Run the command as wired, not the adapter by path: the wiring is where it breaks, e.g. a
    // repo-root lookup that resolves to nothing outside a git repository.
    const command = HOOK_COMMANDS[tool as keyof typeof HOOK_COMMANDS]("git-safety");
    const result = spawnSync("sh", ["-c", command], {
      cwd: root,
      input: JSON.stringify(probe.payload(root)),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    const blocked = probe.blocked(result.status, result.stdout ?? "");
    const why = git.isRepo || !command.includes("git rev-parse") ? "" : " (not a git repository, and the wired command needs one)";
    checks.push({
      name: `${tool} blocking`,
      ok: blocked,
      detail: blocked ? "probe blocked as expected" : `probe was NOT blocked — this hook is not protecting you${why}`,
    });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ root, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`agentspine doctor -> ${root}\n\n`);
    for (const check of checks) {
      process.stdout.write(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(24)}${check.detail}\n`);
    }
    process.stdout.write("\n");
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

function fail(options: Options, message: string) {
  if (options.json) process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  else process.stderr.write(`agentspine: ${message}\n`);
}

const REVIEW_STEPS = ["preflight", "schema", "post", "metrics"] as const;

/** The emitted CI workflow's deterministic steps. Each reads its inputs from the environment. */
async function review(step: string | undefined): Promise<number> {
  switch (step) {
    case "preflight": await (await import("./review/preflight.script.js")).main(); return 0;
    case "schema": {
      const { REVIEW_SUMMARY_SCHEMA } = await import("./review/review-summary.schemas.js");
      process.stdout.write(JSON.stringify(REVIEW_SUMMARY_SCHEMA));
      return 0;
    }
    case "post": (await import("./review/post.script.js")).main(); return 0;
    case "metrics": (await import("./review/metrics.script.js")).main(); return 0;
    default:
      process.stderr.write(`agentspine: review needs one of ${REVIEW_STEPS.join(", ")}\n`);
      return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  // Lazily imported: init and doctor never load the review tooling.
  if (argv[0] === "review") return review(argv[1]);

  const parsed = parse(argv);
  if ("error" in parsed) {
    process.stderr.write(`agentspine: ${parsed.error}\n\n${USAGE}`);
    return 1;
  }

  return parsed.command === "doctor" ? doctor(parsed) : init(parsed);
}

process.exit(await main(process.argv.slice(2)));
