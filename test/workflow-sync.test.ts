import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script, no types
import { renderFromDisk } from "../scripts/render-review-workflow.mjs";

/**
 * This repository runs the workflow the ci-review pack emits, with three documented differences.
 * The copy we run is the evidence the one we ship works, so the two drifting apart would leave
 * that evidence quietly meaningless.
 */
describe("the repo's review workflow", () => {
  it("is what the template renders to", () => {
    const committed = readFileSync(path.resolve(".github/workflows/claude-code-review.yml"), "utf8");
    expect(renderFromDisk()).toBe(committed);
  });

  it("keeps the differences that make it safe to dogfood", () => {
    const committed = readFileSync(path.resolve(".github/workflows/claude-code-review.yml"), "utf8");
    // Built from the base branch: the PR head is the review tooling here, and building it would
    // run untrusted code in a job holding the review token.
    expect(committed).toContain("git worktree add --detach");
    expect(committed).not.toContain("npm install --global");
    // Only the owner triggers a run, and only once the switch is on.
    expect(committed).toContain("github.event.pull_request.user.login == github.repository_owner");
    expect(committed).toContain("github.actor == github.repository_owner");
    expect(committed).toContain("github.event.comment.user.login == github.repository_owner");
    expect(committed).toContain("vars.CLAUDE_REVIEW_ENABLED == 'true'");
    // A re-run keeps the owner as `actor`, whoever started it.
    expect(committed).toContain("github.triggering_actor == github.repository_owner");
    // `.agents/` is a symlink into templates/, so the target is startup config too.
    expect(committed).toContain('RESTORE_PATHS: "AGENTS.md .agents templates"');
  });
});

describe("the emitted review workflow", () => {
  // A run carries the review token and the model reads whatever the diff says, so an outsider's
  // PR or comment must not start one.
  it("admits only the repository's owner, members and collaborators, on both triggers", () => {
    const template = readFileSync(path.resolve("templates/github/workflows/claude-code-review.yml"), "utf8");
    const trusted = `contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'),`;
    expect(template).toContain(`${trusted} github.event.pull_request.author_association)`);
    expect(template).toContain(`${trusted} github.event.comment.author_association)`);
    // A push by someone else to a trusted author's branch fires synchronize too.
    expect(template).toContain("github.actor == github.event.pull_request.user.login");
  });
});

/** The permissions block of one job, as written in the workflow. */
function jobPermissions(workflow: string, job: string): string {
  const body = workflow.split(`\n  ${job}:\n`)[1] ?? "";
  const block = /^    permissions:\n((?:      .*\n)+)/m.exec(body);
  return block?.[1] ?? "";
}

describe.each([
  ["the emitted template", "templates/github/workflows/claude-code-review.yml"],
  ["this repo's copy", ".github/workflows/claude-code-review.yml"],
])("%s keeps the model away from a write token", (_label, file) => {
  const workflow = readFileSync(path.resolve(file), "utf8");

  // The whole point of the split: a review talked into writing to the PR has no token that can.
  it("gives the job that runs the model no write permission", () => {
    const permissions = jobPermissions(workflow, "claude-review");
    expect(permissions).toContain("contents: read");
    expect(permissions).not.toMatch(/write/);
  });

  it("keeps the write permissions in the poster's own job", () => {
    const permissions = jobPermissions(workflow, "post-review");
    expect(permissions).toContain("pull-requests: write");
    expect(permissions).toContain("statuses: write");
  });

  it("posts on always(), so a dead review still leaves a verdict", () => {
    expect(workflow).toMatch(/post-review:\n\s+needs: claude-review\n\s+if: always\(\)/);
  });
});

describe.each([
  ["the emitted template", "templates/github/workflows/claude-code-review.yml"],
  ["this repo's copy", ".github/workflows/claude-code-review.yml"],
])("%s caches nothing from the checkout", (_label, file) => {
  const workflow = readFileSync(path.resolve(file), "utf8");

  // setup-node caches on its own when the checkout's package.json names npm, and the checkout is
  // the user's repository. The jobs install nothing from its lockfile, so the cache is only risk.
  it("turns off setup-node's automatic cache in every job", () => {
    const steps = workflow.split("uses: actions/setup-node@").slice(1);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.split(/\n\s+- /)[0]).toContain("package-manager-cache: false");
    }
  });
});

/** The managed settings the lock step writes, parsed. */
function managedSettings(workflow: string) {
  const heredoc = /managed-settings\.json >\/dev\/null <<'EOF'\n([\s\S]*?)\n {10}EOF\n/.exec(workflow)?.[1] ?? "";
  return JSON.parse(heredoc.replace(/^ {10}/gm, ""));
}

describe.each([
  ["the emitted template", "templates/github/workflows/claude-code-review.yml"],
  ["this repo's copy", ".github/workflows/claude-code-review.yml"],
])("%s holds the model to what a review needs", (_label, file) => {
  const workflow = readFileSync(path.resolve(file), "utf8");
  const settings = managedSettings(workflow);

  // Only managed rules count, so the skill's allowed-tools and the repo's settings cannot widen them.
  it("takes its permission rules from managed settings alone", () => {
    expect(settings.allowManagedPermissionRulesOnly).toBe(true);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
  });

  // `gh api` bundles short flags into a POST, `git grep -O` and `git difftool` run commands.
  it("allows no verb that can write or run a command", () => {
    for (const rule of settings.permissions.allow) {
      expect(rule).not.toMatch(/gh api|git grep|git diff\*|git fetch|git checkout/);
    }
  });

  it("runs Bash in a sandbox that fails the run rather than start without it", () => {
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(settings.sandbox.network.allowedDomains).toEqual(["api.github.com"]);
  });

  it("scrubs credentials from the shell the model drives", () => {
    const job = workflow.split("\n  claude-review:\n")[1]?.split("\n  post-review:\n")[0] ?? "";
    expect(job).toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1"');
  });

  // Both jobs check out the PR head, where a fork can commit any of these names as a symlink.
  it("keeps every hand-off file out of the checkout", () => {
    expect(workflow).not.toContain("${{ github.workspace }}");
    expect(workflow).not.toMatch(/^\s+path: review-/m);
    expect(workflow).not.toMatch(/> "?review-output\//);
  });
});
