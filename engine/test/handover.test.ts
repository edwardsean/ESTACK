import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { MIGRATION_1, SCHEMA_VERSION, openDb } from "../src/db";
import { openEngine, type Engine } from "../src/engine";
import {
  MAX_COMMITS, MAX_FILES, busyWorkerTasks, consumeHandover, latestSessionHandover, pendingHandovers,
  saveSessionHandover, saveTaskHandover, sessionTasks,
  type SessionHandoverBody, type TaskHandoverBody,
} from "../src/handover";
import { initRepo } from "../src/policy";
import { completeStep, logEvent, startTask, type EvidenceInput } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { makeRepo, fakeExec } from "./helpers";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const cto: Actor = { session_id: "s1" };
const worker: Actor = { session_id: "s1", agent_id: "w1" };
const fresh: Actor = { session_id: "s2" };

function setup() {
  const dir = makeRepo();
  initRepo(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "estack init");
  const e = openEngine(dir, { exec: fakeExec({}) });
  return { dir, e };
}
const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
const note = (text = "ok"): EvidenceInput => ({ kind: "note", text });
const start = (e: Engine, dir: string, actor: Actor = cto, type = "feature") =>
  startTask(e, { title: "t", type, goal: "g", done_check: "d", actor, cwd: dir });
const done = (e: Engine, id: number, step: string, ev: EvidenceInput = note(), actor = cto) =>
  completeStep(e, { task_id: id, step, evidence: ev, actor });
const code = (fn: () => unknown) => { try { fn(); } catch (x) { return (x as EngineError).code; } throw new Error("did not throw"); };

