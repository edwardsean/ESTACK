import type { Engine } from "./engine";
import { HOOK_GIT_TIMEOUT_MS, getTask, listOpen, logEvent, runBounded, tx, type TaskView } from "./tasks";
import { EngineError, actorId, type Actor, type Evidence } from "./types";

export type HandoverKind = "task" | "session";

interface BodyBase {
  kind: HandoverKind; auto: boolean; created_at: string; from_session: string;
  decisions: { what: string; why: string }[]; open_questions: string[];
}
export interface TaskHandoverBody extends BodyBase {
  kind: "task";
  task: { id: number; title: string; type: string; goal: string; done_check: string; branch: string; cwd: string; base_sha: string };
  steps: { name: string; status: string; evidence: { kind: string; ok: boolean; summary: string }[] }[];
  next_step: string | null;
  commits: string[];
  files: string[];
  git_error?: string;
}
export interface SessionHandoverBody extends BodyBase {
  kind: "session";
  goal: string;
  plan: string[];
  tasks: TaskHandoverBody[];
}
export interface Handover {
  id: number; kind: HandoverKind; task_id: number | null; from_session: string; created_at: string;
  auto: boolean; consumed_by: string | null; consumed_at: string | null;
  body: TaskHandoverBody | SessionHandoverBody;
}
export interface HandoverInput {
  goal?: string; plan?: string[]; decisions?: { what: string; why: string }[];
  open_questions?: string[]; files?: string[]; workers_done?: boolean;
}

export const MAX_COMMITS = 30;
export const MAX_FILES = 50;

interface Row {
  id: number; kind: HandoverKind; task_id: number | null; from_session: string; created_at: string;
  auto: number; body_json: string; consumed_by: string | null; consumed_at: string | null;
}
const toHandover = ({ auto, body_json, ...r }: Row): Handover => ({ ...r, auto: auto === 1, body: JSON.parse(body_json) });

const iso = (e: Engine) => e.now().toISOString();

function cap(items: string[], max: number): string[] {
  return items.length <= max ? items : [...items.slice(0, max), `+${items.length - max} more`];
}

function summarize(ev: Evidence): string {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.kind) {
    case "commit": return String(p.sha ?? "").slice(0, 7);
    case "command": return p.timed_out ? `${p.command} timed out` : `${p.command} exit ${p.exit_code}`;
    case "pr": return String(p.url ?? "");
    case "review": return `${p.verdict} by ${ev.recorded_by}`;
    default: return String(p.text ?? "").replace(/\s+/g, " ").slice(0, 120);
  }
}

function git(e: Engine, cwd: string, args: string[]): string {
  const r = runBounded(e, cwd, "git", args, HOOK_GIT_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}
const lines = (s: string) => s.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);

function buildTaskBody(e: Engine, v: TaskView, input: HandoverInput, actor: Actor, auto: boolean): TaskHandoverBody {
  const t = v.task;
  let commits: string[] = [];
  let files: string[] = [];
  let git_error: string | undefined;
  try {
    const range = `${t.base_sha}..refs/heads/${t.branch}`;
    commits = lines(git(e, t.cwd, ["log", "--format=%h %s", range]));
    const changed = lines(git(e, t.cwd, ["diff", "--name-only", range]));
    const dirty = lines(git(e, t.cwd, ["status", "--porcelain"])).map((l) => l.slice(3).split(" -> ").pop() as string);
    files = [...changed, ...dirty];
  } catch (err) {
    commits = [];
    files = [];
    git_error = err instanceof Error ? err.message : String(err);
  }
  files = [...new Set([...files, ...(input.files ?? [])])].sort();
  return {
    kind: "task", auto, created_at: iso(e), from_session: actor.session_id,
    decisions: input.decisions ?? [], open_questions: input.open_questions ?? [],
    task: { id: t.id, title: t.title, type: t.type, goal: t.goal, done_check: t.done_check, branch: t.branch, cwd: t.cwd, base_sha: t.base_sha },
    steps: v.steps.map((s) => ({
      name: s.name, status: s.status,
      evidence: v.evidence.filter((x) => x.step === s.name).map((x) => ({ kind: x.kind, ok: x.ok, summary: summarize(x) })),
    })),
    next_step: v.next?.name ?? null,
    commits: cap(commits, MAX_COMMITS),
    files: cap(files, MAX_FILES),
    ...(git_error ? { git_error } : {}),
  };
}

function boundIds(e: Engine, session_id: string, agentOnly?: boolean): Set<number> {
  const rows = e.db.prepare(
    `SELECT DISTINCT task_id FROM task_bindings WHERE session_id = ?${agentOnly ? " AND agent_id IS NOT NULL" : ""}`,
  ).all(session_id) as { task_id: number }[];
  return new Set(rows.map((r) => r.task_id));
}

/** Open tasks bound to the session. */
export function sessionTasks(e: Engine, session_id: string): TaskView[] {
  const ids = boundIds(e, session_id);
  return listOpen(e).filter((v) => ids.has(v.task.id));
}

/** Open tasks bound to the session by a worker whose part (up to and including "test") is unfinished. */
export function busyWorkerTasks(e: Engine, session_id: string): TaskView[] {
  const ids = boundIds(e, session_id, true);
  return listOpen(e).filter((v) => {
    if (!ids.has(v.task.id) || !v.next) return false;
    const test = v.steps.find((s) => s.name === "test");
    return !test || v.next.ordinal <= test.ordinal;
  });
}

