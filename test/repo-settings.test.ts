import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sandbox checks a write against the path it resolves to, so a deny on `./.agents` does not
 * reach a directory `.agents/` links into, and here most of `.agents/` links into `templates/`
 * (decision 34).
 */
describe("this repository's Claude Code settings", () => {
  it("deny sandboxed writes to every path .agents/ resolves to", () => {
    const settings = JSON.parse(readFileSync(path.resolve(".claude/settings.json"), "utf8"));
    const denied = (settings.sandbox.filesystem.denyWrite as string[]).map((entry) => realpathSync(path.resolve(entry)));
    for (const name of readdirSync(".agents")) {
      const real = realpathSync(path.join(".agents", name));
      expect(denied.some((dir) => real === dir || real.startsWith(`${dir}${path.sep}`)), real).toBe(true);
    }
  });
});
