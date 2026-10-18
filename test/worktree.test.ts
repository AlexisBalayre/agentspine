import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CREATE = path.resolve("templates/agents/scripts/worktree-create.sh");
const REMOVE = path.resolve("templates/agents/scripts/worktree-remove.sh");
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI = path.resolve("src/cli.ts");

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** A committed repository with a bare origin, so branches can be published and deleted. */
function repoWithOrigin(worktreeEnv?: string) {
  const base = mkdtempSync(path.join(tmpdir(), "agentspine-wt-"));
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  spawnSync("git", ["init", "-q", "--bare", origin]);
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "README.md"), "demo\n");
  if (worktreeEnv !== undefined) {
    mkdirSync(path.join(repo, ".agents"));
    writeFileSync(path.join(repo, ".agents", "worktree.env"), worktreeEnv);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", origin);
  return repo;
}

function run(script: string, cwd: string, ...args: string[]) {
  const result = spawnSync("bash", [script, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs worktree-remove.sh with `gh` replaced by a stub, so no test reaches the real forge: the
 * stub names `main` as the default branch, and its body decides what a merged-PR lookup answers.
 * `exit 1` stands for a gh that is missing or not signed in.
 */
function remove(cwd: string, ghBody: string, ...names: string[]) {
  const bin = mkdtempSync(path.join(tmpdir(), "agentspine-gh-"));
  const defaultBranch = ghBody === NO_GH ? "" : 'if [ "$1 $2" = "repo view" ]; then echo main; exit 0; fi\n';
  writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash\n${defaultBranch}${ghBody}\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  const result = spawnSync("bash", [REMOVE, ...names], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const NO_GH = "exit 1";

/** A worktree on `feature/<name>` carrying one commit of its own. */
function worktreeWithCommit(repo: string, name: string) {
  run(CREATE, repo, name);
  const dir = path.join(repo, ".worktrees", name);
  writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", name);
  return { dir, tip: git(dir, "rev-parse", "HEAD").stdout.trim() };
}

function hasBranch(cwd: string, branch: string) {
  return git(cwd, "rev-parse", "-q", "--verify", `refs/heads/${branch}`).status === 0;
}

function originHas(repo: string, branch: string) {
  return git(repo, "ls-remote", "--exit-code", "--heads", "origin", branch).status === 0;
}

describe("worktree scripts", () => {
  it("creates a worktree on a prefixed branch and runs the install command inside it", () => {
    const repo = repoWithOrigin('WORKTREE_INSTALL="touch installed"\n');
    const { status } = run(CREATE, repo, "search");
    expect(status).toBe(0);
    expect(git(path.join(repo, ".worktrees/search"), "branch", "--show-current").stdout.trim()).toBe("feature/search");
    expect(existsSync(path.join(repo, ".worktrees/search/installed"))).toBe(true);
  });

  it("works with no config at all", () => {
    const repo = repoWithOrigin();
    expect(run(CREATE, repo, "plain").status).toBe(0);
    expect(existsSync(path.join(repo, ".worktrees/plain"))).toBe(true);
  });

  it("refuses to reuse an existing worktree name", () => {
    const repo = repoWithOrigin();
    run(CREATE, repo, "twice");
    const { status, stderr } = run(CREATE, repo, "twice");
    expect(status).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("fails loudly when the install command fails, rather than leaving a half-ready worktree unannounced", () => {
    const repo = repoWithOrigin('WORKTREE_INSTALL="false"\n');
    expect(run(CREATE, repo, "broken").status).not.toBe(0);
  });

  it.each(["../outside", "a/b", "-f", "a b", ".scratch"])("refuses %s as a worktree name", (name) => {
    const repo = repoWithOrigin();
    const { status, stderr } = run(CREATE, repo, name);
    expect(status).toBe(1);
    expect(stderr).toContain("not a worktree name");
    expect(git(repo, "worktree", "list", "--porcelain").stdout.match(/^worktree /gm)).toHaveLength(1);
  });
});

describe("worktree-remove", () => {
  it("removes the worktree and its branch once origin holds every commit, leaving origin's copy", () => {
    const repo = repoWithOrigin();
    worktreeWithCommit(repo, "pushed");
    git(repo, "push", "-q", "origin", "feature/pushed");

    const { status, stdout } = remove(repo, NO_GH, "pushed");
    expect(status).toBe(0);
    expect(stdout).toContain("Removed .worktrees/pushed");
    expect(existsSync(path.join(repo, ".worktrees/pushed"))).toBe(false);
    expect(hasBranch(repo, "feature/pushed")).toBe(false);
    expect(originHas(repo, "feature/pushed")).toBe(true);
  });

  it("keeps a branch with commits no remote holds, without claiming no PR shipped them", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    worktreeWithCommit(repo, "local");

    const { status, stderr } = remove(repo, NO_GH, "local");
    expect(status).toBe(0);
    expect(existsSync(path.join(repo, ".worktrees/local"))).toBe(false);
    expect(hasBranch(repo, "feature/local")).toBe(true);
    expect(stderr).toContain("gh could not say");
    expect(stderr).not.toContain("no merged PR shipped it");
  });

  it("says no merged PR shipped a branch only when gh answered", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    worktreeWithCommit(repo, "unshipped");

    const { stderr } = remove(repo, "exit 0", "unshipped");
    expect(hasBranch(repo, "feature/unshipped")).toBe(true);
    expect(stderr).toContain("no merged PR shipped it");
  });

  it("keeps a worktree with uncommitted or untracked files, and its branch", () => {
    const repo = repoWithOrigin();
    const { dir } = worktreeWithCommit(repo, "dirty");
    git(repo, "push", "-q", "origin", "feature/dirty");
    writeFileSync(path.join(dir, "scratch.txt"), "unsaved\n");

    const { status, stderr } = remove(repo, NO_GH, "dirty");
    expect(status).toBe(0);
    expect(stderr).toContain("Kept .worktrees/dirty");
    expect(existsSync(path.join(dir, "scratch.txt"))).toBe(true);
    expect(hasBranch(repo, "feature/dirty")).toBe(true);
  });

  it("keeps a worktree on a detached HEAD, whose commits no branch may hold", () => {
    const repo = repoWithOrigin();
    const { dir } = worktreeWithCommit(repo, "detached");
    git(dir, "checkout", "-q", "--detach");
    writeFileSync(path.join(dir, "orphan.txt"), "orphan\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "on no branch");

    const { stderr } = remove(repo, NO_GH, "detached");
    expect(stderr).toContain("detached HEAD");
    expect(existsSync(dir)).toBe(true);
  });

  // .worktrees/ can hold worktrees another tool made, and a clean one would otherwise go.
  it("keeps a worktree on a branch outside the configured prefix, and the branch", () => {
    const repo = repoWithOrigin('WORKTREE_BRANCH_PREFIX="wt"\n');
    git(repo, "worktree", "add", "-q", ".worktrees/spike", "-b", "spike/other");
    git(repo, "push", "-q", "origin", "spike/other");

    const { stderr } = remove(repo, NO_GH, "spike");
    expect(existsSync(path.join(repo, ".worktrees/spike"))).toBe(true);
    expect(hasBranch(repo, "spike/other")).toBe(true);
    expect(stderr).toContain("spike/other is not a wt/ branch");
  });

  it("refuses a name that reaches outside .worktrees/", () => {
    const repo = repoWithOrigin();
    run(CREATE, repo, "here");
    git(repo, "worktree", "add", "-q", path.join(repo, "..", "sibling"), "-b", "feature/sibling");

    const { stderr } = remove(repo, NO_GH, "../../sibling");
    expect(existsSync(path.join(repo, "..", "sibling"))).toBe(true);
    expect(stderr).toContain("not a worktree name");
  });

  it("removes clean worktrees but keeps every branch when the fetch fails, since a stale ref could vouch", () => {
    const repo = repoWithOrigin();
    worktreeWithCommit(repo, "offline");
    git(repo, "push", "-q", "origin", "feature/offline");
    git(repo, "remote", "set-url", "origin", path.join(repo, "..", "gone.git"));

    const { status, stderr } = remove(repo, NO_GH, "offline");
    expect(status).toBe(0);
    expect(stderr).toContain("Fetch failed");
    expect(existsSync(path.join(repo, ".worktrees/offline"))).toBe(false);
    expect(hasBranch(repo, "feature/offline")).toBe(true);
  });

  it("deletes a squash-merged branch and origin's copy once a merged PR shipped its tip", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const { tip } = worktreeWithCommit(repo, "squashed");
    git(repo, "push", "-q", "origin", "feature/squashed");

    const { status } = remove(repo, `echo ${tip}`, "squashed");
    expect(status).toBe(0);
    expect(hasBranch(repo, "feature/squashed")).toBe(false);
    expect(originHas(repo, "feature/squashed")).toBe(false);
  });

  // A forge set to delete head branches on merge leaves origin no copy, so only the PR vouches.
  it("deletes a merged branch whose copy the forge already removed from origin", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const { tip } = worktreeWithCommit(repo, "autodeleted");
    git(repo, "push", "-q", "origin", "feature/autodeleted");
    // On origin itself, so the clone keeps the stale tracking ref a forge's delete leaves.
    git(path.join(repo, "..", "origin.git"), "update-ref", "-d", "refs/heads/feature/autodeleted");

    const { status, stderr } = remove(repo, `echo ${tip}`, "autodeleted");
    expect(status, stderr).toBe(0);
    expect(hasBranch(repo, "feature/autodeleted")).toBe(false);
    expect(stderr).not.toContain("delete refused");
  });

  // A stacked PR merges into its parent's branch, which has not reached the default branch.
  it("keeps a branch whose PR merged into another branch, not the default one", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const { tip } = worktreeWithCommit(repo, "stacked");
    const intoParentOnly = `case "$*" in *"--base main"*) ;; *) echo ${tip} ;; esac`;

    const { stderr } = remove(repo, intoParentOnly, "stacked");
    expect(hasBranch(repo, "feature/stacked")).toBe(true);
    expect(stderr).toContain("no merged PR shipped it");
  });

  // A short name would match the tag too, and git refuses a push whose destination is ambiguous.
  it("deletes origin's copy when a tag there shares the branch's name", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const { tip } = worktreeWithCommit(repo, "tagged");
    git(repo, "push", "-q", "origin", "feature/tagged", `${tip}:refs/tags/feature/tagged`);

    const { stderr } = remove(repo, `echo ${tip}`, "tagged");
    expect(originHas(repo, "feature/tagged"), stderr).toBe(false);
  });

  it("keeps origin's copy when it moved past the merged tip", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const { dir, tip } = worktreeWithCommit(repo, "moved");
    writeFileSync(path.join(dir, "later.txt"), "later\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "after the merge");
    git(dir, "push", "-q", "origin", "feature/moved");
    git(dir, "reset", "-q", "--hard", tip);

    const { stderr } = remove(repo, `echo ${tip}`, "moved");
    expect(hasBranch(repo, "feature/moved")).toBe(false);
    expect(originHas(repo, "feature/moved")).toBe(true);
    expect(stderr).toContain("moved past the merged tip");
  });

  it("leaves origin's copy when it moves between the fetch and the delete", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const { tip } = worktreeWithCommit(repo, "raced");
    git(repo, "push", "-q", "origin", "feature/raced");
    const origin = path.join(repo, "..", "origin.git");
    // The lookup runs after the fetch, so moving origin's branch from inside it is the race.
    const racingGh = `git --git-dir="${origin}" update-ref refs/heads/feature/raced "$(git --git-dir="${origin}" rev-parse main)"\necho ${tip}`;

    const { stderr } = remove(repo, racingGh, "raced");
    expect(hasBranch(repo, "feature/raced")).toBe(false);
    expect(originHas(repo, "feature/raced")).toBe(true);
    expect(stderr).toContain("delete refused");
  });

  it("names a worktree that does not exist rather than failing the rest", () => {
    const repo = repoWithOrigin();
    worktreeWithCommit(repo, "real");
    git(repo, "push", "-q", "origin", "feature/real");

    const { status, stderr } = remove(repo, NO_GH, "missing", "real");
    expect(status).toBe(0);
    expect(stderr).toContain("Skipped missing");
    expect(existsSync(path.join(repo, ".worktrees/real"))).toBe(false);
  });
});

describe("worktree-remove --merged", () => {
  it("removes every worktree whose tip a merged PR shipped, and keeps the rest", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const shipped = worktreeWithCommit(repo, "shipped");
    git(repo, "push", "-q", "origin", "feature/shipped");
    const open = worktreeWithCommit(repo, "open");
    git(repo, "push", "-q", "origin", "feature/open");
    git(repo, "worktree", "add", "-q", ".worktrees/other", "-b", "spike/other");

    const { status, stderr } = remove(repo, `echo ${shipped.tip}`, "--merged");
    expect(status, stderr).toBe(0);
    expect(existsSync(shipped.dir)).toBe(false);
    expect(hasBranch(repo, "feature/shipped")).toBe(false);
    expect(originHas(repo, "feature/shipped")).toBe(false);
    expect(existsSync(open.dir)).toBe(true);
    expect(hasBranch(repo, "feature/open")).toBe(true);
    expect(stderr).toContain("Kept .worktrees/open: no PR merged into main has its tip as head");
    expect(existsSync(path.join(repo, ".worktrees/other"))).toBe(true);
  });

  it("keeps a shipped worktree that has uncommitted files", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const { dir, tip } = worktreeWithCommit(repo, "dirty");
    writeFileSync(path.join(dir, "scratch.txt"), "unsaved\n");

    remove(repo, `echo ${tip}`, "--merged");
    expect(existsSync(path.join(dir, "scratch.txt"))).toBe(true);
    expect(hasBranch(repo, "feature/dirty")).toBe(true);
  });

  it("removes nothing when gh cannot answer, and says so", () => {
    const repo = repoWithOrigin();
    const { dir } = worktreeWithCommit(repo, "unknown");
    git(repo, "push", "-q", "origin", "feature/unknown");

    const { status, stderr } = remove(repo, NO_GH, "--merged");
    expect(status).toBe(1);
    expect(existsSync(dir)).toBe(true);
    expect(stderr).toContain("gh could not say whether a merged PR shipped its tip");
  });

  it("keeps a worktree git cannot read, and carries on with the rest", () => {
    const repo = repoWithOrigin();
    git(repo, "push", "-q", "origin", "main");
    const stale = worktreeWithCommit(repo, "a-stale");
    const shipped = worktreeWithCommit(repo, "b-shipped");
    rmSync(path.join(repo, ".git/worktrees/a-stale"), { recursive: true });

    const { status, stderr } = remove(repo, `echo ${shipped.tip}`, "--merged");
    expect(status, stderr).toBe(0);
    expect(stderr).toContain("Kept .worktrees/a-stale: git cannot read it as a worktree");
    expect(existsSync(stale.dir)).toBe(true);
    expect(existsSync(shipped.dir)).toBe(false);
  });

  it("fails without removing anything when the fetch fails", () => {
    const repo = repoWithOrigin();
    const { dir, tip } = worktreeWithCommit(repo, "offline");
    git(repo, "remote", "set-url", "origin", path.join(repo, "..", "gone.git"));

    const { status } = remove(repo, `echo ${tip}`, "--merged");
    expect(status).not.toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it.each([
    ["--merged", "extra"],
    ["extra", "--merged"],
  ])("takes no names alongside the flag (%s %s)", (...args) => {
    const repo = repoWithOrigin();
    const { dir, tip } = worktreeWithCommit(repo, "extra");
    git(repo, "push", "-q", "origin", "feature/extra");
    expect(remove(repo, `echo ${tip}`, ...args).status).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("init emits the worktree setup", () => {
  it("installs executable scripts, a config to fill, and ignores the worktree directory", () => {
    const repo = repoWithOrigin();
    mkdirSync(path.join(repo, ".claude"));
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "tools");
    spawnSync(TSX, [CLI, "--dir", repo, "--yes", "--skip-hooks"], { encoding: "utf8" });

    for (const script of ["worktree-create.sh", "worktree-remove.sh"]) {
      expect(statSync(path.join(repo, ".agents/scripts", script)).mode & 0o111).not.toBe(0);
    }
    expect(existsSync(path.join(repo, ".agents/scripts/worktree-clean.sh"))).toBe(false);
    expect(existsSync(path.join(repo, ".agents/worktree.env"))).toBe(true);
    const ignore = readFileSync(path.join(repo, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toMatch(/^\.worktrees\/$/m);
  });
});
