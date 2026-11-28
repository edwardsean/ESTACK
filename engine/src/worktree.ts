import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "./engine";
import { appendExclude } from "./graph";
import { logEvent, runBounded } from "./tasks";
import { EngineError, type Task } from "./types";

export const WORKTREES_DIR = ".estack/worktrees";
export const WORKTREE_SETUP_TIMEOUT_MS = 600_000;

const ENGINE = { session_id: "engine" };

/** Title lowercased, runs of non [a-z0-9] to "-", trimmed, at most 40 characters. */
export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

/** Make git ignore the worktrees folder through the shared info/exclude, never a tracked file. */
export function ensureWorktreeExclude(e: Engine): void {
  appendExclude(e, e.repo.root, [`${WORKTREES_DIR}/`]);
}

/** `git worktree add -b <branch> <under>/.estack/worktrees/<name> <base>`; returns the absolute path. */
export function createWorktree(e: Engine, input: { under: string; name: string; branch: string; base: string }): string {
  const path = join(input.under, WORKTREES_DIR, input.name);
  const r = runBounded(e, input.under, "git", ["worktree", "add", "-b", input.branch, path, input.base]);
  if (r.code !== 0) throw new EngineError("NOT_A_REPO", (r.stderr || r.stdout).trim() || "git worktree add failed");
  return path;
}

/** Run the policy's worktree_setup in the new worktree; null when there is none. */
export function runWorktreeSetup(e: Engine, cwd: string): { ok: boolean; output_tail: string } | null {
  const command = e.policy.commands.worktree_setup;
  if (!command) return null;
  const r = e.exec.shell(command, { cwd, timeoutMs: WORKTREE_SETUP_TIMEOUT_MS });
  const tail = (r.stdout + r.stderr).trim().slice(-500);
  return { ok: r.code === 0 && !r.timedOut, output_tail: r.timedOut ? `${tail}\ntimed out`.trim() : tail };
}

/** Remove a task's worktree and branch without force: a dirty worktree is kept, an unmerged branch is kept. */
export function removeWorktree(e: Engine, task: Task): "removed" | "kept" | "missing" {
  if (!task.cwd || !existsSync(task.cwd)) return "missing";
  const status = runBounded(e, task.cwd, "git", ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim() !== "") {
    logEvent(e, ENGINE, "worktree_kept", task.id, { path: task.cwd, reason: status.code !== 0 ? "git status failed" : "uncommitted changes" });
    return "kept";
  }
  const rm = runBounded(e, e.repo.root, "git", ["worktree", "remove", task.cwd]);
  if (rm.code !== 0) {
    logEvent(e, ENGINE, "worktree_kept", task.id, { path: task.cwd, reason: rm.stderr.trim() });
    return "kept";
  }
  const br = runBounded(e, e.repo.root, "git", ["branch", "-d", task.branch]);
  logEvent(e, ENGINE, "worktree_removed", task.id, { path: task.cwd, branch: task.branch, branch_deleted: br.code === 0 });
  return "removed";
}
