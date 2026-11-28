import type { Engine } from "./engine";
import type { ExecResult } from "./exec";
import { createWorktree, ensureWorktreeExclude, removeWorktree, runWorktreeSetup, slug } from "./worktree";
import {
  EngineError, STEP_EVIDENCE, actorId,
  type Actor, type Evidence, type EvidenceKind, type Step, type Task,
} from "./types";

export type EvidenceInput =
  | { kind: "note"; text: string } | { kind: "commit"; sha: string } | { kind: "pr"; url: string }
  | { kind: "review"; verdict: "approve" | "changes"; findings: string } | { kind: "merged" };
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

export interface StartResult extends TaskView { worktree_path?: string; setup?: { ok: boolean; output_tail: string } }

/** The step list of a worker task: the type's steps with `pr` replaced by `merge`. */
const workerSteps = (steps: string[]): string[] => steps.map((s) => (s === "pr" ? "merge" : s));

function insertSteps(e: Engine, id: number, steps: string[]): void {
  steps.forEach((name, i) =>
    e.db.prepare("INSERT INTO steps (task_id, name, ordinal, status) VALUES (?, ?, ?, 'pending')").run(id, name, i));
}

function bind(e: Engine, id: number, actor: Actor): void {
  e.db.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, actor.session_id, actor.agent_id ?? null, actor.agent_id ? "worker" : "cto", iso(e));
}

/** Bind an agent to an open task the first time it touches it; a bare session and a repeat are no-ops. */
export function bindWorker(e: Engine, task_id: number, actor: Actor): void {
  if (!actor.agent_id) return;
  const open = e.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'open'").get(task_id);
  if (!open) return;
  const dup = e.db.prepare("SELECT 1 FROM task_bindings WHERE task_id = ? AND session_id = ? AND agent_id = ?")
    .get(task_id, actor.session_id, actor.agent_id);
  if (dup) return;
  e.db.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (?, ?, ?, 'worker', ?)")
    .run(task_id, actor.session_id, actor.agent_id, iso(e));
}

/** True when the session is a task's CTO: bound with role cto to the task itself or to its parent. */
export function ownsTask(e: Engine, session_id: string, task_id: number): boolean {
  return e.db.prepare(
    `SELECT 1 FROM task_bindings b WHERE b.role = 'cto' AND b.session_id = ?
       AND b.task_id IN (?, (SELECT parent_id FROM tasks WHERE id = ?)) LIMIT 1`,
  ).get(session_id, task_id, task_id) !== undefined;
}

function insertAreas(e: Engine, id: number, area: string[] | undefined): void {
  for (const path of area ?? []) e.db.prepare("INSERT OR IGNORE INTO task_areas (task_id, path) VALUES (?, ?)").run(id, path);
}

/** The commit a new feature branches from: origin/main (after a bounded fetch) when origin exists, else local main. */
function featureBase(e: Engine, checkout: string): { ref: string; sha: string } {
  const remote = runBounded(e, checkout, "git", ["remote", "get-url", "origin"]);
  if (remote.code === 0) {
    // A failed or timed-out fetch is ignored: the last known origin/main is used.
    e.exec.run("git", ["fetch", "origin", "main"], { cwd: checkout, timeoutMs: HOOK_FETCH_TIMEOUT_MS });
    const o = runBounded(e, checkout, "git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]);
    if (o.code === 0) return { ref: "origin/main", sha: o.stdout.trim() };
  }
  const m = runBounded(e, checkout, "git", ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]);
  if (m.code !== 0) throw new EngineError("POLICY_INVALID", "no main branch to start a feature from");
  return { ref: "main", sha: m.stdout.trim() };
}

const HOOK_FETCH_TIMEOUT_MS = 20_000;

