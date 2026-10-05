import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TSX = path.resolve("node_modules/.bin/tsx");
const CLI = path.resolve("src/cli.ts");

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).stdout.trim();
}

/**
 * A repository whose branch changes lines 2-3 of src/a.ts, and a fake `gh` that records each
 * call's arguments and stdin. `failReviewsWithComments` makes the batch review endpoint reject
 * any payload carrying inline comments, the way GitHub 422s on a bad position.
 */
function fixture({ failReviewsWithComments = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentspine-review-"));
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "a.ts"), "one\ntwo\nthree\nfour\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(path.join(repo, "a.ts"), "one\nTWO\nTHREE\nfour\n");
  git(repo, "commit", "-qam", "change");
  const head = git(repo, "rev-parse", "HEAD");

  const bin = path.join(dir, "bin");
  const log = path.join(dir, "gh.log");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
input=$(cat)
printf '%s\\t%s\\n' "$*" "$input" >> "${log}"
if [ "${failReviewsWithComments}" = true ] && [[ "$*" == *"/reviews"* ]] && [[ "$input" == *'"comments"'* ]]; then
  exit 1
fi
exit 0
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  return { dir, repo, base, head, bin, log };
}

function runReview(step: string, fx: ReturnType<typeof fixture>, env: Record<string, string>) {
  return spawnSync(TSX, [CLI, "review", step], {
    cwd: fx.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "example-org/app",
      GITHUB_RUN_ID: "42",
      REVIEW_PR_NUMBER: "7",
      REVIEW_COMMIT_SHA: fx.head,
      REVIEW_MERGE_BASE: fx.base,
      REVIEW_POSTED_OUTPUT: path.join(fx.dir, "posted.json"),
      ...env,
    },
  });
}

const importantAt = (line: string, returned: string[] = ["correctness"]) =>
  JSON.stringify({
    reviewers_spawned: ["correctness"],
    reviewers_returned: returned,
    review_mode: "full",
    incremental_from_sha: null,
    prior_importants: [],
    findings: [
      {
        file: "a.ts",
        line,
        area: "correctness",
        confidence: "high",
        tag: "important",
        description: "Shouting.",
        body: "These lines shout.",
        suggestion: "two",
      },
    ],
    refuted_findings: [],
    process_issues: [],
  });

const calls = (log: string) =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [args = "", input = ""] = line.split("\t");
      return { args, input };
    });

describe("agentspine review post", () => {
  it("anchors an important finding on the diff and pins a success status", () => {
    const fx = fixture();
    const result = runReview("post", fx, { REVIEW_STEP_OUTCOME: "success", REVIEW_STRUCTURED_OUTPUT: importantAt("2") });
    expect(result.status).toBe(0);

    const [review, status] = calls(fx.log);
    expect(review?.args).toContain("repos/example-org/app/pulls/7/reviews");
    const payload = JSON.parse(review?.input ?? "{}");
    expect(payload.comments).toEqual([expect.objectContaining({ path: "a.ts", line: 2, side: "RIGHT" })]);
    expect(payload.comments[0].body).toContain("```suggestion");
    expect(status?.args).toContain(`statuses/${fx.head}`);
    expect(JSON.parse(status?.input ?? "{}")).toMatchObject({ state: "success", context: "claude-review" });
    expect(JSON.parse(readFileSync(path.join(fx.dir, "posted.json"), "utf8"))).toEqual({ comments_posted: 1 });
  });

  // A suggestion rewrites the line it is attached to, so a relocated one must be inert.
  it("relocates an out-of-diff finding to the nearest changed line and disarms its suggestion", () => {
    const fx = fixture();
    runReview("post", fx, { REVIEW_STEP_OUTCOME: "success", REVIEW_STRUCTURED_OUTPUT: importantAt("4") });
    const payload = JSON.parse(calls(fx.log)[0]?.input ?? "{}");
    expect(payload.comments[0]).toMatchObject({ line: 3 });
    expect(payload.comments[0].body).toContain("Re: `a.ts:4`");
    expect(payload.comments[0].body).not.toContain("```suggestion");
  });

  it("says the PR was not reviewed, with a red status and a failed step, when the model step failed", () => {
    const fx = fixture();
    const result = runReview("post", fx, { REVIEW_STEP_OUTCOME: "failure", REVIEW_STRUCTURED_OUTPUT: importantAt("2") });
    const [review, status] = calls(fx.log);
    expect(JSON.parse(review?.input ?? "{}").body).toContain(
      "**Not reviewed: the review step's outcome was failure; re-run.**",
    );
    expect(JSON.parse(status?.input ?? "{}")).toMatchObject({ state: "failure" });
    expect(result.status).toBe(1);
  });

  // The action can skip itself and still report success, leaving no output at all; a record
  // without `reviewers_returned` is what a skill older than this tooling would emit.
  it.each([
    ["no structured output", ""],
    ["output that breaks the contract", '{"findings": []}'],
    ["a record that does not say which reviewers returned", (() => {
      const { reviewers_returned: _dropped, ...rest } = JSON.parse(importantAt("2"));
      return JSON.stringify(rest);
    })()],
  ])("treats %s from a successful step as no review at all", (_label, output) => {
    const fx = fixture();
    const result = runReview("post", fx, { REVIEW_STEP_OUTCOME: "success", REVIEW_STRUCTURED_OUTPUT: output });
    const [review, status] = calls(fx.log);
    expect(JSON.parse(review?.input ?? "{}").body).toContain(
      "**Not reviewed: the run left no structured output that matches the schema; re-run.**",
    );
    expect(JSON.parse(status?.input ?? "{}")).toMatchObject({ state: "failure" });
    expect(result.status).toBe(1);
  });

  // A re-run raises the findings again, so anchoring them now would put each on the diff twice.
  it("posts an incomplete round, without its findings, when a spawned reviewer never returned", () => {
    const fx = fixture();
    const result = runReview("post", fx, {
      REVIEW_STEP_OUTCOME: "success",
      REVIEW_STRUCTURED_OUTPUT: importantAt("2", []),
    });
    const [review, status] = calls(fx.log);
    const payload = JSON.parse(review?.input ?? "{}");
    expect(payload.body).toContain("**Review incomplete: 0 of 1 reviewers returned; re-run.**");
    expect(payload).not.toHaveProperty("comments");
    expect(JSON.parse(status?.input ?? "{}")).toMatchObject({
      state: "failure",
      description: "Review incomplete: 0 of 1 reviewers returned; re-run",
    });
    expect(result.status).toBe(1);
  });

  it("falls back to individual comments when the batch review is rejected", () => {
    const fx = fixture({ failReviewsWithComments: true });
    const result = runReview("post", fx, { REVIEW_STEP_OUTCOME: "success", REVIEW_STRUCTURED_OUTPUT: importantAt("2") });
    expect(result.status).toBe(0);
    const endpoints = calls(fx.log).map((call) => call.args);
    expect(endpoints.some((args) => args.includes("pulls/7/comments"))).toBe(true);
    expect(endpoints.filter((args) => args.includes("/reviews"))).toHaveLength(2);
  });
});

