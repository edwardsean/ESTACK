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

/**
 * The worktree for a task: made now, or (only when `reuse` is set, for a planned or stale-claimed task) reused when an
 * earlier start that died or failed after `git worktree add` already made it, intact, at the expected path on the expected
 * branch. Anything else in the way is refused with what to do by hand; nothing is ever forced away.
 */
export function ensureWorktree(e: Engine, input: { under: string; name: string; branch: string; base: string; reuse: boolean }): { path: string; reused: boolean } {
  const path = join(input.under, WORKTREES_DIR, input.name);
  const list = runBounded(e, input.under, "git", ["worktree", "list", "--porcelain"]);
  const blocks = list.code !== 0 ? [] : list.stdout.split("\n\n").map((b) => {
    const lines = b.split("\n");
    const get = (k: string) => lines.find((l) => l === k || l.startsWith(`${k} `));
    return {
      path: get("worktree")?.slice("worktree ".length) ?? "",
      branch: get("branch")?.slice("branch ".length) ?? null,
      locked: get("locked") !== undefined,
      prunable: get("prunable") !== undefined,
    };
  });
  const ref = `refs/heads/${input.branch}`;
  const byHand = `remove it by hand (git worktree remove ${path}, then git branch -d ${input.branch}) and start the task again`;
  const here = blocks.find((b) => b.path === path);
  if (here) {
    if (here.prunable || !existsSync(path)) {
      throw new EngineError("POLICY_INVALID", `${path} is a worktree git lists but whose folder is gone; inspect it with git worktree list, clear it with git worktree prune, and start the task again`);
    }
    if (here.locked) {
      throw new EngineError("POLICY_INVALID", `${path} is a locked worktree (a start that died while checking out); inspect it with git worktree list, release it with git worktree unlock ${path} and remove it, then start the task again`);
    }
    if (here.branch !== ref) throw new EngineError("POLICY_INVALID", `${path} is a worktree on ${here.branch ?? "no branch"}, not ${input.branch}; ${byHand}`);
    if (!input.reuse) throw new EngineError("POLICY_INVALID", `${path} already exists from earlier work that is not this task's; ${byHand}`);
    return { path, reused: true };
  }
  if (existsSync(path)) throw new EngineError("POLICY_INVALID", `${path} already exists and is not the worktree of ${input.branch}; ${byHand}`);
  if (runBounded(e, input.under, "git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0) {
    const holder = blocks.find((b) => b.branch === ref);
    throw new EngineError("POLICY_INVALID", holder
      ? `branch ${input.branch} is checked out in ${holder.path}, not at ${path}; remove that worktree by hand (git worktree remove ${holder.path}) and start the task again`
      : `branch ${input.branch} already exists without its worktree; delete it by hand (git branch -d ${input.branch}) and start the task again`);
  }
  return { path: createWorktree(e, input), reused: false };
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
  const keep = (reason: string) => {
    logEvent(e, ENGINE, "worktree_kept", task.id, { path: task.cwd, reason });
    return "kept" as const;
  };
  if (task.cwd === "") return "missing";
  // Only a worktree the engine made (under <checkout>/.estack/worktrees/) is ever removed.
  if (!task.cwd.includes(`/${WORKTREES_DIR}/`)) return keep("not engine-made");
  if (!existsSync(task.cwd)) return "missing";
  // git status cannot see worktrees nested in this one (the folder is excluded), so look for them directly.
  const list = runBounded(e, e.repo.root, "git", ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return keep("could not list worktrees");
  const nested = list.stdout.split("\n").filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length)).some((p) => p.startsWith(task.cwd + "/"));
  if (nested) return keep("nested worktrees");
  const status = runBounded(e, task.cwd, "git", ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim() !== "") return keep(status.code !== 0 ? "git status failed" : "uncommitted changes");
  const rm = runBounded(e, e.repo.root, "git", ["worktree", "remove", task.cwd]);
  if (rm.code !== 0) return keep(rm.stderr.trim());
  // A worker is merged into its feature, so its branch is judged from the feature's checkout.
  const parent = task.parent_id === null ? undefined
    : e.db.prepare("SELECT cwd FROM tasks WHERE id = ?").get(task.parent_id) as { cwd: string } | undefined;
  const from = parent?.cwd && existsSync(parent.cwd) ? parent.cwd : e.repo.root;
  const br = runBounded(e, from, "git", ["branch", "-d", task.branch]);
  logEvent(e, ENGINE, "worktree_removed", task.id, { path: task.cwd, branch: task.branch, branch_deleted: br.code === 0 });
  return "removed";
}
