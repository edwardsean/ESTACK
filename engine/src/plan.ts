import type { Engine } from "./engine";
import { normaliseName, topLevelFunctions } from "./duplicates";
import { loadGraph } from "./graph";
import {
  EVIDENCE_TIMEOUT_MS, HOOK_FETCH_TIMEOUT_MS, HOOK_GIT_TIMEOUT_MS, getTask, logEvent, ownsTask, tx, type TaskView,
} from "./tasks";
import { EngineError, actorId, type Actor, type Task } from "./types";

export interface PlanTaskInput {
  title: string; type: string; goal: string; done_check: string; area: string[];
  adds?: string[]; depends_on?: (number | string)[]; group?: string;
}
export interface Overlap { a: number; b: number; kind: "area" | "adds" | "exists"; detail: string; resolved: boolean }

/** What a task (planned, open, or about to start) touches: the facts overlaps are computed from. */
interface Subject { id: number | null; parent_id: number | null; group: string | null; areas: string[]; items: string[] }

const getRow = (e: Engine, id: number): Task | undefined =>
  e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task | undefined;

function subjectOf(e: Engine, t: Task): Subject {
  const col = (sql: string) => (e.db.prepare(sql).all(t.id) as { v: string }[]).map((r) => r.v);
  return {
    id: t.id, parent_id: t.parent_id, group: t.task_group,
    areas: col("SELECT path v FROM task_areas WHERE task_id = ? ORDER BY path"),
    items: col("SELECT adds v FROM plan_items WHERE task_id = ? ORDER BY adds"),
  };
}

const cleanPath = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

/** The two paths are equal or one contains the other, by whole segments; the detail says which. */
function areaClash(x: string, y: string): string | null {
  const a = cleanPath(x);
  const b = cleanPath(y);
  if (a === b) return `both change ${a}`;
  if (b.startsWith(`${a}/`)) return `${a} contains ${b}`;
  if (a.startsWith(`${b}/`)) return `${b} contains ${a}`;
  return null;
}

/** Overlaps between two subjects, unresolved; a is the smaller id (0 stands for a task not yet recorded). */
function between(s: Subject, o: Subject): Omit<Overlap, "resolved">[] {
  const sid = s.id ?? 0;
  const oid = o.id ?? 0;
  const [a, b] = sid < oid ? [sid, oid] : [oid, sid];
  const out: Omit<Overlap, "resolved">[] = [];
  for (const x of s.areas) {
    for (const y of o.areas) {
      const detail = areaClash(x, y);
      if (detail) out.push({ a, b, kind: "area", detail });
    }
  }
  for (const n of s.items) if (o.items.includes(n)) out.push({ a, b, kind: "adds", detail: `both plan to add ${n}` });
  return out;
}

/** Planned items that match a top-level function already in the parent's checkout. */
function existing(e: Engine, s: Subject): Omit<Overlap, "resolved">[] {
  if (s.id === null || s.items.length === 0 || s.parent_id === null) return [];
  const parent = getRow(e, s.parent_id);
  const g = parent ? loadGraph(parent.cwd) : null;
  if (!g) return [];
  const fns = topLevelFunctions(g);
  const out: Omit<Overlap, "resolved">[] = [];
  for (const name of s.items) {
    const hit = fns.find((n) => normaliseName(n.name) === normaliseName(name));
    if (hit) out.push({ a: s.id, b: s.id, kind: "exists", detail: `reuse ${hit.name} at ${hit.file}:${hit.line} instead` });
  }
  return out;
}

function isResolved(e: Engine, o: Omit<Overlap, "resolved">): boolean {
  if (e.db.prepare("SELECT 1 FROM overlap_accepts WHERE a = ? AND b = ?").get(o.a, o.b)) return true;
  if (o.kind === "exists") return false;
  return e.db.prepare(
    "SELECT 1 FROM task_deps WHERE (task_id = ?1 AND depends_on = ?2) OR (task_id = ?2 AND depends_on = ?1)",
  ).get(o.a, o.b) !== undefined;
}

/** Open and planned tasks that could clash with the subject: not in its group, not its parent or child. */
function others(e: Engine, s: Subject): Subject[] {
  const rows = e.db.prepare("SELECT * FROM tasks WHERE status IN ('open','planned') ORDER BY id").all() as unknown as Task[];
  return rows
    .filter((t) => t.id !== s.id && !(s.group !== null && t.task_group === s.group)
      && t.id !== s.parent_id && !(s.id !== null && t.parent_id === s.id))
    .map((t) => subjectOf(e, t));
}

function overlapsOf(e: Engine, s: Subject): Overlap[] {
  const raw = [...others(e, s).flatMap((o) => between(s, o)), ...existing(e, s)];
  return raw.map((o) => ({ ...o, resolved: isResolved(e, o) }));
}

