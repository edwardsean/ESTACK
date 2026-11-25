import type { Engine } from "./engine";
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
function tx<T>(e: Engine, fn: () => T): T {
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

function logEvent(e: Engine, actor: Actor, kind: string, task_id: number | null, payload: unknown): void {
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

export function startTask(e: Engine, input: {
  title: string; type: string; goal: string; done_check: string; actor: Actor; cwd?: string; branch?: string;
}): TaskView {
  const steps = e.policy.task_types[input.type];
  if (!steps) throw new EngineError("POLICY_INVALID", `unknown task type "${input.type}"`);
  if (input.branch?.startsWith("-")) throw new EngineError("POLICY_INVALID", `invalid branch name: ${input.branch}`);
  const cwd = input.cwd ?? e.repo.root;
  const branch = input.branch
    ?? (e.exec.run("git", ["branch", "--show-current"], { cwd }).stdout.trim() || "HEAD");
  const now = iso(e);
  const by = actorId(input.actor);
  return tx(e, () => {
    const r = e.db.prepare(
      "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, created_by, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    ).run(input.title, input.type, input.goal, input.done_check, branch, cwd, by, now);
    const id = Number(r.lastInsertRowid);
    steps.forEach((name, i) =>
      e.db.prepare("INSERT INTO steps (task_id, name, ordinal, status) VALUES (?, ?, ?, 'pending')").run(id, name, i));
    e.db.prepare("INSERT INTO task_bindings (task_id, actor, role, bound_at) VALUES (?, ?, ?, ?)")
      .run(id, by, input.actor.agent_id ? "worker" : "cto", now);
    logEvent(e, input.actor, "task_started", id, { type: input.type, title: input.title, branch });
    return view(e, id);
  });
}

function insertEvidence(e: Engine, task_id: number, step: string, kind: EvidenceKind, ok: boolean,
  payload: Record<string, unknown>, actor: Actor): void {
  e.db.prepare(
    "INSERT INTO evidence (task_id, step, kind, ok, payload_json, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(task_id, step, kind, ok ? 1 : 0, JSON.stringify(payload), actorId(actor), iso(e));
}

/** Mark the step done; close the task if it was the last one. Returns whether the task closed. */
function finishStep(e: Engine, task_id: number, step: string): boolean {
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

function checkEvidence(e: Engine, v: TaskView, step: string, ev: EvidenceInput, actor: Actor): Record<string, unknown> {
  const opts = { cwd: v.task.cwd };
  switch (ev.kind) {
    case "note":
      if (!ev.text || !ev.text.trim()) bad("a note must not be blank");
      return { text: ev.text };
    case "commit": {
      if (!/^[0-9a-fA-F]{4,64}$/.test(ev.sha ?? "")) bad(`not a valid commit sha: ${ev.sha}`);
      if (e.exec.run("git", ["cat-file", "-e", `${ev.sha}^{commit}`], opts).code !== 0) bad(`commit ${ev.sha} does not exist`);
      if (e.exec.run("git", ["merge-base", "--is-ancestor", ev.sha, v.task.branch], opts).code !== 0) {
        bad(`commit ${ev.sha} is not on the task branch ${v.task.branch}`);
      }
      return { sha: ev.sha };
    }
    case "pr":
      if (!/^https:\/\/\S+\/pull\/\d+$/.test(ev.url ?? "")) bad(`not a pull request url: ${ev.url}`);
      if (e.exec.run("gh", ["pr", "view", ev.url, "--json", "url"], opts).code !== 0) bad(`gh could not find the pull request ${ev.url}`);
      return { url: ev.url };
    case "review": {
      if (ev.verdict !== "approve") bad("changes requested");
      const author = v.evidence.filter((x) => x.kind === "commit" && x.ok).at(-1)?.recorded_by;
      if (author === actorId(actor)) bad("a review must come from a different agent than the author");
      return { verdict: ev.verdict, findings: ev.findings };
    }
    default:
      return bad(`unsupported evidence kind for step ${step}`);
  }
}

export function completeStep(e: Engine, input: { task_id: number; step: string; evidence: EvidenceInput; actor: Actor }): TaskView {
  return tx(e, () => {
    const v = view(e, input.task_id);
    if (v.task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${v.task.id} is ${v.task.status}`);
    if (!v.next || v.next.name !== input.step) {
      throw new EngineError("OUT_OF_ORDER", `step "${input.step}" is not next; the next step is "${v.next?.name}"`);
    }
    const required = STEP_EVIDENCE[input.step];
    if (required === "command") {
      bad(`step "${input.step}" needs a command result; use run_check, not hand-written evidence`);
    }
    if (input.evidence.kind !== required) bad(`step "${input.step}" needs ${required} evidence, got ${input.evidence.kind}`);
    const payload = checkEvidence(e, v, input.step, input.evidence, input.actor);
    insertEvidence(e, v.task.id, input.step, required, true, payload, input.actor);
    const closed = finishStep(e, v.task.id, input.step);
    logEvent(e, input.actor, "step_done", v.task.id, { step: input.step, kind: required, closed });
    return view(e, v.task.id);
  });
}

/** Store evidence from an engine-run check (not the agent's words) and log it. */
export function recordEvidence(e: Engine, input: {
  task_id: number; step: string; kind: EvidenceKind; ok: boolean; payload: Record<string, unknown>; actor: Actor;
}): void {
  tx(e, () => {
    insertEvidence(e, input.task_id, input.step, input.kind, input.ok, input.payload, input.actor);
    logEvent(e, input.actor, "evidence", input.task_id, { step: input.step, kind: input.kind, ok: input.ok });
  });
}

/** Mark a step done (after its check passed); closes the task after its last step. */
export function markStepDone(e: Engine, task_id: number, step: string, actor: Actor): TaskView {
  return tx(e, () => {
    const closed = finishStep(e, task_id, step);
    logEvent(e, actor, "step_done", task_id, { step, closed });
    return view(e, task_id);
  });
}
