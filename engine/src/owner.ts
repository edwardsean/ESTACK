import { allowEdit, releaseClaim, releaseClaims } from "./claims";
import { acceptOverlap } from "./plan";
import type { Engine } from "./engine";
import { getTask, logEvent, tx, type TaskView } from "./tasks";
import { EngineError, type Actor } from "./types";

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
    return getTask(e, input.task_id);
  });
}

export function cancelTask(e: Engine, input: { task_id: number; reason: string }, env: NodeJS.ProcessEnv): TaskView {
  assertOwner(env);
  needReason(input.reason);
  return tx(e, () => {
    const v = getTask(e, input.task_id);
    // The owner can also cancel a planned or starting task, whose CTO session may be gone.
    if (!["open", "planned", "starting"].includes(v.task.status)) throw new EngineError("TASK_CLOSED", `task ${v.task.id} is ${v.task.status}`);
    const r = e.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status IN ('open','planned','starting')").run(input.task_id);
    if (r.changes !== 1) throw new EngineError("TASK_CLOSED", `task ${v.task.id} changed while it was being cancelled`);
    logEvent(e, OWNER, "task_cancelled", input.task_id, { reason: input.reason });
    releaseClaims(e, v.task, OWNER);
    return getTask(e, input.task_id);
  });
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