describe("handover storage", () => {
  test("a version-1 database upgrades to 2 and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "estack-mig-"));
    const path = join(dir, "state.db");
    const old = new DatabaseSync(path);
    old.exec(MIGRATION_1);
    old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    old.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES ('t', 'a', 'k', NULL, '{}')").run();
    old.prepare(`INSERT INTO tasks (id, title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at)
      VALUES (1, 't', 'feature', 'g', 'd', 'open', 'main', '/x', 'abc', 's1/main', 't')`).run();
    for (const [i, n] of ["plan", "implement"].entries()) {
      old.prepare("INSERT INTO steps (task_id, name, ordinal, status) VALUES (1, ?, ?, 'pending')").run(n, i);
    }
    old.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (1, 's1', NULL, 'cto', 't')").run();
    old.close();
    const db = openDb(path);
    expect((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(3);
    expect((db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM handovers").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM steps").get() as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) c FROM task_bindings").get() as { c: number }).c).toBe(1);
    expect(db.prepare("SELECT title, status FROM tasks").get()).toEqual({ title: "t", status: "open" });
  });
});

describe("handover assembly", () => {
  test("a task handover holds task, steps with evidence summaries, next step, commits and files", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    done(e, t.task.id, "plan", note("the plan"));
    writeFileSync(join(dir, "a.txt"), "x");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-m", "add a");
    const sha = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "dirty.txt"), "y");
    const h = saveTaskHandover(e, t.task.id, { files: ["z.ts"], decisions: [{ what: "w", why: "y" }], open_questions: ["q?"] }, cto);
    const b = h.body as TaskHandoverBody;
    expect(h.kind).toBe("task");
    expect(h.task_id).toBe(t.task.id);
    expect(h.consumed_by).toBeNull();
    expect(b.task).toMatchObject({ id: t.task.id, title: "t", type: "feature", goal: "g", done_check: "d", branch: "main", base_sha: t.task.base_sha });
    expect(b.steps[0]).toEqual({ name: "plan", status: "done", evidence: [{ kind: "note", ok: true, summary: "the plan" }] });
    expect(b.next_step).toBe("reuse_check");
    expect(b.commits).toEqual([`${sha.slice(0, 7)} add a`]);
    expect(b.files).toEqual(["a.txt", "dirty.txt", "z.ts"]);
    expect(b.decisions).toEqual([{ what: "w", why: "y" }]);
    expect(b.open_questions).toEqual(["q?"]);
    expect(b.from_session).toBe("s1");
    expect(b.auto).toBe(false);
  });

  test("commits and files are capped with a '+N more' marker", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    for (let i = 0; i < MAX_COMMITS + 2; i++) git(dir, "commit", "--allow-empty", "-m", `c${i}`);
    const files = Array.from({ length: MAX_FILES + 3 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
    const b = saveTaskHandover(e, t.task.id, { files }, cto).body as TaskHandoverBody;
    expect(b.commits).toHaveLength(MAX_COMMITS + 1);
    expect(b.commits.at(-1)).toBe("+2 more");
    expect(b.commits[0]).toMatch(/ c31$/);
    expect(b.files).toHaveLength(MAX_FILES + 1);
    expect(b.files.at(-1)).toBe("+3 more");
  });

  test("a git failure leaves commits/files empty with git_error, without throwing", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    e.db.prepare("UPDATE tasks SET base_sha = 'nonsense' WHERE id = ?").run(t.task.id);
    const b = saveTaskHandover(e, t.task.id, {}, cto).body as TaskHandoverBody;
    expect(b.commits).toEqual([]);
    expect(b.files).toEqual([]);
    expect(typeof b.git_error).toBe("string");
  });

  test("a session handover holds the goal, plan, decisions and every open task of the session", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    const b2 = start(e, dir);
    start(e, dir, fresh);
    const h = saveSessionHandover(e, { goal: "ship it", plan: ["later"], decisions: [{ what: "w", why: "y" }] }, cto);
    const b = h.body as SessionHandoverBody;
    expect(h.kind).toBe("session");
    expect(h.task_id).toBeNull();
    expect(b.goal).toBe("ship it");
    expect(b.plan).toEqual(["later"]);
    expect(b.tasks.map((t) => t.task.id)).toEqual([a.task.id, b2.task.id]);
    expect(sessionTasks(e, "s1")).toHaveLength(2);
    expect(latestSessionHandover(e, "s1")?.id).toBe(h.id);
    expect(latestSessionHandover(e, "nobody")).toBeNull();
  });

  test("a session handover keeps the files the agent lists, and an auto one carries them forward", () => {
    const { dir, e } = setup();
    start(e, dir);
    const h = saveSessionHandover(e, { goal: "g", files: ["docs/arch.md", "a.ts", "docs/arch.md"] }, cto);
    expect((h.body as SessionHandoverBody).files).toEqual(["a.ts", "docs/arch.md"]);
    const auto = saveSessionHandover(e, {}, cto, true);
    expect((auto.body as SessionHandoverBody).files).toEqual(["a.ts", "docs/arch.md"]);
  });

  test("a session handover is refused while a worker is mid-task, and allowed with workers_done", () => {
    const { dir, e } = setup();
    const t = start(e, dir, worker);
    done(e, t.task.id, "plan", note(), worker); done(e, t.task.id, "reuse_check", note(), worker);
    expect(busyWorkerTasks(e, "s1").map((v) => v.task.id)).toEqual([t.task.id]);
    const err = (() => { try { saveSessionHandover(e, { goal: "g" }, cto); } catch (x) { return x as EngineError; } throw new Error("no throw"); })();
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain(`#${t.task.id} next: implement`);
    expect(saveSessionHandover(e, { goal: "g", workers_done: true }, cto).kind).toBe("session");
    expect(saveSessionHandover(e, { goal: "g" }, cto, true).auto).toBe(true);
  });

  test("an auto session handover carries goal and plan forward from the previous one", () => {
    const { dir, e } = setup();
    start(e, dir);
    saveSessionHandover(e, { goal: "the goal", plan: ["p1"], decisions: [{ what: "w", why: "y" }], open_questions: ["q"] }, cto);
    const auto = saveSessionHandover(e, {}, cto, true);
    const b = auto.body as SessionHandoverBody;
    expect(auto.auto).toBe(true);
    expect(b.goal).toBe("the goal");
    expect(b.plan).toEqual(["p1"]);
    expect(b.decisions).toEqual([{ what: "w", why: "y" }]);
    expect(b.open_questions).toEqual(["q"]);
    expect(b.tasks).toHaveLength(1);
  });

  test("pending lists session handovers and task handovers not covered by a newer session handover", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    const b = start(e, dir);
    saveTaskHandover(e, a.task.id, {}, cto);
    const tb = saveTaskHandover(e, b.task.id, {}, cto);
    expect(pendingHandovers(e)).toHaveLength(2);
    const s1 = saveSessionHandover(e, { goal: "1" }, cto);
    expect(pendingHandovers(e).map((h) => h.id)).toEqual([s1.id]);
    const s2 = saveSessionHandover(e, { goal: "2" }, cto);
    expect(pendingHandovers(e).map((h) => h.id)).toEqual([s2.id]);
    const later = saveTaskHandover(e, a.task.id, {}, cto);
    expect(pendingHandovers(e).map((h) => h.id).sort()).toEqual([s2.id, later.id].sort());
    expect(tb.id).toBeLessThan(s2.id);
  });

  test("resuming a session handover binds the new session to every open task in it", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    const b = start(e, dir);
    const h = saveSessionHandover(e, { goal: "g" }, cto);
    const r = consumeHandover(e, fresh);
    expect(r.handover?.id).toBe(h.id);
    expect(r.handover?.consumed_by).toBe("s2/main");
    expect(r.views.map((v) => v.task.id)).toEqual([a.task.id, b.task.id]);
    const rows = e.db.prepare("SELECT role, agent_id FROM task_bindings WHERE session_id = 's2'").all();
    expect(rows).toEqual([{ role: "cto", agent_id: null }, { role: "cto", agent_id: null }]);
    expect(e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'resumed'").get()).toEqual({ c: 1 });
    expect(code(() => consumeHandover(e, { session_id: "s3" }))).toBe("NO_TASK");
    // binding is not duplicated on a second resume by the same session
    saveSessionHandover(e, { goal: "g" }, cto);
    consumeHandover(e, fresh);
    expect((e.db.prepare("SELECT COUNT(*) c FROM task_bindings WHERE session_id = 's2'").get() as { c: number }).c).toBe(2);
  });

  test("resuming a task handover binds one task; on a closed task it is TASK_CLOSED", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    const b = start(e, dir);
    const h = saveTaskHandover(e, a.task.id, {}, cto);
    const r = consumeHandover(e, { session_id: "s2", agent_id: "w9" }, { task_id: a.task.id });
    expect(r.handover?.id).toBe(h.id);
    expect(r.views.map((v) => v.task.id)).toEqual([a.task.id]);
    expect(e.db.prepare("SELECT role FROM task_bindings WHERE session_id = 's2'").all()).toEqual([{ role: "worker" }]);
    // no handover waiting for b, but it is open: still binds, handover null
    expect(consumeHandover(e, fresh, { task_id: b.task.id }).handover).toBeNull();
    e.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(b.task.id);
    expect(code(() => consumeHandover(e, fresh, { task_id: b.task.id }))).toBe("TASK_CLOSED");
  });

  test("resuming with nothing waiting is NO_TASK", () => {
    const { e } = setup();
    expect(code(() => consumeHandover(e, fresh))).toBe("NO_TASK");
  });

  test("consuming a session handover consumes the older ones it supersedes", () => {
    const { dir, e } = setup();
    start(e, dir);
    saveSessionHandover(e, { goal: "1" }, cto);
    const h2 = saveSessionHandover(e, { goal: "2" }, cto);
    expect(consumeHandover(e, fresh).handover?.id).toBe(h2.id);
    expect(pendingHandovers(e)).toEqual([]);
    expect(code(() => consumeHandover(e, { session_id: "s3" }))).toBe("NO_TASK");
  });

  test("a task handover covered by a consumed session handover does not reappear", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    saveTaskHandover(e, a.task.id, {}, cto);
    saveSessionHandover(e, { goal: "g" }, cto);
    consumeHandover(e, fresh);
    expect(pendingHandovers(e)).toEqual([]);
  });

  test("consuming a task handover consumes the older ones for the same task", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    saveTaskHandover(e, a.task.id, {}, cto);
    saveTaskHandover(e, a.task.id, {}, cto);
    consumeHandover(e, fresh, { task_id: a.task.id });
    expect(pendingHandovers(e)).toEqual([]);
  });

  test("a resumed session's auto handover carries goal and plan from the handover it consumed", () => {
    const { dir, e } = setup();
    start(e, dir);
    saveSessionHandover(e, { goal: "G", plan: ["P"] }, cto);
    consumeHandover(e, fresh);
    const b = saveSessionHandover(e, {}, fresh, true).body as SessionHandoverBody;
    expect(b.goal).toBe("G");
    expect(b.plan).toEqual(["P"]);
  });

  test("C1 a session handover is no longer pending once its session owns no open task and its plan is empty", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    saveSessionHandover(e, { goal: "ship X" }, cto);
    saveSessionHandover(e, {}, cto, true);
    expect(pendingHandovers(e)).toHaveLength(1);
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(a.task.id);
    expect(pendingHandovers(e)).toEqual([]);
    expect(code(() => consumeHandover(e, fresh))).toBe("NO_TASK");
    // with plan items left it is still worth resuming
    saveSessionHandover(e, { goal: "ship X", plan: ["do Y"] }, cto);
    expect(pendingHandovers(e)).toHaveLength(1);
  });

  test("a finished session's handover with plan items left is not pending once that session logged events after it", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    saveSessionHandover(e, { goal: "ship X", plan: ["do Y"] }, cto);
    expect(pendingHandovers(e)).toHaveLength(1);
    // the old session keeps working and closes its task
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(a.task.id);
    logEvent(e, cto, "step_done", a.task.id, { step: "ship", closed: true });
    expect(pendingHandovers(e)).toEqual([]);
    expect(code(() => consumeHandover(e, fresh))).toBe("NO_TASK");
  });

  test("a plan-only session handover stays pending while its session is quiet, until it is 24 h old", () => {
    const { dir } = setup();
    const clock = { t: Date.parse("2026-11-27T00:00:00Z") };
    const e = openEngine(dir, { exec: fakeExec({}), now: () => new Date(clock.t) });
    saveSessionHandover(e, { goal: "ship X", plan: ["do Y"] }, cto);
    clock.t += 23 * 3600 * 1000;
    expect(pendingHandovers(e)).toHaveLength(1);
    clock.t += 2 * 3600 * 1000;
    expect(pendingHandovers(e)).toEqual([]);
  });

  test("a session handover with open tasks stays pending even when its session logged events after it", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    saveSessionHandover(e, { goal: "ship X" }, cto);
    logEvent(e, cto, "evidence", a.task.id, { step: "plan" });
    expect(pendingHandovers(e)).toHaveLength(1);
  });

  test("I1 resuming a session handover binds every open task the old session owns now, and rebuilds the task part live", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    const h = saveSessionHandover(e, { goal: "G", plan: ["P"] }, cto, true);
    const b = start(e, dir);
    done(e, a.task.id, "plan");
    const r = consumeHandover(e, fresh);
    expect(r.handover?.id).toBe(h.id);
    expect(r.views.map((v) => v.task.id)).toEqual([a.task.id, b.task.id]);
    const body = r.handover?.body as SessionHandoverBody;
    expect(body.goal).toBe("G");
    expect(body.plan).toEqual(["P"]);
    expect(body.tasks.map((t) => t.task.id)).toEqual([a.task.id, b.task.id]);
    expect(body.tasks[0].next_step).toBe("reuse_check");
    expect(sessionTasks(e, "s2").map((v) => v.task.id)).toEqual([a.task.id, b.task.id]);
  });

  test("I2 resume with handover_id consumes exactly that handover", () => {
    const { dir, e } = setup();
    start(e, dir);
    const older = saveSessionHandover(e, { goal: "A goal" }, cto);
    start(e, dir, { session_id: "C" });
    const newer = saveSessionHandover(e, { goal: "C goal" }, { session_id: "C" });
    expect(pendingHandovers(e).map((h) => h.id)).toEqual([older.id, newer.id]);
    const r = consumeHandover(e, { session_id: "N" }, { handover_id: older.id });
    expect(r.handover?.id).toBe(older.id);
    expect((r.handover?.body as SessionHandoverBody).goal).toBe("A goal");
    expect(pendingHandovers(e).map((h) => h.id)).toEqual([newer.id]);
    expect(code(() => consumeHandover(e, { session_id: "M" }, { handover_id: older.id }))).toBe("NO_TASK");
    expect(code(() => consumeHandover(e, { session_id: "M" }, { handover_id: 999 }))).toBe("NO_TASK");
  });

  test("I2 resume with handover_id of a task handover on a closed task is TASK_CLOSED", () => {
    const { dir, e } = setup();
    const a = start(e, dir);
    const h = saveTaskHandover(e, a.task.id, {}, cto);
    e.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(a.task.id);
    expect(code(() => consumeHandover(e, fresh, { handover_id: h.id }))).toBe("TASK_CLOSED");
  });

  test("M5 the busy-worker refusal explains that a worker task with no test step counts until it closes", () => {
    const { dir, e } = setup();
    const t = start(e, dir, worker, "spike");
    const err = (() => { try { saveSessionHandover(e, { goal: "g" }, cto); } catch (x) { return x as EngineError; } throw new Error("no throw"); })();
    expect(err.message).toContain(`#${t.task.id} next: explore`);
    expect(err.message).toContain("(a worker-bound task with no test step counts as busy until it closes; pass workers_done if the workers are finished)");
  });
});
