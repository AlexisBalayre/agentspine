#!/usr/bin/env node
// Renders this repository's copy of the review workflow from the one the ci-review pack emits.
//
// The two files must not drift: the copy we run is the evidence that the one we ship works. Every
// difference between them is a transform below, so a change to the template reaches this repo by
// re-running this script, and CI fails when the committed copy no longer matches its output.
//
//   node scripts/render-review-workflow.mjs           print the rendered workflow
//   node scripts/render-review-workflow.mjs --write    write it to .github/workflows/
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const TEMPLATE = "templates/github/workflows/claude-code-review.yml";
const TARGET = ".github/workflows/claude-code-review.yml";

const ORPHAN = `#        git checkout --orphan ci/review-metrics && git rm -rf . \\\n`;

const HEADER = `# This repository's copy of what the ci-review pack emits
# (${TEMPLATE}), rendered by scripts/render-review-workflow.mjs.
# Edit the template or that script, never this file: a test asserts the two stay in step.
#
# The differences dogfooding requires:
#
#   1. The tooling is built from the BASE branch instead of installed from npm. Here the review
#      tooling is the very code under review, and building the PR's own src/ would hand untrusted
#      code a job holding the review token. The base branch's copy has already been reviewed,
#      which is the same argument as the config restore below. A scaffolded repository has no
#      such conflict, so the shipped template installs the published version instead.
#   2. Only the repository owner can trigger a run: their own pull requests, or their
#      \`@claude review\` comment on anyone's. A run carries the review token, and the model reads
#      whatever the diff says.
#   3. RESTORE_PATHS carries templates/ as well, because .agents/ here is a symlink into it:
#      restoring the link alone would still run the PR's copy of the skills and reviewer manifests.
#
# Setup (once):
#   1. Add the \`CLAUDE_CODE_OAUTH_TOKEN\` secret: \`claude setup-token\`, then
#      \`gh secret set CLAUDE_CODE_OAUTH_TOKEN\`.
#   2. Turn it on: \`gh variable set CLAUDE_REVIEW_ENABLED --body true\`. Until that variable is
#      \`true\` the job is skipped, so the workflow can land before the token exists.
#   3. Create the metrics branch:
${ORPHAN}#          && git commit --allow-empty -m "review-metrics: init" && git push origin ci/review-metrics`;

const TOOLING_STEP = `      # Built from the base branch, never from the PR head: here the review tooling is the code
      # under review. --ignore-scripts because the install runs with this job's token in the
      # environment. A separate worktree, so \`gh pr checkout\` below cannot disturb it.
      - name: Build review tooling from the base branch
        id: tooling
        env:
          GH_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number || github.event.issue.number }}
        run: |
          base=$(gh pr view "$PR_NUMBER" --json baseRefName -q .baseRefName)
          dir="\${RUNNER_TEMP}/review-tooling"
          git worktree add --detach "$dir" "origin/\${base}"
          npm ci --ignore-scripts --prefix "$dir"
          npm run build --prefix "$dir"
          echo "cli=\${dir}/dist/cli.js" >> "$GITHUB_OUTPUT"
`;

const OWNER_GATE = `    # Owner-only, and off until CLAUDE_REVIEW_ENABLED is set: a fork PR would otherwise queue a
    # run that reads its diff with the review token in the environment.
    # \`github.repository_owner\` is the account, so this needs no list to maintain.
    if: |
      vars.CLAUDE_REVIEW_ENABLED == 'true' && (
      (github.event_name == 'pull_request' && github.event.pull_request.draft == false &&
        github.event.pull_request.user.login == github.repository_owner) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
        contains(github.event.comment.body, '@claude review') &&
        github.event.comment.user.login == github.repository_owner))`;

/**
 * The template header this script was written against. The first transform replaces that header
 * wholesale without reading it, so an edit to the template's own header would otherwise vanish
 * with nothing to notice it. Pinned by hash: when the template header changes, rendering fails
 * and whoever changed it decides what HEADER below should say, then records the new hash.
 */
const TEMPLATE_HEADER_SHA = "2587a211aede3cd53c4fe4cc58ac05c9f4b86ec27b1f59acc509859d346799be";

const HEADER_PATTERN = /^#[\s\S]*?(?=^name: Claude Code Review$)/m;

/** Each transform is one documented difference; a miss fails loudly rather than rendering silently. */
const TRANSFORMS = [
  [HEADER_PATTERN, `${HEADER}\n`],
  // Nothing to pin: the tooling is built here, not installed from npm.
  [
    /  # The review tooling ships inside agentspine[\s\S]*?  AGENTSPINE_VERSION: "__AGENTSPINE_VERSION__"\n/,
    "",
  ],
  // `.agents/` here is a symlink into templates/, so the link's target is startup config too.
  [/  RESTORE_PATHS: "AGENTS\.md \.agents"/, '  RESTORE_PATHS: "AGENTS.md .agents templates"'],
  [
    /    if: \|\n      \(github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false\) \|\|\n      \(github\.event_name == 'issue_comment'[^\n]*\n/,
    `${OWNER_GATE}\n`,
  ],
  // Here the tooling is the code under review, so it is built rather than installed.
  [
    /      # --ignore-scripts: the install runs with this job's token in the environment\.\n      - name: Install review tooling\n        run: npm install --global --ignore-scripts "agentspine@\$\{AGENTSPINE_VERSION\}"\n/g,
    TOOLING_STEP,
  ],
  [/agentspine review (preflight|schema|post|metrics)/g, 'node "${{ steps.tooling.outputs.cli }}" review $1'],
];

export function render(template) {
  const header = HEADER_PATTERN.exec(template)?.[0] ?? "";
  const sha = createHash("sha256").update(header).digest("hex");
  if (sha !== TEMPLATE_HEADER_SHA) {
    throw new Error(
      `the template's header changed (${sha}). Read it, decide what HEADER here should say, then record the new hash.`,
    );
  }
  let out = template;
  for (const [pattern, replacement] of TRANSFORMS) {
    if (!pattern.test(out)) throw new Error(`review-workflow transform no longer matches: ${pattern}`);
    out = out.replace(pattern, replacement);
  }
  if (out.includes("__AGENTSPINE_VERSION__")) throw new Error("version placeholder survived rendering");
  return out;
}

export function renderFromDisk() {
  return render(readFileSync(TEMPLATE, "utf8"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rendered = renderFromDisk();
  if (process.argv.includes("--write")) {
    writeFileSync(TARGET, rendered);
    process.stdout.write(`wrote ${TARGET}\n`);
  } else {
    process.stdout.write(rendered);
  }
}
