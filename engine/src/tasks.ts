import { passClaims, releaseClaims, releaseOnClose, syncMerged } from "./claims";
import { recordMergeConflicts, recordOutcomes } from "./outcomes";
import type { Engine } from "./engine";
import type { ExecResult } from "./exec";
import { areaPath, claimInfo, gateStart, releaseStale } from "./plan";
import { WORKTREE_SETUP_TIMEOUT_MS, ensureWorktree, ensureWorktreeExclude, removeWorktree, runWorktreeSetup, slug } from "./worktree";
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

/**
 * Bind a caller to a task once. One INSERT ... WHERE NOT EXISTS, so the check and the insert are a single atomic
 * statement (safe inside or outside a transaction, which BEGIN IMMEDIATE does not nest). An agent is a worker, a bare session the cto.
 */
export function insertBinding(e: Engine, task_id: number, actor: Actor): void {
  e.db.prepare(
    `INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE NOT EXISTS (SELECT 1 FROM task_bindings WHERE task_id = ?1 AND session_id = ?2 AND agent_id IS ?3)`,
  ).run(task_id, actor.session_id, actor.agent_id ?? null, actor.agent_id ? "worker" : "cto", iso(e));
}

/** Bind an agent to an open worker task (one with a parent) the first time it touches it; anything else is a no-op. */
export function bindWorker(e: Engine, task_id: number, actor: Actor): void {
  if (!actor.agent_id) return;
  const worker = e.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'open' AND parent_id IS NOT NULL").get(task_id);
  if (worker) insertBinding(e, task_id, actor);
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

/**
 * The repository's default branch: the branch origin/HEAD points at when it is set, else local main, else local master.
 * With none of them it is POLICY_INVALID, saying what is missing.
 */
export function defaultBranch(e: Engine, cwd: string): string {
  const head = runBounded(e, cwd, "git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], HOOK_GIT_TIMEOUT_MS);
  const named = head.code === 0 ? /^refs\/remotes\/origin\/([^-].*)$/.exec(head.stdout.trim())?.[1] : undefined;
  if (named) return named;
  for (const name of ["main", "master"]) {
    if (runBounded(e, cwd, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`], HOOK_GIT_TIMEOUT_MS).code === 0) return name;
  }
  throw new EngineError("POLICY_INVALID",
    "no default branch: origin/HEAD is not set and there is no local main or master; set it (git remote set-head origin --auto) or create main");
}

/** The commit a new feature branches from: origin/<default> (after a bounded fetch) when origin has it, else the local default branch. */
function featureBase(e: Engine, checkout: string): { ref: string; sha: string } {
  const name = defaultBranch(e, checkout);
  const remote = runBounded(e, checkout, "git", ["remote", "get-url", "origin"]);
  if (remote.code === 0) {
    // A failed or timed-out fetch is ignored: the last known origin/<default> is used.
    e.exec.run("git", ["fetch", "origin", name], { cwd: checkout, timeoutMs: HOOK_FETCH_TIMEOUT_MS });
    const o = runBounded(e, checkout, "git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}^{commit}`]);
    if (o.code === 0) return { ref: `origin/${name}`, sha: o.stdout.trim() };
  }
  const m = runBounded(e, checkout, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
  if (m.code !== 0) throw new EngineError("POLICY_INVALID", `no ${name} branch to start a feature from`);
  return { ref: name, sha: m.stdout.trim() };
}

export const HOOK_FETCH_TIMEOUT_MS = 20_000;

/** A `starting` row older than this has lost its starter (the setup command's limit plus five minutes). */
export const STALE_CLAIM_MS = WORKTREE_SETUP_TIMEOUT_MS + 300_000;
const alreadyStarting = (id: number) => new EngineError("TASK_CLOSED", `task #${id} is already being started`);

/**
 * Claim a planned task (or one whose earlier claim went stale) for this call. Runs inside the caller's write transaction,
 * so a second caller finds the row taken. Status `starting` opens nothing: every gate still asks for `open`.
 */
function claimPlanned(e: Engine, id: number, actor: Actor): void {
  const row = e.db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | undefined;
  const c = row?.status === "starting" ? claimInfo(e, id) : null;
  if (!row || (row.status !== "planned" && !(c && c.stale && c.from === "planned"))) throw alreadyStarting(id);
  const r = e.db.prepare("UPDATE tasks SET status = 'starting' WHERE id = ? AND status = ?").run(id, row.status);
  if (r.changes !== 1) throw alreadyStarting(id);
  logEvent(e, actor, "task_claimed", id, { from: "planned" });
}

export function startTask(e: Engine, input: {
  title?: string; type?: string; goal?: string; done_check?: string; actor: Actor; cwd?: string; branch?: string;
  worktree?: boolean; parent_task_id?: number; area?: string[]; group?: string; task_id?: number;
}): StartResult {
  releaseStale(e);
  syncMerged(e);
  // A planned task is promoted in place: its stored title, type, goal and parent win over the call's.
  let planned: Task | undefined;
  if (input.task_id !== undefined) {
    planned = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.task_id) as unknown as Task | undefined;
    if (!planned) throw new EngineError("NO_TASK", `no task with id ${input.task_id}`);
    if (planned.status === "starting") {
      const c = claimInfo(e, planned.id);
      if (!(c.stale && c.from === "planned")) throw alreadyStarting(planned.id);
    } else if (planned.status !== "planned") {
      throw new EngineError("TASK_CLOSED", `task ${planned.id} is ${planned.status}, not planned`);
    }
    // Starting a planned task makes the caller its CTO, so only its CTO may.
    if (!ownsTask(e, input.actor.session_id, planned.id)) {
      throw new EngineError("OWNER_ONLY", `task #${planned.id} belongs to another CTO; only the CTO who planned it can start it`);
    }
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
  // A worker (a task with a parent) always gets its own worktree: one forgotten flag must not put it in the caller's checkout.
  if (parentId !== null && input.worktree === false) throw new EngineError("POLICY_INVALID", "a worker task always gets its own worktree");
  const worktree = parentId !== null || input.worktree === true;
  const typeSteps = e.policy.task_types[type];
  if (!typeSteps) throw new EngineError("POLICY_INVALID", `unknown task type "${type}"`);
  if (input.branch?.startsWith("-")) throw new EngineError("POLICY_INVALID", `invalid branch name: ${input.branch}`);
  let parent: Task | null = null;
  let parentRow: Task | null = null;
  if (parentId !== null) {
    parentRow = (e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId) as unknown as Task | undefined) ?? null;
    if (!parentRow) throw new EngineError("NO_TASK", `no task with id ${parentId}`);
    // A worker under a feature makes its caller a CTO of the worker, so only the feature's CTO may start one.
    if (!planned && !ownsTask(e, input.actor.session_id, parentRow.id)) {
      throw new EngineError("OWNER_ONLY", `task #${parentRow.id} belongs to another CTO; only its CTO can start a task under it`);
    }
  }
  if (parentRow && worktree) {
    parent = parentRow;
    if (parent.status !== "open") throw new EngineError("TASK_CLOSED", `parent task ${parent.id} is ${parent.status}`);
  }
  // The task's worktree is the top level of the caller's checkout, so checks run where the work happens.
  const top = runBounded(e, input.cwd ?? e.cwd, "git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new EngineError("NOT_A_REPO", `not a git repository: ${input.cwd ?? e.cwd}`);
  const checkout = top.stdout.trim();
  // Overlaps are checked for a planned task and for any task started with an area; a planned task also waits for its dependencies.
  // A worker's areas are read against its feature's checkout, a feature's against its own, wherever the call came from.
  const areas = (input.area ?? []).map((p) => areaPath(parentRow ? parentRow.cwd : checkout, p));
  const gate = () => {
    if (planned) gateStart(e, input.actor, { planned });
    else if (areas.length > 0) gateStart(e, input.actor, { fresh: { parent_id: parentId, group, areas } });
  };
  gate();
  const by = actorId(input.actor);
  const now = iso(e);

  if (!worktree) {
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
        claimPlanned(e, id, input.actor);
        e.db.prepare("UPDATE tasks SET status = 'open', branch = ?, cwd = ?, base_sha = ? WHERE id = ? AND status = 'starting'").run(branch, checkout, base_sha, id);
      } else {
        gate(); // again under the write lock, so two overlapping starts cannot both pass
        id = Number(e.db.prepare(
          "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at, parent_id, task_group) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
        ).run(title, type, goal, done_check, branch, checkout, base_sha, by, now, parentId, group).lastInsertRowid);
        insertAreas(e, id, areas);
      }
      insertSteps(e, id, typeSteps);
      insertBinding(e, id, input.actor);
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
  // The row is `starting` from here to the final transaction: it opens nothing, but other starts and dependents see it.
  // A planned task is claimed before any git work, so two simultaneous calls cannot both promote it.
  const id = tx(e, () => {
    if (planned) {
      claimPlanned(e, planned.id, input.actor);
      return planned.id;
    }
    gate(); // again under the write lock, so two overlapping starts cannot both pass
    const made = Number(e.db.prepare(
      "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at, parent_id, task_group) VALUES (?, ?, ?, ?, 'starting', '', '', ?, ?, ?, ?, ?)",
    ).run(title, type, goal, done_check, from.sha, by, now, parentId, group).lastInsertRowid);
    insertAreas(e, made, areas);
    logEvent(e, input.actor, "task_claimed", made, { from: "new" });
    return made;
  });
  const name = `${id}-${slug(title)}`;
  const branch = `${parent ? "task" : "feat"}/${name}`;
  try {
    // The start point is the resolved sha, so the new branch tracks no upstream.
    const { path, reused } = ensureWorktree(e, { under: checkout, name, branch, base: from.sha, reuse: planned !== undefined });
    ensureWorktreeExclude(e);
    logEvent(e, input.actor, "worktree_created", id, { path, branch, base: from.ref, ...(reused ? { reused: true } : {}) });
    const setup = runWorktreeSetup(e, path);
    if (setup && !setup.ok) logEvent(e, input.actor, "worktree_setup_failed", id, { output_tail: setup.output_tail });
    const base_sha = runBounded(e, path, "git", ["rev-parse", "HEAD"]).stdout.trim() || from.sha;
    return tx(e, () => {
      const r = e.db.prepare("UPDATE tasks SET status = 'open', cwd = ?, branch = ?, base_sha = ? WHERE id = ? AND status = 'starting'").run(path, branch, base_sha, id);
      if (r.changes !== 1) throw new EngineError("TASK_CLOSED", `task #${id} was released while it was starting`);
      insertSteps(e, id, parent ? workerSteps(typeSteps) : typeSteps);
      insertBinding(e, id, input.actor);
      logEvent(e, input.actor, "task_started", id, { type, title, branch });
      return { ...view(e, id), worktree_path: path, ...(setup ? { setup } : {}) };
    });
  } catch (x) {
    // A new task stays cancelled; a planned one stays planned. No open task remains. A worktree already made is kept.
    // Only the row this call claimed: never a task another process has opened or released in the meantime.
    // A planned task gets its placeholder cwd (the parent's) back, as withdraw_task does.
    e.db.prepare(`UPDATE tasks SET status = ?, cwd = ${planned ? "COALESCE((SELECT cwd FROM tasks p WHERE p.id = tasks.parent_id), '')" : "''"}, branch = '' WHERE id = ? AND status = 'starting'`).run(planned ? "planned" : "cancelled", id);
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

/**
 * Mark the step done; close the task if it was the last one (a task that can never reach main gives up its claims as it
 * closes). Call inside a transaction. Returns whether the task closed.
 */
export function finishStep(e: Engine, task_id: number, step: string, actor: Actor): boolean {
  e.db.prepare("UPDATE steps SET status = 'done', done_at = ? WHERE task_id = ? AND name = ?").run(iso(e), task_id, step);
  const left = e.db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id = ? AND status NOT IN ('done','skipped')")
    .get(task_id) as { c: number };
  if (left.c > 0) return false;
  e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task_id);
  releaseOnClose(e, task_id, actor);
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
      // The implement work must be in the feature too: a branch reset to its fork point would pass the check above.
      const last = v.evidence.filter((x) => x.kind === "commit" && x.ok).at(-1)?.payload.sha;
      if (typeof last === "string" && runBounded(e, parent.cwd, "git", ["merge-base", "--is-ancestor", last, `refs/heads/${parent.branch}`]).code !== 0) {
        bad(`commit ${last} from this task is not in ${parent.branch}; merge ${v.task.branch} there first (git -C ${parent.cwd} merge --no-ff ${v.task.branch})`);
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
    const closed = finishStep(e, v.task.id, input.step, input.actor);
    logEvent(e, input.actor, "step_done", v.task.id, { step: input.step, kind: required, closed });
    if (input.step === "merge" && v.task.parent_id !== null) {
      const feature = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(v.task.parent_id) as unknown as Task;
      // A cancelled or finished feature has no one to hold the files: they are released, not passed.
      if (feature.status === "open") passClaims(e, v.task, feature, input.actor);
      else releaseClaims(e, v.task, input.actor, `feature #${feature.id} is ${feature.status}`);
    }
    return view(e, v.task.id);
  });
  if (!result) return bad(rejected ?? "evidence rejected");
  if (input.step === "merge") {
    // Paths that conflicted in this merge make their grants conflicts, before the clean check below can call them clean.
    const feature = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(v.task.parent_id) as unknown as Task | undefined;
    if (feature && typeof payload.head === "string") recordMergeConflicts(e, v.task, feature, payload.head);
    // The worker is merged: its worktree goes (kept if dirty). The step is already recorded, so a failure here does not undo it.
    try { removeWorktree(e, v.task); } catch (x) {
      logEvent(e, { session_id: "engine" }, "worktree_kept", v.task.id, { path: v.task.cwd, reason: x instanceof Error ? x.message : String(x) });
    }
    logEvent(e, input.actor, "task_merged", v.task.id, { into: payload.into });
  }
  recordOutcomes(e, { remote: false });
  return result;
}
