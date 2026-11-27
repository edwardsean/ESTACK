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
  files: string[];
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

export function buildTaskBody(e: Engine, v: TaskView, input: HandoverInput, actor: Actor, auto: boolean): TaskHandoverBody {
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

function lastConsumedBy(e: Engine, session_id: string): Handover | null {
  const row = e.db.prepare("SELECT * FROM handovers WHERE kind = 'session' AND consumed_by LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1")
    .get(`${session_id.replace(/[\\%_]/g, "\\$&")}/%`) as unknown as Row | undefined;
  return row ? toHandover(row) : null;
}

export function saveSessionHandover(e: Engine, input: HandoverInput, actor: Actor, auto = false): Handover {
  if (!input.workers_done && !auto) {
    const busy = busyWorkerTasks(e, actor.session_id);
    if (busy.length > 0) {
      const noTest = busy.some((v) => !v.steps.some((s) => s.name === "test"));
      throw new EngineError("BAD_EVIDENCE",
        `workers are still mid-task: ${busy.map((v) => `#${v.task.id} next: ${v.next?.name}`).join(", ")}; wait for them or pass workers_done${
          noTest ? " (a worker-bound task with no test step counts as busy until it closes; pass workers_done if the workers are finished)" : ""}`);
    }
  }
  const prev = auto ? (latestSessionHandover(e, actor.session_id) ?? lastConsumedBy(e, actor.session_id)) : null;
  const pb = prev?.body as SessionHandoverBody | undefined;
  const merged: HandoverInput = {
    ...input,
    goal: input.goal ?? pb?.goal, plan: input.plan ?? pb?.plan,
    decisions: input.decisions ?? pb?.decisions, open_questions: input.open_questions ?? pb?.open_questions,
    files: input.files ?? pb?.files?.filter((f) => !/^\+\d+ more$/.test(f)),
  };
  const tasks = sessionTasks(e, actor.session_id).map((v) => buildTaskBody(e, v, {}, actor, auto));
  const body: SessionHandoverBody = {
    kind: "session", auto, created_at: iso(e), from_session: actor.session_id,
    decisions: merged.decisions ?? [], open_questions: merged.open_questions ?? [],
    goal: merged.goal ?? "", plan: merged.plan ?? [],
    files: cap([...new Set(merged.files ?? [])].sort(), MAX_FILES), tasks,
  };
  return tx(e, () => insertHandover(e, "session", null, actor, auto, body));
}

/** Ids of open tasks bound (by anyone in it) to the session. */
function openBoundIds(e: Engine, session_id: string): number[] {
  return (e.db.prepare(
    `SELECT DISTINCT t.id FROM tasks t JOIN task_bindings b ON b.task_id = t.id
     WHERE t.status = 'open' AND b.session_id = ? ORDER BY t.id`,
  ).all(session_id) as { id: number }[]).map((r) => r.id);
}

/**
 * When the handover's session last logged an event after saving it (ISO time), or null when it has not.
 * Activity after a handover means the session kept working, so it may still be running.
 */
export function activityAfter(e: Engine, h: Handover): string | null {
  const saved = e.db.prepare(
    "SELECT id FROM events WHERE kind = 'handover_saved' AND json_extract(payload_json, '$.id') = ? ORDER BY id LIMIT 1",
  ).get(h.id) as { id: number } | undefined;
  if (!saved) return null;
  const row = e.db.prepare("SELECT at FROM events WHERE id > ? AND actor LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1")
    .get(saved.id, `${h.from_session.replace(/[\\%_]/g, "\\$&")}/%`) as { at: string } | undefined;
  return row?.at ?? null;
}

/**
 * Unconsumed handovers worth resuming: the newest session handover per session (unless its session owns no
 * open task and it has no plan left, so the work is finished), and the newest task handover per open task
 * not covered by a newer one.
 */
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
  const live = sessions.filter((h) => (h.body as SessionHandoverBody).plan.length > 0 || openBoundIds(e, h.from_session).length > 0);
  return [...live, ...tasks].sort((a, b) => a.id - b.id);
}

function bind(e: Engine, task_id: number, actor: Actor): void {
  const dup = e.db.prepare("SELECT 1 FROM task_bindings WHERE task_id = ? AND session_id = ? AND agent_id IS ?")
    .get(task_id, actor.session_id, actor.agent_id ?? null);
  if (dup) return;
  e.db.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (?, ?, ?, ?, ?)")
    .run(task_id, actor.session_id, actor.agent_id ?? null, actor.agent_id ? "worker" : "cto", iso(e));
}

/** Which handover to resume: a task's (task_id), one by id (handover_id), or else the newest pending session handover. */
export interface ResumeSelector { task_id?: number; handover_id?: number }

/**
 * Consume a handover and bind its open tasks to the caller. A session handover binds every task open now and bound
 * to its session (plus any still-open task its body lists); the returned body's tasks are rebuilt live.
 */
export function consumeHandover(e: Engine, actor: Actor, sel: ResumeSelector = {}): { handover: Handover | null; views: TaskView[] } {
  const { task_id, handover_id } = sel;
  const result = tx(e, () => {
    let handover: Handover | null = null;
    let ids: number[];
    const openTask = (id: number) => {
      const v = getTask(e, id);
      if (v.task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${id} is ${v.task.status}`);
    };
    if (handover_id !== undefined) {
      const row = e.db.prepare("SELECT * FROM handovers WHERE id = ? AND consumed_at IS NULL").get(handover_id) as unknown as Row | undefined;
      if (!row) throw new EngineError("NO_TASK", `no handover #${handover_id} waiting`);
      handover = toHandover(row);
      if (handover.kind === "task") {
        openTask(handover.task_id as number);
        ids = [handover.task_id as number];
      } else ids = [];
    } else if (task_id !== undefined) {
      openTask(task_id);
      const row = e.db.prepare("SELECT * FROM handovers WHERE kind = 'task' AND task_id = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1")
        .get(task_id) as unknown as Row | undefined;
      handover = row ? toHandover(row) : null;
      ids = [task_id];
    } else {
      handover = pendingHandovers(e).filter((h) => h.kind === "session").at(-1) ?? null;
      if (!handover) throw new EngineError("NO_TASK", "no session handover waiting");
      ids = [];
    }
    if (handover?.kind === "session") {
      const listed = (handover.body as SessionHandoverBody).tasks.map((t) => t.task.id);
      ids = [...new Set([...openBoundIds(e, handover.from_session), ...listed])].sort((a, b) => a - b);
    }
    if (handover) {
      e.db.prepare("UPDATE handovers SET consumed_by = ?, consumed_at = ? WHERE id = ?").run(actorId(actor), iso(e), handover.id);
      handover = { ...handover, consumed_by: actorId(actor), consumed_at: iso(e) };
      // Everything this handover supersedes is consumed with it, so stale ones never resurface.
      const covered = handover.kind === "session" ? ids : [handover.task_id as number];
      const marks = covered.map(() => "?").join(",");
      e.db.prepare(
        `UPDATE handovers SET consumed_by = ?, consumed_at = ? WHERE consumed_at IS NULL AND id < ? AND (${
          handover.kind === "session" ? "(kind = 'session' AND from_session = ?) OR " : ""}(kind = 'task' AND task_id IN (${marks || "NULL"})))`,
      ).run(actorId(actor), iso(e), handover.id, ...(handover.kind === "session" ? [handover.from_session] : []), ...covered);
    }
    const views: TaskView[] = [];
    for (const id of ids) {
      const v = getTask(e, id);
      if (v.task.status !== "open") continue;
      bind(e, id, actor);
      views.push(v);
    }
    logEvent(e, actor, "resumed", handover?.task_id ?? task_id ?? null, { handover: handover?.id ?? null, tasks: views.map((v) => v.task.id) });
    return { handover, views };
  });
  const h = result.handover;
  if (h?.kind === "session") {
    // Git runs outside the transaction: the task part reflects the tasks as they are now, not at save time.
    const from: Actor = { session_id: h.from_session };
    const tasks = result.views.map((v) => buildTaskBody(e, v, {}, from, h.auto));
    return { handover: { ...h, body: { ...(h.body as SessionHandoverBody), tasks } }, views: result.views };
  }
  return result;
}
