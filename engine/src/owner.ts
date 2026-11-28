import { allowEdit, keptWorktrees, releaseClaim, releaseClaims, releaseOnClose, releaseTaskClaims, type KeptWorktree } from "./claims";
import { acceptOverlap } from "./plan";
import type { Engine } from "./engine";
import { getTask, logEvent, tx, type TaskView } from "./tasks";
import { EngineError, type Actor, type Task } from "./types";
import { WORKTREES_DIR, removeWorktree } from "./worktree";

const OWNER: Actor = { session_id: "owner" };

/** Owner-only actions must come from a person at a terminal, not from inside Claude Code. */
export function assertOwner(env: NodeJS.ProcessEnv): void {
  if (env.CLAUDECODE === "1") {
    throw new EngineError("OWNER_ONLY", "this action is owner-only: run it from a normal terminal, not inside Claude Code");
  }
}

function needReason(reason: string): void {
  if (!reason || !reason.trim()) throw new EngineError("BAD_EVIDENCE", "a reason is required");
}

export function skipStep(e: Engine, input: { task_id: number; step: string; reason: string }, env: NodeJS.ProcessEnv): TaskView {
  assertOwner(env);
  needReason(input.reason);
  return tx(e, () => {
    const v = getTask(e, input.task_id);
    if (v.task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${v.task.id} is ${v.task.status}`);
    if (!v.next || v.next.name !== input.step) {
      throw new EngineError("OUT_OF_ORDER", `step "${input.step}" is not next; the next step is "${v.next?.name}"`);
    }
    e.db.prepare("UPDATE steps SET status = 'skipped' WHERE task_id = ? AND name = ?").run(input.task_id, input.step);
    const left = e.db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id = ? AND status NOT IN ('done','skipped')")
      .get(input.task_id) as { c: number };
    const closed = left.c === 0;
    if (closed) e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(input.task_id);
    logEvent(e, OWNER, "step_skipped", input.task_id, { step: input.step, reason: input.reason, closed });
    if (closed) releaseOnClose(e, input.task_id, OWNER);
    return getTask(e, input.task_id);
  });
}

export interface CancelResult extends TaskView { cancelled: number[]; kept_worktrees: KeptWorktree[] }

/**
 * Owner: cancel a planned, starting or open task, and with it every planned, starting or open task under it (a feature's
 * workers), in one transaction that also releases their claims. Then the worktrees of the cancelled open tasks go,
 * workers first, through removeWorktree: one with uncommitted work is kept and reported, and an unmerged branch stays.
 */
export function cancelTask(e: Engine, input: { task_id: number; reason: string }, env: NodeJS.ProcessEnv): CancelResult {
  assertOwner(env);
  needReason(input.reason);
  const { ids, trees } = tx(e, () => {
    const v = getTask(e, input.task_id);
    // The owner can also cancel a planned or starting task, whose CTO session may be gone.
    if (!["open", "planned", "starting"].includes(v.task.status)) throw new EngineError("TASK_CLOSED", `task ${v.task.id} is ${v.task.status}`);
    const children = e.db.prepare("SELECT * FROM tasks WHERE parent_id = ? AND status IN ('open','planned','starting') ORDER BY id")
      .all(input.task_id) as unknown as Task[];
    const all = [v.task, ...children];
    for (const t of all) {
      const r = e.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status = ?").run(t.id, t.status);
      if (r.changes !== 1) throw new EngineError("TASK_CLOSED", `task ${t.id} changed while it was being cancelled`);
      logEvent(e, OWNER, "task_cancelled", t.id, t === v.task ? { reason: input.reason } : { reason: input.reason, feature: v.task.id });
    }
    // Claims go once every task is cancelled, so no file is handed to a task this same cancel closes.
    for (const t of all) releaseClaims(e, t, OWNER, t === v.task ? undefined : `feature #${v.task.id} cancelled`);
    // Only an open task's cwd is its own worktree: a planned or starting one still points at its feature's.
    const trees = [...children, v.task].filter((t) => t.status === "open" && t.cwd.includes(`/${WORKTREES_DIR}/`));
    return { ids: all.map((t) => t.id), trees };
  });
  for (const t of trees) {
    try { removeWorktree(e, t); } catch (x) {
      logEvent(e, { session_id: "engine" }, "worktree_kept", t.id, { path: t.cwd, reason: x instanceof Error ? x.message : String(x) });
    }
  }
  return { ...getTask(e, input.task_id), cancelled: ids, kept_worktrees: keptWorktrees(e).filter((k) => ids.includes(k.task_id)) };
}

export function recordOverride(e: Engine, input: { action: string; reason: string; task_id?: number }, env: NodeJS.ProcessEnv): void {
  assertOwner(env);
  needReason(input.reason);
  const known = [...new Set([...e.policy.actions.ask, ...Object.keys(e.policy.patterns)])].sort();
  if (!known.includes(input.action)) {
    throw new EngineError("POLICY_INVALID", `unknown action ${input.action}; one of: ${known.join(", ")}`);
  }
  tx(e, () => {
    if (input.task_id !== undefined) getTask(e, input.task_id);
    e.db.prepare("INSERT INTO approvals (task_id, action, command, decision, by, at) VALUES (?, ?, ?, 'override', ?, ?)")
      .run(input.task_id ?? null, input.action, "", "owner", e.now().toISOString());
    logEvent(e, OWNER, "override", input.task_id ?? null, { action: input.action, reason: input.reason });
  });
}

/** Owner: let a task edit a file another task holds. */
export function ownerAllowEdit(e: Engine, input: { task_id: number; path: string; reason: string }, env: NodeJS.ProcessEnv): void {
  assertOwner(env);
  allowEdit(e, { ...input, actor: OWNER, owner: true });
}

/** Owner: accept an overlap between two tasks, across CTOs. */
export function ownerAcceptOverlap(e: Engine, input: { a: number; b: number; reason: string }, env: NodeJS.ProcessEnv): void {
  assertOwner(env);
  needReason(input.reason);
  acceptOverlap(e, { ...input, by: "owner", owner: true, actor: OWNER });
}

/** Owner: free a stale hold on a file. */
export function ownerRelease(e: Engine, input: { path: string; reason: string }, env: NodeJS.ProcessEnv): void {
  assertOwner(env);
  releaseClaim(e, input.path, input.reason);
}

/** Owner: free every claim of a task nobody will finish. Returns how many were released. */
export function ownerReleaseTask(e: Engine, input: { task_id: number; reason: string }, env: NodeJS.ProcessEnv): number {
  assertOwner(env);
  return releaseTaskClaims(e, input.task_id, input.reason);
}
