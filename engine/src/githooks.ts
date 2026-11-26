import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Engine } from "./engine";
import { consumeOverride } from "./hooks";
import { isExempt, isProtected } from "./match";
import { runBounded } from "./tasks";
import { EngineError, type Task } from "./types";

export const MANAGED_MARK = "# estack-managed-hook";
const HOOKS = ["pre-commit", "pre-push"] as const;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function script(name: string, enginePath: string): string {
  const push = name === "pre-push";
  const lines = [
    "#!/bin/sh",
    MANAGED_MARK,
    `prev="$(dirname "$0")/${name}.estack-prev"`,
    ...(push ? ["input=$(cat)"] : []),
    push
      ? `if [ -x "$prev" ]; then printf '%s\\n' "$input" | "$prev" "$@" || exit $?; fi`
      : `if [ -x "$prev" ]; then "$prev" "$@" || exit $?; fi`,
    `[ "$CLAUDECODE" = "1" ] || exit 0`,
    `engine=${shq(enginePath)}`,
    `if [ ! -f "$engine" ]; then echo "estack: engine not found at $engine; re-run /estack:setup" >&2; exit 1; fi`,
    push
      ? `printf '%s\\n' "$input" | node --no-warnings "$engine" git-hook ${name} "$@"\nexit $?`
      : `exec node --no-warnings "$engine" git-hook ${name} "$@"`,
  ];
  return lines.join("\n") + "\n";
}

/** Install the managed hooks into the repo's shared hooks directory, chaining any existing hook. */
export function installGitHooks(repoRoot: string, enginePath: string): { installed: string[]; chained: string[] } {
  const r = runGit(repoRoot, ["rev-parse", "--git-path", "hooks"]);
  const dir = resolve(repoRoot, r);
  mkdirSync(dir, { recursive: true });
  const installed: string[] = [], chained: string[] = [];
  for (const name of HOOKS) {
    const p = join(dir, name);
    if (existsSync(p) && !readFileSync(p, "utf8").includes(MANAGED_MARK)) {
      renameSync(p, `${p}.estack-prev`);
      chained.push(name);
    }
    writeFileSync(p, script(name, enginePath));
    chmodSync(p, 0o755);
    installed.push(name);
  }
  return { installed, chained };
}

function runGit(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new EngineError("NOT_A_REPO", `git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return String(r.stdout).trim();
}

/** null = ok, else the refusal message. */
export function preCommit(e: Engine, cwd: string): string | null {
  const top = runBounded(e, cwd, "git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new EngineError("NOT_A_REPO", `not a git repository: ${cwd}`);
  const toplevel = top.stdout.trim();
  const staged = runBounded(e, toplevel, "git", ["diff", "--cached", "--name-only", "-z"]);
  if (staged.code !== 0) throw new EngineError("NOT_A_REPO", `git diff failed: ${staged.stderr.trim()}`);
  const paths = staged.stdout.split("\0").filter(Boolean);
  for (const p of paths) if (isProtected(p, e.policy)) return `commit touches protected ${p}`;
  if (paths.every((p) => isExempt(p, e.policy))) return null;
  const open = e.db.prepare("SELECT id FROM tasks WHERE status = 'open' AND cwd = ? LIMIT 1").get(toplevel);
  return open ? null : `no open estack task for ${toplevel}`;
}

const ZEROS = /^0+$/;

export function prePush(e: Engine, cwd: string, stdin: string): string | null {
  void cwd;
  for (const line of stdin.split("\n")) {
    const [localRef, localSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZEROS.test(localSha) || !localRef.startsWith("refs/heads/")) continue;
    const b = localRef.slice("refs/heads/".length);
    const t = e.db.prepare("SELECT * FROM tasks WHERE branch = ? ORDER BY id DESC LIMIT 1").get(b) as unknown as Task | undefined;
    const verify = t
      ? (e.db.prepare("SELECT status FROM steps WHERE task_id = ? AND name = 'verify'").get(t.id) as { status: string } | undefined)
      : undefined;
    if (t && verify && (verify.status === "done" || verify.status === "skipped")) continue;
    if (consumeOverride(e, "git_push", `pre-push:${b}`) !== null) continue;
    return t ? `branch ${b} has no verify evidence (task #${t.id})` : `no estack task for branch ${b}`;
  }
  return null;
}