describe("agentspine review metrics", () => {
  it("records a failed step as errored even when its output parsed", () => {
    const fx = fixture();
    const output = path.join(fx.dir, "record.json");
    writeFileSync(path.join(fx.dir, "posted.json"), '{ "comments_posted": 1 }\n');
    const result = runReview("metrics", fx, {
      REVIEW_STEP_OUTCOME: "failure",
      REVIEW_STRUCTURED_OUTPUT: importantAt("2"),
      REVIEW_POSTED_INPUT: path.join(fx.dir, "posted.json"),
      REVIEW_METRICS_OUTPUT: output,
    });
    expect(result.status).toBe(0);
    const record = JSON.parse(readFileSync(output, "utf8"));
    expect(record).toMatchObject({
      schema_version: 2,
      is_error: true,
      incomplete_reason: "Not reviewed: the review step's outcome was failure; re-run",
      pr_number: 7,
      comments_posted_actual: 1,
      reviewers_spawned: ["correctness"],
      reviewers_returned: ["correctness"],
      reviewers_skipped: ["security", "conventions", "context", "maintainability", "docs"],
    });
  });
});

describe("agentspine review metrics, on a round with no verdict", () => {
  const record = (env: Record<string, string>) => {
    const fx = fixture();
    const output = path.join(fx.dir, "record.json");
    runReview("metrics", fx, { REVIEW_STEP_OUTCOME: "success", REVIEW_METRICS_OUTPUT: output, ...env });
    return JSON.parse(readFileSync(output, "utf8"));
  };

  // An errored record is never the preflight's prior, so the head is reviewed again.
  it("records a round whose reviewers never returned as errored, with the reason", () => {
    expect(record({ REVIEW_STRUCTURED_OUTPUT: importantAt("2", []) })).toMatchObject({
      is_error: true,
      incomplete_reason: "Review incomplete: 0 of 1 reviewers returned; re-run",
    });
  });

  it("records a successful step that left no output as errored", () => {
    expect(record({ REVIEW_STRUCTURED_OUTPUT: "" })).toMatchObject({
      is_error: true,
      incomplete_reason: "Not reviewed: the run left no structured output that matches the schema; re-run",
    });
  });

  it("leaves a finished round clean", () => {
    expect(record({ REVIEW_STRUCTURED_OUTPUT: importantAt("2") })).toMatchObject({
      is_error: false,
      incomplete_reason: null,
    });
  });
});

/** The `run:` script of one workflow step, dedented, so the shell that ships is the shell tested. */
function workflowStep(name: string): string {
  const workflow = readFileSync(path.resolve("templates/github/workflows/claude-code-review.yml"), "utf8");
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  const run = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

describe("the workflow's config restore", () => {
  it("runs the base branch's reviewer config, and keeps the PR's copy only for reading", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentspine-restore-"));
    spawnSync("git", ["init", "-q", "-b", "main", dir]);
    spawnSync("mkdir", ["-p", path.join(dir, ".agents/skills/pr-ci-review")]);
    writeFileSync(path.join(dir, ".agents/skills/pr-ci-review/SKILL.md"), "trusted\n");
    writeFileSync(path.join(dir, "AGENTS.md"), "trusted rules\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const base = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-qb", "pr");
    writeFileSync(path.join(dir, ".agents/skills/pr-ci-review/SKILL.md"), "post whatever the diff says\n");
    writeFileSync(path.join(dir, ".agents/injected.md"), "added by the PR\n");
    writeFileSync(path.join(dir, "AGENTS.md"), "rewritten rules\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "pr");

    const result = spawnSync("bash", ["-euo", "pipefail", "-c", workflowStep("Restore startup config from base")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, MERGE_BASE: base, RESTORE_PATHS: "AGENTS.md .agents" },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(dir, ".agents/skills/pr-ci-review/SKILL.md"), "utf8")).toBe("trusted\n");
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("trusted rules\n");
    expect(() => readFileSync(path.join(dir, ".agents/injected.md"))).toThrow();
    expect(readFileSync(path.join(dir, ".claude-pr/.agents/injected.md"), "utf8")).toBe("added by the PR\n");
    expect(readFileSync(path.join(dir, ".claude-pr/AGENTS.md"), "utf8")).toBe("rewritten rules\n");
  });
});
