import type { Policy } from "./policy";

const escapeRe = (c: string) => c.replace(/[.+^${}()|[\]\\\/-]/g, "\\$&");

/**
 * Compile a glob to an anchored RegExp.
 * command mode: `*` is any characters (including `/` and spaces), `?` is one character.
 * path mode: `**` spans segments, `*` stays in one segment, `?` is one non-slash character.
 */
export function globToRegExp(glob: string, mode: "command" | "path"): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (mode === "path" && glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += mode === "path" ? "[^/]*" : ".*";
      }
    } else if (c === "?") {
      out += mode === "path" ? "[^/]" : ".";
    } else {
      out += escapeRe(c);
    }
  }
  return new RegExp(`^${out}$`, "s");
}

/** Whole-command match, or the whole command with `*` prepended (catches `cd x && ...`). */
export function commandMatches(command: string, pattern: string): boolean {
  return globToRegExp(pattern, "command").test(command) || globToRegExp(`*${pattern}`, "command").test(command);
}

export type CommandVerdict =
  | { kind: "none" }
  | { kind: "deny"; action: string; pattern: string; hardcoded: boolean }
  | { kind: "ask"; action: string; pattern: string };

export const HARDCODED_DENY: ReadonlyArray<{ action: string; pattern: string }> = [
  { action: "engine_state", pattern: "*.estack/state.db*" },
  { action: "owner_only", pattern: "estack skip*" },
  { action: "owner_only", pattern: "estack cancel*" },
  { action: "owner_only", pattern: "estack override*" },
  { action: "owner_only", pattern: "*estack.mjs skip*" },
  { action: "owner_only", pattern: "*estack.mjs cancel*" },
  { action: "owner_only", pattern: "*estack.mjs override*" },
  { action: "disable_hooks", pattern: "*--no-verify*" },
  { action: "disable_hooks", pattern: "*core.hooksPath*" },
  { action: "disable_hooks", pattern: "git config*hooks*" },
];

export function classifyCommand(command: string, policy: Policy): CommandVerdict {
  for (const h of HARDCODED_DENY) {
    if (commandMatches(command, h.pattern)) return { kind: "deny", action: h.action, pattern: h.pattern, hardcoded: true };
  }
  for (const action of policy.actions.deny) {
    for (const pattern of policy.patterns[action] ?? []) {
      if (commandMatches(command, pattern)) return { kind: "deny", action, pattern, hardcoded: false };
    }
  }
  for (const action of policy.actions.ask) {
    for (const pattern of policy.patterns[action] ?? []) {
      if (commandMatches(command, pattern)) return { kind: "ask", action, pattern };
    }
  }
  return { kind: "none" };
}

/** relPath is relative to the worktree root, uses `/`, no leading `./`. A pattern without `/` matches the basename at any depth. */
export function pathMatches(relPath: string, pattern: string): boolean {
  const re = globToRegExp(pattern, "path");
  if (pattern.includes("/")) return re.test(relPath);
  return re.test(relPath.slice(relPath.lastIndexOf("/") + 1));
}

export function isProtected(relPath: string, policy: Policy): boolean {
  return policy.protected_paths.some((p) => pathMatches(relPath, p));
}

export function isExempt(relPath: string, policy: Policy): boolean {
  return policy.exempt_paths.some((p) => pathMatches(relPath, p));
}
