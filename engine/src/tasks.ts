import type { Engine } from "./engine";
import type { ExecResult } from "./exec";
import {
  EngineError, STEP_EVIDENCE, actorId,
  type Actor, type Evidence, type EvidenceKind, type Step, type Task,
} from "./types";

export type EvidenceInput =
  | { kind: "note"; text: string } | { kind: "commit"; sha: string } | { kind: "pr"; url: string }
  | { kind: "review"; verdict: "approve" | "changes"; findings: string };
export interface TaskView { task: Task; steps: Step[]; next: Step | null; evidence: Evidence[] }

const iso = (e: Engine) => e.now().toISOString();

/** Run fn in one transaction. */
export function tx<T>(e: Engine, fn: () => T): T {
  e.db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    e.db.exec("COMMIT");
    return r;
  } catch (err) {
    e.db.exec("ROLLBACK");
    throw err;
  }
}

export function logEvent(e: Engine, actor: Actor, kind: string, task_id: number | null, payload: unknown): void {
  e.db.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES (?, ?, ?, ?, ?)")
    .run(iso(e), actorId(actor), kind, task_id, JSON.stringify(payload));
}

function view(e: Engine, id: number): TaskView {
  const task = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task | undefined;
  if (!task) throw new EngineError("NO_TASK", `no task with id ${id}`);
  const steps = e.db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal").all(id) as unknown as Step[];
  const rows = e.db.prepare("SELECT * FROM evidence WHERE task_id = ? ORDER BY id").all(id) as unknown as
    (Omit<Evidence, "ok" | "payload"> & { ok: number; payload_json: string })[];
  const evidence = rows.map(({ payload_json, ok, ...r }) => ({ ...r, ok: ok === 1, payload: JSON.parse(payload_json) })) as Evidence[];
  const next = steps.find((s) => s.status !== "done" && s.status !== "skipped") ?? null;
  return { task, steps, next, evidence };
}

export function getTask(e: Engine, id: number): TaskView {
  return view(e, id);
}

export function listOpen(e: Engine): TaskView[] {
  const ids = e.db.prepare("SELECT id FROM tasks WHERE status = 'open' ORDER BY id").all() as { id: number }[];
  return ids.map((r) => view(e, r.id));
}

/** Every git/gh call the engine makes to check state is bounded. */
export const EVIDENCE_TIMEOUT_MS = 30_000;

/** Run git/gh with the evidence timeout; a timeout is BAD_EVIDENCE. */
/** Git calls made from Claude Code hooks and git hooks must finish well inside the 10 s hook timeout. */
export const HOOK_GIT_TIMEOUT_MS = 5_000;

export function runBounded(e: Engine, cwd: string, file: string, args: string[], timeoutMs = EVIDENCE_TIMEOUT_MS): ExecResult {
  const r = e.exec.run(file, args, { cwd, timeoutMs });
  if (r.timedOut) bad("gh/git timed out");
  return r;
}

/**
 * The one push-readiness rule shared by the Bash gate and the pre-push hook: the newest open or done
 * task on `branch`, and whether its verify step is settled (done or skipped).
 */
export function pushReadiness(e: Engine, branch: string): { task: Task | null; verifySettled: boolean } {
  const task = (e.db.prepare("SELECT * FROM tasks WHERE branch = ? AND status IN ('open','done') ORDER BY id DESC LIMIT 1")
    .get(branch) as unknown as Task | undefined) ?? null;
  if (!task) return { task: null, verifySettled: false };
  const verify = e.db.prepare("SELECT status FROM steps WHERE task_id = ? AND name = 'verify'").get(task.id) as { status: string } | undefined;
  return { task, verifySettled: verify?.status === "done" || verify?.status === "skipped" };
}