export function startTask(e: Engine, input: {
  title?: string; type?: string; goal?: string; done_check?: string; actor: Actor; cwd?: string; branch?: string;
  worktree?: boolean; parent_task_id?: number; area?: string[]; group?: string; task_id?: number;
}): StartResult {
  // A planned task is promoted in place: its stored title, type, goal and parent win over the call's.
  let planned: Task | undefined;
  if (input.task_id !== undefined) {
    planned = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.task_id) as unknown as Task | undefined;
    if (!planned) throw new EngineError("NO_TASK", `no task with id ${input.task_id}`);
    if (planned.status !== "planned") throw new EngineError("TASK_CLOSED", `task ${planned.id} is ${planned.status}, not planned`);
  }
  const field = (name: "title" | "type" | "goal" | "done_check"): string => {
    const v = planned ? planned[name] : input[name];
    if (v === undefined) throw new EngineError("POLICY_INVALID", `${name} is required unless task_id names a planned task`);
    return v;
  };
  const title = field("title");
  const type = field("type");
  const goal = field("goal");
  const done_check = field("done_check");
  // A planned row's parent and group are its own: the call's values are ignored so behaviour matches stored data.
  const parentId = planned ? planned.parent_id : input.parent_task_id ?? null;
  const group = planned ? planned.task_group : input.group ?? null;
  const typeSteps = e.policy.task_types[type];
  if (!typeSteps) throw new EngineError("POLICY_INVALID", `unknown task type "${type}"`);
  if (input.branch?.startsWith("-")) throw new EngineError("POLICY_INVALID", `invalid branch name: ${input.branch}`);
  let parent: Task | null = null;
  if (parentId !== null && input.worktree) {
    parent = (e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId) as unknown as Task | undefined) ?? null;
    if (!parent) throw new EngineError("NO_TASK", `no task with id ${parentId}`);
    if (parent.status !== "open") throw new EngineError("TASK_CLOSED", `parent task ${parent.id} is ${parent.status}`);
  }
  // The task's worktree is the top level of the caller's checkout, so checks run where the work happens.
  const top = runBounded(e, input.cwd ?? e.cwd, "git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new EngineError("NOT_A_REPO", `not a git repository: ${input.cwd ?? e.cwd}`);
  const checkout = top.stdout.trim();
  const by = actorId(input.actor);
  const now = iso(e);

  if (!input.worktree) {
    const branch = input.branch ?? runBounded(e, checkout, "git", ["branch", "--show-current"]).stdout.trim();
    if (input.branch === undefined && !branch) {
      throw new EngineError("POLICY_INVALID", `${checkout} is not on a branch (detached HEAD): pass a branch`);
    }
    const head = runBounded(e, checkout, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    if (!branch || head.code !== 0) throw new EngineError("POLICY_INVALID", `no such branch: "${branch}"`);
    const base_sha = head.stdout.trim();
    return tx(e, () => {
      let id: number;
      if (planned) {
        id = planned.id;
        e.db.prepare("UPDATE tasks SET status = 'open', branch = ?, cwd = ?, base_sha = ? WHERE id = ?").run(branch, checkout, base_sha, id);
      } else {
        id = Number(e.db.prepare(
          "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at, parent_id, task_group) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
        ).run(title, type, goal, done_check, branch, checkout, base_sha, by, now, parentId, group).lastInsertRowid);
        insertAreas(e, id, input.area);
      }
      insertSteps(e, id, typeSteps);
      bind(e, id, input.actor);
      logEvent(e, input.actor, "task_started", id, { type, title, branch });
      return view(e, id);
    });
  }

  // Engine-made worktree. A worker (with a parent) branches from the parent's branch head, a feature from main.
  const from = parent
    ? (() => {
        const h = runBounded(e, checkout, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${parent.branch}^{commit}`]);
        if (h.code !== 0) throw new EngineError("POLICY_INVALID", `no such branch: "${parent.branch}"`);
        return { ref: parent.branch, sha: h.stdout.trim() };
      })()
    : featureBase(e, checkout);
  // Insert first (the id names the branch and folder), then build the worktree outside any transaction.
  // Until the final transaction the row is not open and has no cwd, so no commit gate sees a half-made task.
  let id: number;
  if (planned) {
    id = planned.id;
  } else {
    id = Number(e.db.prepare(
      "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at, parent_id, task_group) VALUES (?, ?, ?, ?, 'cancelled', '', '', ?, ?, ?, ?, ?)",
    ).run(title, type, goal, done_check, from.sha, by, now, parentId, group).lastInsertRowid);
  }
  const name = `${id}-${slug(title)}`;
  const branch = `${parent ? "task" : "feat"}/${name}`;
  try {
    // The start point is the resolved sha, so the new branch tracks no upstream.
    const path = createWorktree(e, { under: checkout, name, branch, base: from.sha });
    ensureWorktreeExclude(e);
    logEvent(e, input.actor, "worktree_created", id, { path, branch, base: from.ref });
    const setup = runWorktreeSetup(e, path);
    if (setup && !setup.ok) logEvent(e, input.actor, "worktree_setup_failed", id, { output_tail: setup.output_tail });
    const base_sha = runBounded(e, path, "git", ["rev-parse", "HEAD"]).stdout.trim() || from.sha;
    return tx(e, () => {
      e.db.prepare("UPDATE tasks SET status = 'open', cwd = ?, branch = ?, base_sha = ? WHERE id = ?").run(path, branch, base_sha, id);
      if (!planned) insertAreas(e, id, input.area);
      insertSteps(e, id, parent ? workerSteps(typeSteps) : typeSteps);
      bind(e, id, input.actor);
      logEvent(e, input.actor, "task_started", id, { type, title, branch });
      return { ...view(e, id), worktree_path: path, ...(setup ? { setup } : {}) };
    });
  } catch (x) {
    // A new task stays cancelled; a planned one stays planned. No open task remains. A worktree already made is kept.
    e.db.prepare("UPDATE tasks SET status = ?, cwd = '', branch = '' WHERE id = ?").run(planned ? "planned" : "cancelled", id);
    logEvent(e, input.actor, "worktree_failed", id, { error: x instanceof Error ? x.message : String(x) });
    throw x;
  }
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
    case "merged": {
      const parent = v.task.parent_id === null ? undefined
        : e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(v.task.parent_id) as unknown as Task | undefined;
      if (!parent) bad(`task #${v.task.id} has no parent feature, so there is nothing to merge into`);
      const head = runBounded(e, parent.cwd, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${v.task.branch}^{commit}`]);
      if (head.code !== 0) bad(`no such branch: ${v.task.branch}`);
      const sha = head.stdout.trim();
      if (runBounded(e, parent.cwd, "git", ["merge-base", "--is-ancestor", sha, `refs/heads/${parent.branch}`]).code !== 0) {
        bad(`${v.task.branch} is not merged into ${parent.branch} yet; merge it there first (git -C ${parent.cwd} merge --no-ff ${v.task.branch})`);
      }
      return { payload: { head: sha, into: parent.branch } };
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
  if (input.step === "merge") {
    // The worker is merged: its worktree goes (kept if dirty). The step is already recorded, so a failure here does not undo it.
    try { removeWorktree(e, v.task); } catch { /* a git timeout leaves the worktree; the step stands */ }
    logEvent(e, input.actor, "task_merged", v.task.id, { into: payload.into });
  }
  return result;
}
