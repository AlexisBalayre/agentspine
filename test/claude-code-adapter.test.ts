import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ADAPTER = path.resolve("templates/agents/hooks/adapters/claude-code.sh");
const FIXTURES = path.resolve("test/fixtures/claude-code");

/** Runs the adapter exactly as Claude Code does: payload on stdin, policy name as argv. */
function runAdapter(fixture: string, policy: string) {
  const payload = readFileSync(path.join(FIXTURES, fixture), "utf8");
  const projectDir = mkdtempSync(path.join(tmpdir(), "agentspine-"));

  const result = spawnSync("bash", [ADAPTER, policy], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });

  return { status: result.status, stderr: result.stderr };
}

describe("claude-code adapter -> git-safety", () => {
  it("blocks a force push with exit 2 and a reason on stderr", () => {
    const { status, stderr } = runAdapter("pre-tool-bash.force-push.json", "git-safety");
    expect(status).toBe(2);
    expect(stderr).toContain("BLOCKED by agentspine git-safety");
  });

  it("allows an ordinary command", () => {
    expect(runAdapter("pre-tool-bash.benign.json", "git-safety").status).toBe(0);
  });

  // A hand-rolled shell JSON extractor mis-reads this and lets the force push through;
  // the embedded quotes, brace and nested "command" key exist to defeat exactly that.
  it("still blocks when the command embeds quotes, braces and a decoy key", () => {
    const { status } = runAdapter("pre-tool-bash.quoted-command.json", "git-safety");
    expect(status).toBe(2);
  });

  it("ignores tools other than Bash", () => {
    expect(runAdapter("pre-tool-read.json", "git-safety").status).toBe(0);
  });
});

describe("claude-code adapter -> quality-gate", () => {
  it("is a no-op at turn-end when the project has no quality.toml", () => {
    expect(runAdapter("turn-end.json", "quality-gate").status).toBe(0);
  });
});

describe("adapter safety", () => {
  it("never blocks because of its own misconfiguration", () => {
    const { status } = runAdapter("pre-tool-bash.force-push.json", "no-such-policy");
    expect(status).toBe(0);
  });
});

/**
 * A worktree is a second checkout of the same repository on its own branch. The hook is handed the
 * repository root as the project dir and the worktree as the session's cwd, so reading the root's
 * branch blocks every commit made from a worktree whenever the root happens to sit on trunk. That
 * is not hypothetical: it blocked the commit that introduced this test.
 */
