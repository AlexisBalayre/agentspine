import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Action } from "./plan.utils.js";
import { deepMerge, hasManagedBlock, spliceManagedBlock, hashComment } from "./managed-block.utils.js";

export type Applied = { target: string; outcome: string };

export function describe(action: Action): string {
  switch (action.kind) {
    case "create": return `create    ${action.target}`;
    case "splice": return `managed   ${action.target}`;
    case "merge-json": return `merge     ${action.target}`;
    case "symlink": return `symlink   ${action.target} -> ${action.to}`;
    case "copy-dir": return `copy      ${action.target}/`;
    case "render-dir": return `render    ${action.target}/`;
    case "copy": return `copy      ${action.target}`;
    case "skip": return `skip      ${action.target} (${action.reason})`;
  }
}

/**
 * Would applying this action modify the tree? Compares *content*, not inodes: a shared
 * directory the project symlinks into a single source resolves to the same bytes as the
 * copy this tool would write, and that is not drift.
 */
export function wouldChange(action: Action, root: string): boolean {
  const target = path.join(root, action.target);

  switch (action.kind) {
    case "skip":
      return false;
    case "create":
      return !existsSync(target);
    case "splice": {
      const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
      const comment = action.hashComments ? hashComment : undefined;
      return spliceManagedBlock(existing, action.content, comment) !== existing;
    }
    case "merge-json": {
      if (!existsSync(target)) return true;
      const existing = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
      return `${JSON.stringify(deepMerge(existing, action.value), null, 2)}\n` !== readFileSync(target, "utf8");
    }
    case "symlink": {
      if (isLink(target)) return readlinkSync(target) !== action.to;
      // A host that cannot symlink gets a copy instead, and a faithful copy is not drift:
      // --check would otherwise fail forever on the machines that needed the fallback.
      if (!existsSync(target)) return true;
      const source = linkSource(target, action.to);
      return !existsSync(source) || !sameTree(source, target);
    }
    case "copy":
      return !existsSync(target) || readFileSync(target, "utf8") !== readFileSync(action.from, "utf8");
    case "copy-dir":
      return !existsSync(target) || !sameTree(action.from, target);
    case "render-dir":
      // A link here is the shared tree itself, which must not carry what is rendered.
      return (
        isLink(target) ||
        Object.entries(action.files).some(([name, content]) => {
          const file = path.join(target, name);
          return !existsSync(file) || readFileSync(file, "utf8") !== content;
        })
      );
  }
}

/** What a link points at, as an absolute path: link targets are relative to the link's own directory. */
function linkSource(target: string, to: string): string {
  return path.resolve(path.dirname(target), to);
}

function sameTree(from: string, to: string): boolean {
  const entries = readdirSync(from, { withFileTypes: true });
  for (const entry of entries) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (!existsSync(b)) return false;
    if (statSync(a).isDirectory()) {
      if (!statSync(b).isDirectory() || !sameTree(a, b)) return false;
    } else if (readFileSync(a, "utf8") !== readFileSync(b, "utf8")) {
      return false;
    }
  }
  return true;
}

export function apply(actions: Action[], root: string): Applied[] {
  return actions.map((action) => ({ target: action.target, outcome: applyOne(action, root) }));
}

function applyOne(action: Action, root: string): string {
  const target = path.join(root, action.target);

  switch (action.kind) {
    case "skip":
      return "skipped";

    case "create": {
      if (existsSync(target)) return "kept";
      write(target, action.content);
      return "created";
    }

    case "splice": {
      const comment = action.hashComments ? hashComment : undefined;
      const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
      const updated = spliceManagedBlock(existing, action.content, comment);
      if (updated === existing) return "unchanged";
      write(target, updated);
      return hasManagedBlock(existing, comment) ? "block updated" : existing ? "block added" : "created";
    }

    case "merge-json": {
      const existing = existsSync(target)
        ? (JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>)
        : {};
      const merged = deepMerge(existing, action.value);
      const serialised = `${JSON.stringify(merged, null, 2)}\n`;
      if (existsSync(target) && readFileSync(target, "utf8") === serialised) return "unchanged";
      write(target, serialised);
      return existsSync(target) ? "merged" : "created";
    }

    case "symlink": {
      mkdirSync(path.dirname(target), { recursive: true });
      if (existsSync(target) || isLink(target)) {
        if (isLink(target)) unlinkSync(target);
        else return "kept (not a symlink)";
      }
      try {
        symlinkSync(action.to, target);
        return "linked";
      } catch {
        // Windows refuses symlinks without Developer Mode or admin rights. Leaving the path
        // out would make every skill invisible to the tool that reads through it, so the
        // content is copied and the outcome says which one you got.
        cpSync(linkSource(target, action.to), target, { recursive: true });
        return "copied (symlinks unavailable here)";
      }
    }

    case "copy-dir": {
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(action.from, target, { recursive: true });
      return "copied";
    }

    case "copy": {
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(action.from, target);
      return "copied";
    }

    case "render-dir": {
      // Unlinked first: written through a link left by an earlier version, these files would
      // land in the shared tree the link points at.
      const linked = isLink(target);
      if (linked) unlinkSync(target);
      for (const [name, content] of Object.entries(action.files)) write(path.join(target, name), content);
      return linked ? "rendered (replaced the symlink)" : "rendered";
    }
  }
}

function write(target: string, content: string) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function isLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}