function insertHandover(e: Engine, kind: HandoverKind, task_id: number | null, actor: Actor, auto: boolean,
  body: TaskHandoverBody | SessionHandoverBody): Handover {
  const r = e.db.prepare(
    "INSERT INTO handovers (kind, task_id, from_session, created_at, auto, body_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(kind, task_id, actor.session_id, body.created_at, auto ? 1 : 0, JSON.stringify(body));
  const id = Number(r.lastInsertRowid);
  logEvent(e, actor, "handover_saved", task_id, { id, kind, auto });
  return toHandover(e.db.prepare("SELECT * FROM handovers WHERE id = ?").get(id) as unknown as Row);
}

export function saveTaskHandover(e: Engine, task_id: number, input: HandoverInput, actor: Actor, auto = false): Handover {
  const v = getTask(e, task_id);
  const body = buildTaskBody(e, v, input, actor, auto);
  return tx(e, () => insertHandover(e, "task", task_id, actor, auto, body));
}

export function latestSessionHandover(e: Engine, session_id: string): Handover | null {
  const row = e.db.prepare("SELECT * FROM handovers WHERE kind = 'session' AND from_session = ? ORDER BY id DESC LIMIT 1")
    .get(session_id) as unknown as Row | undefined;
  return row ? toHandover(row) : null;
}

export function saveSessionHandover(e: Engine, input: HandoverInput, actor: Actor, auto = false): Handover {
  if (!input.workers_done && !auto) {
    const busy = busyWorkerTasks(e, actor.session_id);
    if (busy.length > 0) {
      throw new EngineError("BAD_EVIDENCE",
        `workers are still mid-task: ${busy.map((v) => `#${v.task.id} next: ${v.next?.name}`).join(", ")}; wait for them or pass workers_done`);
    }
  }
  const prev = auto ? latestSessionHandover(e, actor.session_id) : null;
  const pb = prev?.body as SessionHandoverBody | undefined;
  const merged: HandoverInput = {
    ...input,
    goal: input.goal ?? pb?.goal, plan: input.plan ?? pb?.plan,
    decisions: input.decisions ?? pb?.decisions, open_questions: input.open_questions ?? pb?.open_questions,
  };
  const tasks = sessionTasks(e, actor.session_id).map((v) => buildTaskBody(e, v, {}, actor, auto));
  const body: SessionHandoverBody = {
    kind: "session", auto, created_at: iso(e), from_session: actor.session_id,
    decisions: merged.decisions ?? [], open_questions: merged.open_questions ?? [],
    goal: merged.goal ?? "", plan: merged.plan ?? [], tasks,
  };
  return tx(e, () => insertHandover(e, "session", null, actor, auto, body));
}

/** Unconsumed handovers worth resuming: the newest session handover per session, and the newest task handover per open task not covered by a newer one. */
export function pendingHandovers(e: Engine): Handover[] {
  const rows = (e.db.prepare("SELECT * FROM handovers WHERE consumed_at IS NULL ORDER BY id").all() as unknown as Row[]).map(toHandover);
  const newestSession = new Map<string, Handover>();
  for (const h of rows) if (h.kind === "session") newestSession.set(h.from_session, h);
  const sessions = [...newestSession.values()];
  const open = new Set(listOpen(e).map((v) => v.task.id));
  const newestTask = new Map<number, Handover>();
  for (const h of rows) if (h.kind === "task" && h.task_id !== null && open.has(h.task_id)) newestTask.set(h.task_id, h);
  const tasks = [...newestTask.values()].filter((h) =>
    !sessions.some((s) => s.id > h.id && (s.body as SessionHandoverBody).tasks.some((t) => t.task.id === h.task_id)));
  return [...sessions, ...tasks].sort((a, b) => a.id - b.id);
}

function bind(e: Engine, task_id: number, actor: Actor): void {
  const dup = e.db.prepare("SELECT 1 FROM task_bindings WHERE task_id = ? AND session_id = ? AND agent_id IS ?")
    .get(task_id, actor.session_id, actor.agent_id ?? null);
  if (dup) return;
  e.db.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (?, ?, ?, ?, ?)")
    .run(task_id, actor.session_id, actor.agent_id ?? null, actor.agent_id ? "worker" : "cto", iso(e));
}

export function consumeHandover(e: Engine, actor: Actor, task_id?: number): { handover: Handover | null; views: TaskView[] } {
  return tx(e, () => {
    let handover: Handover | null = null;
    let ids: number[];
    if (task_id !== undefined) {
      const v = getTask(e, task_id);
      if (v.task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${task_id} is ${v.task.status}`);
      const row = e.db.prepare("SELECT * FROM handovers WHERE kind = 'task' AND task_id = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1")
        .get(task_id) as unknown as Row | undefined;
      handover = row ? toHandover(row) : null;
      ids = [task_id];
    } else {
      const row = e.db.prepare("SELECT * FROM handovers WHERE kind = 'session' AND consumed_at IS NULL ORDER BY id DESC LIMIT 1")
        .get() as unknown as Row | undefined;
      if (!row) throw new EngineError("NO_TASK", "no session handover waiting");
      handover = toHandover(row);
      ids = (handover.body as SessionHandoverBody).tasks.map((t) => t.task.id);
    }
    if (handover) {
      e.db.prepare("UPDATE handovers SET consumed_by = ?, consumed_at = ? WHERE id = ?").run(actorId(actor), iso(e), handover.id);
      handover = { ...handover, consumed_by: actorId(actor), consumed_at: iso(e) };
    }
    const views: TaskView[] = [];
    for (const id of ids) {
      const v = getTask(e, id);
      if (v.task.status !== "open") continue;
      bind(e, id, actor);
      views.push(v);
    }
    logEvent(e, actor, "resumed", task_id ?? null, { handover: handover?.id ?? null, tasks: views.map((v) => v.task.id) });
    return { handover, views };
  });
}
