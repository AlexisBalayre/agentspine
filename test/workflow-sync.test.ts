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