describe("git-safety across worktrees", () => {
  function repoWithWorktree() {
    const root = mkdtempSync(path.join(tmpdir(), "agentspine-wt-safety-"));
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    git(root, "init", "-q", "-b", "main");
    writeFileSync(path.join(root, "a.txt"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const tree = path.join(root, ".worktrees", "feature");
    git(root, "worktree", "add", "-q", tree, "-b", "feat/thing");
    return { root, tree };
  }

  function runFromCwd(projectDir: string, cwd: string, command = ["git", "commit", "-m", "work"].join(" ")) {
    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd,
      tool_input: { command },
    });
    return spawnSync("bash", [ADAPTER, "git-safety"], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
  }

  it("allows a commit from a worktree while the root sits on trunk", () => {
    const { root, tree } = repoWithWorktree();
    expect(runFromCwd(root, tree).status).toBe(0);
  });

  it("still blocks a commit made in the root while it is on trunk", () => {
    const { root } = repoWithWorktree();
    const result = runFromCwd(root, root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Branch first");
  });
});

/**
 * Cutting a release means tagging trunk and pushing the tag from it. That publishes a ref pointing
 * at trunk; it does not move trunk. Refusing it sent the v0.1.0 tag on a detour through a worktree.
 */
describe("git-safety and release tags", () => {
  function taggedRepo() {
    const root = mkdtempSync(path.join(tmpdir(), "agentspine-tag-"));
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(root, "a.txt"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    git("tag", "-a", "v9.9.9", "-m", "release");
    return root;
  }

  const run = (root: string, command: string) =>
    spawnSync("bash", [ADAPTER, "git-safety"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        cwd: root,
        tool_input: { command },
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });

  it.each([
    ["an existing tag by name", "git push origin v9.9.9"],
    ["every tag", "git push origin --tags"],
    ["a fully qualified tag ref", "git push origin refs/tags/v9.9.9"],
  ])("allows pushing %s from trunk", (_label, command) => {
    expect(run(taggedRepo(), command).status).toBe(0);
  });

  it.each([
    ["the branch itself", "git push origin main"],
    ["a name that is not a tag", "git push origin v0.0.1"],
    ["a plain push", "git push"],
  ])("still blocks pushing %s from trunk", (_label, command) => {
    expect(run(taggedRepo(), command).status).toBe(2);
  });
});

/**
 * The policy reads the command as text, and text cannot tell running a command from naming one.
 * Every rule used to fire on a commit message, an echo or a heredoc that quoted the very command
 * it forbids, which is routine in a repository whose subject is git hooks: it blocked the commit
 * that documented the release procedure. Splitting the line into the commands a shell would run,
 * honouring quotes, separates the two. It also closes a gap in the other direction, because
 * naming the trunk after a global option was never caught at all.
 */
describe("git-safety tells running a command from naming one", () => {
  // Carries a trailing token, because the trunk rule needs whitespace or end-of-string after the
  // trunk name to engage at all. This is the message the policy refused.
  const PHRASE = ["git", "push", "origin", "main", "--follow-tags"].join(" ");

  function repoOn(branch: "main" | "feat/x") {
    const root = mkdtempSync(path.join(tmpdir(), "agentspine-naming-"));
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(root, "a.txt"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    git("tag", "-a", "v1.2.3", "-m", "release");
    if (branch !== "main") git("checkout", "-q", "-b", branch);
    return root;
  }

  const run = (root: string, command: string) =>
    spawnSync("bash", [ADAPTER, "git-safety"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });

  it.each([
    ["an echo", `echo "${PHRASE}"`],
    ["a grep pattern", `grep -rn "${PHRASE}" docs/`],
    ["a heredoc", `cat > x.md <<EOF\nto release, run ${PHRASE}\nEOF`],
    ["a sed replacement", `sed -i '' 's|x|${PHRASE}|' CHANGELOG.md`],
    ["a commit message", `git commit -m "blocked by the rule: ${PHRASE}"`],
    ["a multi-line commit message", `git commit -m "first line\n${PHRASE}"`],
  ])("allows %s that only names a forbidden push", (_label, command) => {
    expect(run(repoOn("feat/x"), command).status).toBe(0);
  });

  it.each([
    ["plainly", ["git", "push", "origin", "main"].join(" ")],
    ["with a trailing flag", PHRASE],
    ["through a global option", ["git", "-C", "/some/path", "push", "origin", "main"].join(" ")],
    ["inside a shell runner", `bash -c "${PHRASE}"`],
    ["after another command", `npm test && ${PHRASE}`],
  ])("still blocks a push that names the trunk %s", (_label, command) => {
    expect(run(repoOn("feat/x"), command).status).toBe(2);
  });

  it("keeps blocking a commit on the trunk even when its message names a push", () => {
    expect(run(repoOn("main"), `git commit -m "blocked by the rule: ${PHRASE}"`).status).toBe(2);
  });

  it("does not mistake a subcommand named in an option for the subcommand itself", () => {
    expect(run(repoOn("main"), "git log --grep=commit").status).toBe(0);
  });
});

/**
 * Reading commands instead of text is only an improvement if it never reads *fewer* of them. The
 * string match this replaced was blunt, but bluntness caught a wrapped command for free: it saw
 * `sudo git push origin main` because it saw the characters. A parser has to be told. Every case
 * here is a real invocation of a forbidden command, and the first six regressed when the parser
 * first landed -- which is what this table exists to stop happening again.
 */
describe("git-safety sees a forbidden command however it is wrapped", () => {
  function repo() {
    const root = mkdtempSync(path.join(tmpdir(), "agentspine-wrapped-"));
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(root, "a.txt"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    git("checkout", "-q", "-b", "feat/x");
    return root;
  }

  const run = (command: string) =>
    spawnSync("bash", [ADAPTER, "git-safety"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: repo(), tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo() },
    });

  const PUSH = ["git", "push", "origin", "main"].join(" ");

  it.each([
    ["sudo", `sudo ${PUSH}`],
    ["exec", `exec ${PUSH}`],
    ["nohup", `nohup ${PUSH}`],
    ["timeout and its duration", `timeout 5 ${PUSH}`],
    ["command", `command ${PUSH}`],
    ["time", `time ${PUSH}`],
    ["an environment assignment", `GIT_TRACE=1 ${PUSH}`],
  ])("blocks a push to the trunk behind %s", (_label, command) => {
    expect(run(command).status).toBe(2);
  });

  it.each([
    ["a shell runner whose payload starts elsewhere", `bash -c "cd /tmp && ${PUSH}"`],
    ["a single-quoted runner payload", `sh -c '${PUSH}'`],
    ["command substitution", `$(${PUSH})`],
    ["backticks", "`" + PUSH + "`"],
  ])("blocks a push to the trunk inside %s", (_label, command) => {
    expect(run(command).status).toBe(2);
  });

  // `eval` and a wrapper in front of a runner were the second round of this same mistake: the
  // first fix taught the policy about wrappers and about runners, but not about one in front of
  // the other, and dropped `eval` entirely on the way.
  const FORCE = ["git", "push", "-f", "origin", "feat/x"].join(" ");

  it.each([
    ["eval with a double-quoted payload", `eval "${PUSH}"`],
    ["eval with a single-quoted payload", `eval '${FORCE}'`],
    ["eval with a bare payload", `eval ${PUSH}`],
    ["a wrapper in front of a runner", `exec bash -c "${FORCE}"`],
    ["a wrapper in front of a quoted runner", `nohup sh -c '${PUSH}'`],
    ["a wrapper with an argument in front of a runner", `timeout 5 bash -c "${PUSH}"`],
    ["substitution inside a single-quoted runner payload", `bash -c '$(${FORCE})'`],
    ["substitution inside a double-quoted runner payload", `bash -c "$(${FORCE})"`],
  ])("blocks a forbidden command behind %s", (_label, command) => {
    expect(run(command).status).toBe(2);
  });

  it("blocks a force push behind a wrapper", () => {
    expect(run("sudo git push --force origin feat/x").status).toBe(2);
  });

  it("blocks a hard reset behind a wrapper", () => {
    expect(run(["sudo", "git", "reset", "--hard", "HEAD~1"].join(" ")).status).toBe(2);
  });
});
