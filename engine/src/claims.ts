import { existsSync } from "node:fs";
import type { Engine } from "./engine";
import { isExempt, pathMatches } from "./match";
import { mergedIntoMain } from "./plan";
import { EVIDENCE_TIMEOUT_MS, HOOK_FETCH_TIMEOUT_MS, HOOK_GIT_TIMEOUT_MS, logEvent, tx } from "./tasks";
import { EngineError, type Actor, type Task } from "./types";
import { WORKTREES_DIR, removeWorktree } from "./worktree";

export type EditVerdict = { ok: true } | { ok: false; holder: Task; claim_id: number };

const ENGINE: Actor = { session_id: "engine" };
const iso = (e: Engine) => e.now().toISOString();

/** Files no task ever holds: `exempt_paths` (edited with no task) and `claims.exempt` (lockfiles and the like). */
export function isClaimExempt(e: Engine, path: string): boolean {
  return isExempt(path, e.policy) || e.policy.claims.exempt.some((p) => pathMatches(path, p));
}

/** The task holding a file, if any. */
export function holderOf(e: Engine, path: string): { claim_id: number; task: Task } | null {
  const row = e.db.prepare(
    `SELECT c.id AS claim_id, t.* FROM claims c JOIN tasks t ON t.id = c.task_id
     WHERE c.kind = 'file' AND c.target = ? AND c.status = 'active'`,
  ).get(path) as unknown as (Task & { claim_id: number }) | undefined;
  if (!row) return null;
  const { claim_id, ...task } = row;
  return { claim_id, task: task as Task };
}

/** The refusal an agent sees for a held file. */
export function heldMessage(path: string, holder: Task): string {
  return `${path} is held by task #${holder.id} (goal: ${holder.goal}); report to your CTO, which can check it with claim_status and allow it with allow_edit.`;
}

/** True when the task has been granted an edit on the path. */
export function hasGrant(e: Engine, task_id: number, path: string): boolean {
  return e.db.prepare("SELECT 1 FROM claim_grants WHERE task_id = ? AND path = ? LIMIT 1").get(task_id, path) !== undefined;
}

/** The holder never blocks itself, a task in the same checkout (one working copy cannot clash), its parent or child, a task in its group under the same feature, or a task with a grant. */
function mayEdit(e: Engine, task: Task, holder: Task, path: string): boolean {
  return holder.id === task.id || holder.cwd === task.cwd || holder.id === task.parent_id || holder.parent_id === task.id
    || (task.task_group !== null && holder.task_group === task.task_group && holder.parent_id === task.parent_id)
    || hasGrant(e, task.id, path);
}

/** Take a free file for the task (unless `take` is false), or say who holds it. A lost insert race (UNIQUE) re-reads the holder. */
export function checkEdit(e: Engine, task: Task, path: string, actor: Actor = ENGINE, take = true): EditVerdict {
  if (isClaimExempt(e, path)) return { ok: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = holderOf(e, path);
    if (held) {
      if (mayEdit(e, task, held.task, path)) return { ok: true };
      logEvent(e, actor, "claim_denied", task.id, { path, holder: held.task.id, claim_id: held.claim_id });
      return { ok: false, holder: held.task, claim_id: held.claim_id };
    }
    if (!take) return { ok: true };
    try {
      tx(e, () => {
        const r = e.db.prepare("INSERT INTO claims (task_id, kind, target, status, at) VALUES (?, 'file', ?, 'active', ?)")
          .run(task.id, path, iso(e));
        logEvent(e, actor, "claim_taken", task.id, { path, claim_id: Number(r.lastInsertRowid) });
      });
      return { ok: true };
    } catch (x) {
      if (!(x instanceof Error) || !/UNIQUE constraint failed/.test(x.message)) throw x;
      // Another task took it just now: read the holder again.
    }
  }
  // Three lost races in a row: the holder keeps changing, so report whoever holds it now.
  const held = holderOf(e, path);
  if (held && !mayEdit(e, task, held.task, path)) return { ok: false, holder: held.task, claim_id: held.claim_id };
  return { ok: true };
}

/** A merged worker's claims become its feature's. */
export function passClaims(e: Engine, from: Task, to: Task, actor: Actor = ENGINE): void {
  const rows = e.db.prepare("SELECT id, kind, target FROM claims WHERE task_id = ? AND status = 'active' ORDER BY id")
    .all(from.id) as { id: number; kind: string; target: string }[];
  for (const c of rows) {
    e.db.prepare("UPDATE claims SET task_id = ? WHERE id = ?").run(to.id, c.id);
    logEvent(e, actor, "claim_passed", to.id, { claim_id: c.id, kind: c.kind, path: c.target, from: from.id, to: to.id });
  }
}