/** Overlaps of a recorded task against every open or planned task. */
export function overlapsFor(e: Engine, task_id: number): Overlap[] {
  const t = getRow(e, task_id);
  if (!t) throw new EngineError("NO_TASK", `no task with id ${task_id}`);
  return overlapsOf(e, subjectOf(e, t));
}

export function planTasks(e: Engine, input: { parent_task_id: number; tasks: PlanTaskInput[]; actor: Actor }): { tasks: TaskView[]; overlaps: Overlap[] } {
  const parent = getRow(e, input.parent_task_id);
  if (!parent || !ownsTask(e, input.actor.session_id, parent.id)) {
    throw new EngineError("NO_TASK", `task ${input.parent_task_id} is not yours to plan under`);
  }
  if (parent.status !== "open") throw new EngineError("TASK_CLOSED", `parent task ${parent.id} is ${parent.status}`);
  for (const t of input.tasks) {
    if (!e.policy.task_types[t.type]) throw new EngineError("POLICY_INVALID", `unknown task type "${t.type}"`);
  }
  const by = actorId(input.actor);
  const now = e.now().toISOString();
  const ids = tx(e, () => {
    const made: number[] = [];
    for (const t of input.tasks) {
      const id = Number(e.db.prepare(
        "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at, parent_id, task_group) VALUES (?, ?, ?, ?, 'planned', '', ?, '', ?, ?, ?, ?)",
      ).run(t.title, t.type, t.goal, t.done_check, parent.cwd, by, now, parent.id, t.group ?? null).lastInsertRowid);
      made.push(id);
      for (const p of t.area) e.db.prepare("INSERT OR IGNORE INTO task_areas (task_id, path) VALUES (?, ?)").run(id, cleanPath(p));
      for (const n of t.adds ?? []) e.db.prepare("INSERT OR IGNORE INTO plan_items (task_id, adds) VALUES (?, ?)").run(id, n);
    }
    input.tasks.forEach((t, i) => {
      for (const d of t.depends_on ?? []) {
        const dep = typeof d === "number" ? d : made[Number(/^#(\d+)$/.exec(d)?.[1]) - 1];
        if (dep === undefined || Number.isNaN(dep) || !getRow(e, dep)) {
          throw new EngineError("NO_TASK", `task ${input.tasks[i].title} depends on ${d}, which is not a task`);
        }
        if (dep === made[i]) throw new EngineError("DEPENDENCY", `task ${input.tasks[i].title} cannot depend on itself`);
        e.db.prepare("INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)").run(made[i], dep);
      }
      logEvent(e, input.actor, "task_planned", made[i], { title: t.title, area: t.area, adds: t.adds ?? [] });
    });
    return made;
  });
  const seen = new Set<string>();
  const overlaps = ids.flatMap((id) => overlapsFor(e, id)).filter((o) => {
    const k = `${o.a}/${o.b}/${o.kind}/${o.detail}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  for (const o of overlaps) if (!o.resolved) logEvent(e, input.actor, "overlap_found", o.a, o);
  return { tasks: ids.map((id) => getTask(e, id)), overlaps };
}

export function acceptOverlap(e: Engine, input: { a: number; b: number; reason: string; by: string; owner: boolean; actor?: Actor }): void {
  const [a, b] = input.a <= input.b ? [input.a, input.b] : [input.b, input.a];
  for (const id of [a, b]) if (!getRow(e, id)) throw new EngineError("NO_TASK", `no task with id ${id}`);
  if (!input.owner) {
    const s = input.actor?.session_id;
    if (!s || !ownsTask(e, s, a) || !ownsTask(e, s, b)) {
      throw new EngineError("OWNER_ONLY",
        `only the CTO of both tasks can accept this overlap; the owner runs: estack allow --task ${a} --with ${b} --reason <text>`);
    }
  }
  tx(e, () => {
    e.db.prepare("INSERT OR REPLACE INTO overlap_accepts (a, b, reason, by, at) VALUES (?, ?, ?, ?, ?)")
      .run(a, b, input.reason, input.by, e.now().toISOString());
    logEvent(e, input.actor ?? { session_id: input.by }, "overlap_accepted", a, { a, b, reason: input.reason, by: input.by, owner: input.owner });
  });
}

export function withdrawTask(e: Engine, task_id: number, actor: Actor): void {
  tx(e, () => {
    const t = getRow(e, task_id);
    if (!t) throw new EngineError("NO_TASK", `no task with id ${task_id}`);
    if (t.status !== "planned") throw new EngineError("TASK_CLOSED", `task ${task_id} is ${t.status}; only a planned task can be withdrawn`);
    if (!ownsTask(e, actor.session_id, task_id)) throw new EngineError("OWNER_ONLY", `only the CTO of task ${task_id} can withdraw it`);
    e.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(task_id);
    logEvent(e, actor, "task_withdrawn", task_id, {});
  });
}

/** True when the feature's branch is merged into main: its pull request is MERGED, or its head is on origin/main. */
export function mergedIntoMain(e: Engine, task: Task): boolean {
  if (!task.branch) return false;
  const pr = e.exec.run("gh", ["pr", "view", task.branch, "--json", "state"], { cwd: e.cwd, timeoutMs: EVIDENCE_TIMEOUT_MS });
  if (pr.code === 0) {
    try { if ((JSON.parse(pr.stdout) as { state?: unknown }).state === "MERGED") return true; } catch { /* fall through to git */ }
  }
  const git = (args: string[], timeoutMs = HOOK_GIT_TIMEOUT_MS) => e.exec.run("git", args, { cwd: e.cwd, timeoutMs });
  const head = git(["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}^{commit}`]);
  const sha = head.stdout.trim();
  // A branch still at its fork point has no work of its own: being behind origin/main does not make it merged.
  if (head.code !== 0 || !sha || sha === task.base_sha) return false;
  git(["fetch", "origin", "main"], HOOK_FETCH_TIMEOUT_MS);
  return git(["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]).code === 0;
}

/** Each dependency of the task, and whether it is finished: merged into the feature, or its feature merged into main. */
export function dependencyState(e: Engine, task_id: number): { finished: boolean; detail: string }[] {
  const me = getRow(e, task_id);
  if (!me) throw new EngineError("NO_TASK", `no task with id ${task_id}`);
  const deps = e.db.prepare("SELECT depends_on d FROM task_deps WHERE task_id = ? ORDER BY depends_on").all(task_id) as { d: number }[];
  return deps.map(({ d }) => {
    const dep = getRow(e, d);
    if (!dep) return { finished: false, detail: `task #${d} does not exist` };
    if (dep.status === "cancelled") return { finished: false, detail: `task #${d} was cancelled; withdraw this task or plan it again` };
    if (me.parent_id !== null && dep.parent_id === me.parent_id) {
      const merge = e.db.prepare("SELECT status FROM steps WHERE task_id = ? AND name = 'merge'").get(d) as { status: string } | undefined;
      const finished = merge?.status === "done";
      return { finished, detail: finished ? `task #${d} is merged into the feature` : `task #${d} (${dep.title}) is not merged into the feature yet` };
    }
    const feature = dep.parent_id === null ? dep : getRow(e, dep.parent_id) ?? dep;
    const finished = mergedIntoMain(e, feature);
    return { finished, detail: finished ? `task #${d} is merged into main` : `task #${d} (${dep.title}) waits for its feature #${feature.id} to merge into main` };
  });
}

/**
 * The checks before a task starts: no unresolved overlap, and every dependency finished. `planned` is the recorded
 * task being promoted; otherwise `fresh` describes the task about to be made.
 */
export function gateStart(e: Engine, actor: Actor, what: { planned: Task } | { fresh: Omit<Subject, "id" | "items"> }): void {
  const planned = "planned" in what ? what.planned : null;
  const s: Subject = planned ? subjectOf(e, planned) : { ...(what as { fresh: Subject }).fresh, id: null, items: [] };
  const open = overlapsOf(e, s).filter((o) => !o.resolved);
  if (open.length > 0) {
    const lines = open.map((o) => (o.kind === "exists" ? `  ${o.detail}` : `  #${o.a} and #${o.b} (${o.kind}): ${o.detail}`));
    const hint = planned ? `; resolve with accept_overlap, or the owner runs estack allow --task <a> --with <b> --reason <text>` : "; plan the work with plan_tasks and a dependency, or pick a different area";
    throw new EngineError("OVERLAP", `unresolved overlaps:\n${lines.join("\n")}${hint}`);
  }
  if (!planned) return;
  const state = dependencyState(e, planned.id);
  const waiting = state.filter((d) => !d.finished);
  if (waiting.length > 0) {
    throw new EngineError("DEPENDENCY", waiting.map((d) => d.detail).join("; "));
  }
  const rows = e.db.prepare("SELECT depends_on d FROM task_deps WHERE task_id = ?").all(planned.id) as { d: number }[];
  for (const { d } of rows) {
    const logged = e.db.prepare("SELECT 1 FROM events WHERE kind = 'dependency_finished' AND task_id = ? AND payload_json = ?")
      .get(planned.id, JSON.stringify({ depends_on: d }));
    if (!logged) logEvent(e, actor, "dependency_finished", planned.id, { depends_on: d });
  }
}

/** Planned tasks with their dependencies and unresolved overlaps, for status. */
export function plannedTasks(e: Engine): { task: Task; depends_on: number[]; overlaps: Overlap[] }[] {
  const rows = e.db.prepare("SELECT * FROM tasks WHERE status = 'planned' ORDER BY id").all() as unknown as Task[];
  return rows.map((task) => ({
    task,
    depends_on: (e.db.prepare("SELECT depends_on d FROM task_deps WHERE task_id = ? ORDER BY depends_on").all(task.id) as { d: number }[]).map((r) => r.d),
    overlaps: overlapsFor(e, task.id).filter((o) => !o.resolved),
  }));
}