export function startTask(e: Engine, input: {
  title: string; type: string; goal: string; done_check: string; actor: Actor; cwd?: string; branch?: string;
}): TaskView {
  const steps = e.policy.task_types[input.type];
  if (!steps) throw new EngineError("POLICY_INVALID", `unknown task type "${input.type}"`);
  if (input.branch?.startsWith("-")) throw new EngineError("POLICY_INVALID", `invalid branch name: ${input.branch}`);
  // The task's worktree is the top level of the caller's checkout, so checks run where the work happens.
  const top = runBounded(e, input.cwd ?? e.cwd, "git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new EngineError("NOT_A_REPO", `not a git repository: ${input.cwd ?? e.cwd}`);
  const cwd = top.stdout.trim();
  const branch = input.branch ?? runBounded(e, cwd, "git", ["branch", "--show-current"]).stdout.trim();
  if (input.branch === undefined && !branch) {
    throw new EngineError("POLICY_INVALID", `${cwd} is not on a branch (detached HEAD): pass a branch`);
  }
  const head = runBounded(e, cwd, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!branch || head.code !== 0) throw new EngineError("POLICY_INVALID", `no such branch: "${branch}"`);
  const base_sha = head.stdout.trim();
  const now = iso(e);
  const by = actorId(input.actor);
  return tx(e, () => {
    const r = e.db.prepare(
      "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
    ).run(input.title, input.type, input.goal, input.done_check, branch, cwd, base_sha, by, now);
    const id = Number(r.lastInsertRowid);
    steps.forEach((name, i) =>
      e.db.prepare("INSERT INTO steps (task_id, name, ordinal, status) VALUES (?, ?, ?, 'pending')").run(id, name, i));
    e.db.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.actor.session_id, input.actor.agent_id ?? null, input.actor.agent_id ? "worker" : "cto", now);
    logEvent(e, input.actor, "task_started", id, { type: input.type, title: input.title, branch });
    return view(e, id);
  });
}

export function insertEvidence(e: Engine, task_id: number, step: string, kind: EvidenceKind, ok: boolean,
  payload: Record<string, unknown>, actor: Actor): void {
  e.db.prepare(
    "INSERT INTO evidence (task_id, step, kind, ok, payload_json, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(task_id, step, kind, ok ? 1 : 0, JSON.stringify(payload), actorId(actor), iso(e));
}

/** Mark the step done; close the task if it was the last one. Returns whether the task closed. */
export function finishStep(e: Engine, task_id: number, step: string): boolean {
  e.db.prepare("UPDATE steps SET status = 'done', done_at = ? WHERE task_id = ? AND name = ?").run(iso(e), task_id, step);
  const left = e.db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id = ? AND status NOT IN ('done','skipped')")
    .get(task_id) as { c: number };
  if (left.c > 0) return false;
  e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task_id);
  return true;
}

function bad(message: string): never {
  throw new EngineError("BAD_EVIDENCE", message);
}

