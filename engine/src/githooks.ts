import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Engine } from "./engine";
import { consumeOverride } from "./hooks";
import { isExempt, isProtected } from "./match";
import { HOOK_GIT_TIMEOUT_MS, pushReadiness, runBounded } from "./tasks";
import { EngineError } from "./types";

export const MANAGED_MARK = "# estack-managed-hook";
export const MAP_HOOKS = ["post-commit", "post-checkout", "post-merge", "post-rewrite"] as const;
const HOOKS = ["pre-commit", "pre-push", ...MAP_HOOKS] as const;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Lines that set `engine`, falling back to the newest plugin cache copy when the recorded path is gone. */
function resolveEngine(enginePath: string): string[] {
  return [
    `engine=${shq(enginePath)}`,
    // The recorded path sits in a versioned plugin cache folder that a plugin update replaces: fall back to the newest copy.
    `if [ ! -f "$engine" ]; then`,
    `  cands="$(ls -d "$HOME"/.claude/plugins/cache/estack/estack/*/engine/estack.mjs 2>/dev/null)"`,
    `  latest="$(printf '%s\n' "$cands" | sort -V 2>/dev/null | tail -n 1)"`,
    `  [ -n "$latest" ] || latest="$(printf '%s\n' "$cands" | sort | tail -n 1)"`,
    `  if [ -n "$latest" ] && [ -f "$latest" ]; then engine="$latest"; fi`,
    `fi`,
  ];
}

const isMapHook = (name: string) => (MAP_HOOKS as readonly string[]).includes(name);

/** Map hooks never make git wait or fail: chained hooks run with their status ignored, the engine runs detached. */
function mapScript(name: string, enginePath: string): string {
  const rewrite = name === "post-rewrite";
  const lines = [
    "#!/bin/sh",
    MANAGED_MARK,
    `dir="$(dirname "$0")"`,
    ...(rewrite ? ["input=$(cat)"] : []),
    rewrite
      ? `for prev in "$dir/${name}.estack-prev" "$dir/${name}.estack-prev".[0-9]*; do [ -x "$prev" ] || continue; printf '%s\\n' "$input" | "$prev" "$@" || true; done`
      : `for prev in "$dir/${name}.estack-prev" "$dir/${name}.estack-prev".[0-9]*; do [ -x "$prev" ] || continue; "$prev" "$@" || true; done`,
    ...resolveEngine(enginePath),
    `[ -f "$engine" ] || exit 0`,
    `nohup node --no-warnings "$engine" map-hook ${name} </dev/null >/dev/null 2>&1 &`,
    `exit 0`,
  ];
  return lines.join("\n") + "\n";
}

function script(name: string, enginePath: string): string {
  if (isMapHook(name)) return mapScript(name, enginePath);
  const push = name === "pre-push";
  const lines = [
    "#!/bin/sh",
    MANAGED_MARK,
    `dir="$(dirname "$0")"`,
    ...(push ? ["input=$(cat)"] : []),
    push
      ? `for prev in "$dir/${name}.estack-prev" "$dir/${name}.estack-prev".[0-9]*; do [ -x "$prev" ] || continue; printf '%s\\n' "$input" | "$prev" "$@" || exit $?; done`
      : `for prev in "$dir/${name}.estack-prev" "$dir/${name}.estack-prev".[0-9]*; do [ -x "$prev" ] || continue; "$prev" "$@" || exit $?; done`,
    `[ "$CLAUDECODE" = "1" ] || exit 0`,
    ...resolveEngine(enginePath),
    `if [ ! -f "$engine" ]; then echo "estack: engine not found at $engine; re-run /estack:setup" >&2; exit 1; fi`,
    push
      ? `printf '%s\\n' "$input" | node --no-warnings "$engine" git-hook ${name} "$@"\nexit $?`
      : `exec node --no-warnings "$engine" git-hook ${name} "$@"`,
  ];
  return lines.join("\n") + "\n";
}

/** Install the managed hooks into the repo's shared hooks directory, chaining any existing hook. */
export function installGitHooks(repoRoot: string, enginePath: string): { installed: string[]; chained: string[]; skipped?: string } {
  const cfg = spawnSync("git", ["config", "core.hooksPath"], { cwd: repoRoot, encoding: "utf8" });
  const hp = cfg.status === 0 ? cfg.stdout.trim() : "";
  if (hp) return { installed: [], chained: [], skipped: `core.hooksPath is set (${hp})` };
  const r = runGit(repoRoot, ["rev-parse", "--git-path", "hooks"]);
  const dir = resolve(repoRoot, r);
  mkdirSync(dir, { recursive: true });
  const installed: string[] = [], chained: string[] = [];
  for (const name of HOOKS) {
    const p = join(dir, name);
    if (existsSync(p) && !readFileSync(p, "utf8").includes(MANAGED_MARK)) {
      let dest = `${p}.estack-prev`;
      for (let n = 2; existsSync(dest); n++) dest = `${p}.estack-prev.${n}`;
      renameSync(p, dest);
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
  const top = runBounded(e, cwd, "git", ["rev-parse", "--show-toplevel"], HOOK_GIT_TIMEOUT_MS);
  if (top.code !== 0) throw new EngineError("NOT_A_REPO", `not a git repository: ${cwd}`);
  const toplevel = top.stdout.trim();
  const staged = runBounded(e, toplevel, "git", ["diff", "--cached", "--name-only", "-z"], HOOK_GIT_TIMEOUT_MS);
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
    const { task: t, verifySettled } = pushReadiness(e, b);
    if (verifySettled) continue;
    if (consumeOverride(e, "git_push", `pre-push:${b}`) !== null) continue;
    return t ? `branch ${b} has no verify evidence (task #${t.id})` : `no estack task for branch ${b}`;
  }
  return null;
}
