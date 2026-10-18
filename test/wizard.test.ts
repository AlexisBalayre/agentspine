import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TEMPLATE = path.resolve("templates/agents/skills/wizard/template.sh");

/** Runs `write_env` from the wizard's library alone; the stages below the marker would prompt. */
function writeEnv(envFile: string, key: string, value: string) {
  // eval, not `source <(…)`: bash 3.2 sources an empty file from a process substitution.
  const script = `eval "$(sed '/^# STAGES/,$d' "$0")"; write_env "$1" "$2"`;
  const result = spawnSync("bash", ["-c", script, TEMPLATE, key, value], {
    env: { ...process.env, ENV_FILE: envFile },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
}

const mode = (file: string) => statSync(file).mode & 0o777;

describe("the wizard's write_env", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "agentspine-wizard-"));

  it("creates the env file readable by its owner only", () => {
    const env = path.join(dir(), ".env");
    writeEnv(env, "KEY", "it's");
    expect(readFileSync(env, "utf8")).toBe("KEY='it'\\''s'\n");
    expect(mode(env)).toBe(0o600);
  });

  // An env file copied from a checked-in example is 0644; the secret must not land in it as is.
  it("takes group and other access off an env file that already exists", () => {
    const env = path.join(dir(), ".env");
    writeFileSync(env, "OTHER=1\n");
    chmodSync(env, 0o644);
    writeEnv(env, "KEY", "secret");
    expect(readFileSync(env, "utf8")).toBe("OTHER=1\nKEY='secret'\n");
    expect(mode(env)).toBe(0o600);
  });

  it("writes through a symlink, to a target left readable by its owner only", () => {
    const base = dir();
    const target = path.join(base, "shared.env");
    const env = path.join(base, ".env");
    writeFileSync(target, "");
    chmodSync(target, 0o644);
    symlinkSync(target, env);
    writeEnv(env, "KEY", "secret");
    expect(lstatSync(env).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("KEY='secret'\n");
    expect(mode(target)).toBe(0o600);
  });
});
