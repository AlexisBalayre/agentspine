import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const TSX = path.resolve("node_modules/.bin/tsx");
const CLI = path.resolve("src/cli.ts");

/**
 * opencode is the one tool `doctor` cannot probe, because its adapter is a plugin the host
 * loads rather than a script we can hand a payload to. Until now nothing executed the emitted
 * plugin at all -- a test asserted the file existed. A syntax error, a bad import or a handler
 * that never threw would have shipped, and the only place it would surface is a user's session,
 * where a hook that fails to block looks exactly like a hook that found nothing to block.
 *
 * Node can load it, so Node does. What this proves is the shim's own half of the contract: it
 * loads, it exports what a plugin must export, and its handlers run the shared policies and
 * express a block by throwing. What it cannot prove is the other half -- that opencode calls
 * these handlers with these shapes. That still needs a live session, and the capability matrix
 * says so rather than counting this as the tool being verified.
 */
describe("the emitted opencode plugin, loaded by Node", () => {
  let repo: string;
  let plugin: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "agentspine-opencode-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "package.json"), '{ "name": "demo" }\n');
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    spawnSync("git", ["checkout", "-q", "-b", "feat/x"], { cwd: repo });

    const scaffold = spawnSync(TSX, [CLI, "--dir", repo, "--tools", "opencode", "--yes"], { encoding: "utf8" });
    expect(scaffold.status).toBe(0);
    plugin = path.join(repo, ".opencode", "plugins", "agentspine.js");
  });

  /** The plugin as opencode would load it: an ES module, from the scaffolded tree. */
  async function handlers() {
    const module = await import(pathToFileURL(plugin).href);
    expect(typeof module.AgentSpine).toBe("function");
    return module.AgentSpine({ directory: repo, worktree: repo });
  }

  it("loads as an ES module and exports a plugin factory", async () => {
    await expect(handlers()).resolves.toBeTypeOf("object");
  });

  it("throws on a command the shared policy blocks, carrying the policy's reason", async () => {
    const hooks = await handlers();
    const call = hooks["tool.execute.before"](
      { tool: "bash" },
      { args: { command: ["git", "push", "--force", "origin", "main"].join(" ") } },
    );
    await expect(call).rejects.toThrow(/git-safety/);
  });

  it("lets an ordinary command through", async () => {
    const hooks = await handlers();
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls -la" } })).resolves.toBeUndefined();
  });

  it("ignores tools other than bash, and a bash call with no command", async () => {
    const hooks = await handlers();
    const forbidden = ["git", "push", "--force", "origin", "main"].join(" ");
    await expect(hooks["tool.execute.before"]({ tool: "read" }, { args: { command: forbidden } })).resolves.toBeUndefined();
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: {} })).resolves.toBeUndefined();
  });

  // Nothing can be blocked after the fact, so these must complete rather than throw: a plugin
  // that throws outside the blocking path takes the session down over a lint failure.
  it("does not throw from the after-edit or idle handlers", async () => {
    const hooks = await handlers();
    await expect(hooks["tool.execute.after"]({ tool: "edit" }, { args: { filePath: "a.ts" } })).resolves.toBeUndefined();
    await expect(hooks.event({ event: { type: "session.idle" } })).resolves.toBeUndefined();
    await expect(hooks.event({ event: { type: "something.else" } })).resolves.toBeUndefined();
  });
});
