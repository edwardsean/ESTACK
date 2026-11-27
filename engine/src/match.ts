import type { Policy } from "./policy";

const escapeRe = (c: string) => c.replace(/[.+^${}()|[\]\\\/-]/g, "\\$&");

/**
 * Compile a glob to an anchored RegExp.
 * command mode: `*` is any characters (including `/` and spaces), `?` is one character.
 * path mode: `**` spans segments, `*` stays in one segment, `?` is one non-slash character.
 */
export function globToRegExp(glob: string, mode: "command" | "path", ignoreCase = false): RegExp {
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
  return new RegExp(`^${out}$`, ignoreCase ? "si" : "s");
}

/** Whole-command match, or the whole command with `*` prepended (catches `cd x && ...`). */
export function commandMatches(command: string, pattern: string, ignoreCase = false): boolean {
  return globToRegExp(pattern, "command", ignoreCase).test(command) || globToRegExp(`*${pattern}`, "command", ignoreCase).test(command);
}

// An option value: quoted or unquoted pieces, so `-C "a b"` and `-c k="A B"` are one value.
const GIT_OPT_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)+`;
/** git options that may sit between `git` and its subcommand. */
const GIT_GLOBAL_OPTS = String.raw`(?: (?:-C ${GIT_OPT_VALUE}|-c ${GIT_OPT_VALUE}|--git-dir=${GIT_OPT_VALUE}|--work-tree=${GIT_OPT_VALUE}|--git-dir ${GIT_OPT_VALUE}|--work-tree ${GIT_OPT_VALUE}|--no-pager|-P))+`;
const GIT_GLOBAL_RE = new RegExp(String.raw`\bgit${GIT_GLOBAL_OPTS}(?= |$)`, "g");

/** Collapse whitespace runs to one space and drop git global options, so `git -C x  push` reads `git push`. */
export function normaliseCommand(command: string): string {
  return command.replace(/\s+/g, " ").replace(GIT_GLOBAL_RE, "git");
}

/** `git commit -n` (and clusters like `-anm`) is the short form of --no-verify. */
const COMMIT_NO_VERIFY = /\bgit commit\b[^|;&]*\s-[a-zA-Z]*n[a-zA-Z]*\b/;

export type CommandVerdict =
  | { kind: "none" }
  | { kind: "deny"; action: string; pattern: string; hardcoded: boolean }
  | { kind: "ask"; action: string; pattern: string };

export const HARDCODED_DENY: ReadonlyArray<{ action: string; pattern: string }> = [
  { action: "engine_state", pattern: "*.estack/state.db*" },
  { action: "engine_state", pattern: "*sqlite3*state.db*" },
  { action: "owner_only", pattern: "estack skip*" },
  { action: "owner_only", pattern: "estack cancel*" },
  { action: "owner_only", pattern: "estack override*" },
  { action: "owner_only", pattern: "*estack.mjs skip*" },
  { action: "owner_only", pattern: "*estack.mjs cancel*" },
  { action: "owner_only", pattern: "*estack.mjs override*" },
  { action: "disable_hooks", pattern: "*--no-verify*" },
  { action: "disable_hooks", pattern: "*core.hooksPath*" },
  { action: "disable_hooks", pattern: "git config*hooks*" },
  { action: "disable_hooks", pattern: "*CLAUDECODE*" },
];

/**
 * Hard-coded denials (case-insensitive), then policy deny, then policy ask (case-sensitive).
 * Each is checked against the raw command and its normalised form; either matching counts.
 */
export function classifyCommand(command: string, policy: Policy): CommandVerdict {
  const forms = [command, normaliseCommand(command)];
  const any = (pattern: string, ignoreCase = false) => forms.some((c) => commandMatches(c, pattern, ignoreCase));
  for (const h of HARDCODED_DENY) {
    if (any(h.pattern, true)) return { kind: "deny", action: h.action, pattern: h.pattern, hardcoded: true };
  }
  if (forms.some((c) => COMMIT_NO_VERIFY.test(c))) {
    return { kind: "deny", action: "disable_hooks", pattern: "git commit -n", hardcoded: true };
  }
  for (const action of policy.actions.deny) {
    for (const pattern of policy.patterns[action] ?? []) {
      if (any(pattern)) return { kind: "deny", action, pattern, hardcoded: false };
    }
  }
  for (const action of policy.actions.ask) {
    for (const pattern of policy.patterns[action] ?? []) {
      if (any(pattern)) return { kind: "ask", action, pattern };
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