function assertNext(v: TaskView, step: string): void {
  if (v.task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${v.task.id} is ${v.task.status}`);
  if (!v.next || v.next.name !== step) {
    throw new EngineError("OUT_OF_ORDER", `step "${step}" is not next; the next step is "${v.next?.name}"`);
  }
}

interface Checked { payload: Record<string, unknown>; rejected?: string }

/**
 * Check the evidence (may spawn git/gh, so it runs outside any transaction) and return the payload to store.
 * Invalid evidence throws; evidence that is valid but does not pass the step (a "changes" review) is returned
 * with `rejected` so it is recorded as failed.
 */
function checkEvidence(e: Engine, v: TaskView, step: string, ev: EvidenceInput, actor: Actor): Checked {
  const run = (file: string, args: string[]) => runBounded(e, v.task.cwd, file, args);
  switch (ev.kind) {
    case "note":
      if (!ev.text || !ev.text.trim()) bad("a note must not be blank");
      if (step === "reuse_check" && e.policy.code_map.enabled) {
        const rows = e.db.prepare(
          "SELECT id FROM code_queries WHERE task_id = ? AND recorded_by = ? AND ok = 1 AND auto = 0 AND tool IN ('find_existing','context_for') ORDER BY id",
        ).all(v.task.id, actorId(actor)) as { id: number }[];
        if (rows.length === 0) {
          bad(`reuse_check needs a find_existing or context_for search you ran yourself for task #${v.task.id}; the automatic context from start_task and other agents' searches don't count`);
        }
        return { payload: { text: ev.text, queries: rows.map((r) => r.id) } };
      }
      return { payload: { text: ev.text } };
    case "commit": {
      if (!/^[0-9a-fA-F]{4,64}$/.test(ev.sha ?? "")) bad(`not a valid commit sha: ${ev.sha}`);
      const found = run("git", ["rev-parse", "--verify", "--quiet", `${ev.sha}^{commit}`]);
      if (found.code !== 0) bad(`commit ${ev.sha} does not exist`);
      const sha = found.stdout.trim();
      if (run("git", ["merge-base", "--is-ancestor", sha, `refs/heads/${v.task.branch}`]).code !== 0) {
        bad(`commit ${ev.sha} is not on the task branch ${v.task.branch}`);
      }
      // Only work made after the task started counts: the commit must not already be in the base.
      const old = run("git", ["merge-base", "--is-ancestor", sha, v.task.base_sha]).code;
      if (old === 0) bad(`commit predates the task: ${ev.sha} is already in its base ${v.task.base_sha}`);
      if (old !== 1) bad(`git could not compare commit ${ev.sha} with the task's base ${v.task.base_sha}`);
      return { payload: { sha } };
    }
    case "pr": {
      if (!/^https:\/\/\S+\/pull\/\d+$/.test(ev.url ?? "")) bad(`not a pull request url: ${ev.url}`);
      const r = run("gh", ["pr", "view", ev.url, "--json", "headRefName"]);
      if (r.code !== 0) bad(`gh could not find the pull request ${ev.url}`);
      let head: unknown;
      try { head = (JSON.parse(r.stdout) as { headRefName?: unknown }).headRefName; } catch { head = undefined; }
      if (typeof head !== "string") bad(`gh returned no head branch for ${ev.url}`);
      if (head !== v.task.branch) bad(`PR is for branch ${head}, task is on ${v.task.branch}`);
      return { payload: { url: ev.url, head_ref: head } };
    }
    case "review": {
      if (actor.session_id === "unknown" && actor.agent_id === undefined) bad("review needs a reviewer identity");
      const author = v.evidence.filter((x) => x.kind === "commit" && x.ok).at(-1)?.recorded_by;
      if (author === actorId(actor)) bad("a review must come from a different agent than the author");
      const payload = { verdict: ev.verdict, findings: ev.findings };
      if (ev.verdict !== "approve") return { payload, rejected: "changes requested" };
      return { payload };
    }
    default:
      return bad(`unsupported evidence kind for step ${step}`);
  }
}

export function completeStep(e: Engine, input: { task_id: number; step: string; evidence: EvidenceInput; actor: Actor }): TaskView {
  const v = view(e, input.task_id);
  assertNext(v, input.step);
  const required = STEP_EVIDENCE[input.step];
  if (required === "command") {
    bad(`step "${input.step}" needs a command result; use run_check, not hand-written evidence`);
  }
  if (input.evidence.kind !== required) bad(`step "${input.step}" needs ${required} evidence, got ${input.evidence.kind}`);
  // Spawning git/gh happens before BEGIN IMMEDIATE so a slow check never holds the write lock.
  const { payload, rejected } = checkEvidence(e, v, input.step, input.evidence, input.actor);
  const result = tx(e, () => {
    // Re-check under the write lock: the task may have moved while the evidence was checked.
    assertNext(view(e, input.task_id), input.step);
    insertEvidence(e, v.task.id, input.step, required, !rejected, payload, input.actor);
    if (rejected) {
      logEvent(e, input.actor, "evidence", v.task.id, { step: input.step, kind: required, ok: false });
      return null;
    }
    const closed = finishStep(e, v.task.id, input.step);
    logEvent(e, input.actor, "step_done", v.task.id, { step: input.step, kind: required, closed });
    return view(e, v.task.id);
  });
  if (!result) return bad(rejected ?? "evidence rejected");
  return result;
}