/**
 * Release every active claim of a task (its feature merged into main, or it was cancelled). A file with a grant for
 * another still-open task goes to the newest such grant's task. Not transactional itself: call it inside `tx`.
 */
export function releaseClaims(e: Engine, task: Task, actor: Actor, reason?: string): void {
  const rows = e.db.prepare("SELECT id, kind, target FROM claims WHERE task_id = ? AND status = 'active' ORDER BY id")
    .all(task.id) as { id: number; kind: string; target: string }[];
  for (const c of rows) {
    e.db.prepare("UPDATE claims SET status = 'released', released_at = ? WHERE id = ?").run(iso(e), c.id);
    logEvent(e, actor, "claim_released", task.id, { claim_id: c.id, kind: c.kind, path: c.target, ...(reason ? { reason } : {}) });
    if (c.kind !== "file") continue;
    const grant = e.db.prepare(
      `SELECT g.id, g.task_id FROM claim_grants g JOIN tasks t ON t.id = g.task_id
       WHERE g.path = ? AND g.task_id != ? AND t.status = 'open' ORDER BY g.id DESC LIMIT 1`,
    ).get(c.target, task.id) as { id: number; task_id: number } | undefined;
    if (!grant) continue;
    const r = e.db.prepare("INSERT INTO claims (task_id, kind, target, status, at) VALUES (?, 'file', ?, 'active', ?)")
      .run(grant.task_id, c.target, iso(e));
    logEvent(e, actor, "claim_taken", grant.task_id, { path: c.target, claim_id: Number(r.lastInsertRowid), from_grant: grant.id });
  }
}

/**
 * Done features known merged into main give up their claims and, when the engine made it, their worktree; a done feature
 * whose pull request was closed unmerged gives up its claims too. Open tasks are left alone until their `pr` step is
 * recorded. Checks merge state with gh/git, so only status and start_task call it, never a per-edit hook. A failing check
 * leaves the feature alone until the next call.
 */
export function syncMerged(e: Engine): void {
  const rows = e.db.prepare(
    `SELECT * FROM tasks WHERE parent_id IS NULL AND status = 'done' AND (
       id IN (SELECT task_id FROM claims WHERE status = 'active') OR cwd LIKE '%/' || ? || '/%') ORDER BY id`,
  ).all(WORKTREES_DIR) as unknown as Task[];
  const todo = rows.map((task) => ({
    task,
    hasClaims: e.db.prepare("SELECT 1 FROM claims WHERE task_id = ? AND status = 'active'").get(task.id) !== undefined,
    hasTree: task.cwd.includes(`/${WORKTREES_DIR}/`) && existsSync(task.cwd),
  })).filter((x) => x.hasClaims || x.hasTree);
  if (todo.length === 0) return;
  const hasOrigin = e.exec.run("git", ["remote", "get-url", "origin"], { cwd: e.cwd, timeoutMs: HOOK_GIT_TIMEOUT_MS }).code === 0;
  // One fetch for the whole pass, ignoring failure.
  if (hasOrigin) e.exec.run("git", ["fetch", "origin", "main"], { cwd: e.cwd, timeoutMs: HOOK_FETCH_TIMEOUT_MS });
  for (const { task, hasClaims, hasTree } of todo) {
    try {
      if (mergedIntoMain(e, task, { fetched: true })) {
        if (hasClaims) tx(e, () => releaseClaims(e, task, ENGINE));
        if (hasTree) removeWorktree(e, task);
      } else if (hasClaims && prClosed(e, task)) {
        tx(e, () => releaseClaims(e, task, ENGINE, "pr closed"));
      }
    } catch (x) {
      // A timed-out or failed gh/git check is tried again next time; anything else is a bug and surfaces.
      if (!(x instanceof EngineError)) throw x;
    }
  }
}

/** True when gh reports the task's pull request CLOSED without merging. */
function prClosed(e: Engine, task: Task): boolean {
  if (!task.branch) return false;
  const pr = e.exec.run("gh", ["pr", "view", task.branch, "--json", "state"], { cwd: e.cwd, timeoutMs: EVIDENCE_TIMEOUT_MS });
  if (pr.code !== 0) return false;
  try { return (JSON.parse(pr.stdout) as { state?: unknown }).state === "CLOSED"; } catch { return false; }
}
