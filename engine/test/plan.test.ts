import { describe, expect, test } from "vitest";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { acceptOverlap, overlapsFor, planTasks, withdrawTask, type PlanTaskInput } from "../src/plan";
import { getTask, startTask } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { realExec } from "../src/exec";
import type { ExecResult } from "../src/exec";
import { fakeExec, makeRepo, writeFakeGraph } from "./helpers";

const cto: Actor = { session_id: "s1" };
const cto2: Actor = { session_id: "s2" };
const code = (fn: () => unknown): EngineError => { try { fn(); } catch (x) { return x as EngineError; } throw new Error("did not throw"); };

function setup(gh: Record<string, Partial<ExecResult>> = {}) {
  const dir = makeRepo();
  initRepo(dir);
  return { dir, e: openEngine(dir, { exec: fakeExec(gh) }) };
}
const feature = (e: Engine, dir: string, actor: Actor, title = "Feat") =>
  startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor, cwd: dir, worktree: true });
const item = (title: string, area: string[], extra: Partial<PlanTaskInput> = {}): PlanTaskInput =>
  ({ title, type: "feature", goal: "g", done_check: "d", area, ...extra });
const begin = (e: Engine, f: { task: { id: number; cwd: string } }, id: number, actor: Actor = cto) =>
  startTask(e, { actor, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id, task_id: id });

describe("plan_tasks", () => {
  test("plan_tasks records planned tasks and reports area overlaps", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const r = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [
      item("A", ["src/orders"]), item("B", ["src/orders/invoice.ts"]), item("C", ["src/ordersx"]),
    ] });
    expect(r.tasks.map((t) => t.task.status)).toEqual(["planned", "planned", "planned"]);
    expect(r.tasks[0].task.parent_id).toBe(f.task.id);
    expect(r.tasks[0].task.cwd).toBe(f.task.cwd);
    expect(r.tasks[0].steps).toEqual([]);
    const [a, b] = r.tasks.map((t) => t.task.id);
    expect(r.overlaps).toEqual([{ a, b, kind: "area", detail: "src/orders contains src/orders/invoice.ts", resolved: false }]);
    expect(e.db.prepare("SELECT kind FROM events WHERE kind IN ('task_planned','overlap_found') ORDER BY id").all().map((x) => x.kind))
      .toEqual(["task_planned", "task_planned", "task_planned", "overlap_found"]);
    expect(code(() => planTasks(e, { parent_task_id: f.task.id, actor: cto2, tasks: [item("X", ["x"])] })).code).toBe("NO_TASK");
  });

  test("two tasks planning the same helper overlap, and an existing helper says reuse it", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    writeFakeGraph(f.task.cwd,
      [{ id: "file:src/utils.ts", label: "utils.ts", source_file: "src/utils.ts", source_location: "L1" },
        { id: "fd", label: "formatInvoiceDate()", source_file: "src/utils.ts", source_location: "L7" }],
      [{ source: "file:src/utils.ts", target: "fd", relation: "contains", confidence: "EXTRACTED", source_file: "src/utils.ts", source_location: "L7" }]);
    const r = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [
      item("A", ["src/a"], { adds: ["parseMoney"] }), item("B", ["src/b"], { adds: ["parseMoney", "getFormatInvoiceDate"] }),
    ] });
    const [a, b] = r.tasks.map((t) => t.task.id);
    expect(r.overlaps).toEqual(expect.arrayContaining([
      { a, b, kind: "adds", detail: "both plan to add parseMoney", resolved: false },
      { a: b, b, kind: "exists", detail: "reuse formatInvoiceDate at src/utils.ts:7 instead", resolved: false },
    ]));
    expect(r.overlaps).toHaveLength(2);
    acceptOverlap(e, { a: b, b, reason: "different meaning", by: "s1", owner: false, actor: cto });
    expect(overlapsFor(e, b).find((o) => o.kind === "exists")?.resolved).toBe(true);
  });

  test("a dependency resolves the overlap and holds the dependent back until the foundation is merged into the feature", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const r = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [
      item("Base", ["src/orders"]), item("Next", ["src/orders/x.ts"], { depends_on: ["#1"] }),
    ] });
    const [a, b] = r.tasks.map((t) => t.task.id);
    expect(r.overlaps).toEqual([{ a, b, kind: "area", detail: "src/orders contains src/orders/x.ts", resolved: true }]);
    const err = code(() => begin(e, f, b));
    expect(err.code).toBe("DEPENDENCY");
    expect(err.message).toContain(`task #${a}`);
    begin(e, f, a);
    expect(code(() => begin(e, f, b)).code).toBe("DEPENDENCY");
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name = 'merge'").run(a);
    const v = begin(e, f, b);
    expect(v.task.status).toBe("open");
    expect(e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'dependency_finished' AND task_id = ?").get(b)).toEqual({ c: 1 });
  });

  test("the CTO accepts an overlap between its own tasks; across CTOs it is the owner's", () => {
    const { dir, e } = setup();
    const f1 = feature(e, dir, cto, "One");
    const f2 = feature(e, dir, cto2, "Two");
    const p1 = planTasks(e, { parent_task_id: f1.task.id, actor: cto, tasks: [item("A", ["src/o"]), item("B", ["src/o/x"])] });
    const p2 = planTasks(e, { parent_task_id: f2.task.id, actor: cto2, tasks: [item("C", ["src/o"])] });
    const [a, b] = p1.tasks.map((t) => t.task.id);
    const c = p2.tasks[0].task.id;
    acceptOverlap(e, { a: b, b: a, reason: "split by file", by: "s1", owner: false, actor: cto });
    expect(overlapsFor(e, a).find((o) => o.b === b)?.resolved).toBe(true);
    expect(e.db.prepare("SELECT a, b FROM overlap_accepts").all()).toEqual([{ a, b }]);
    const err = code(() => acceptOverlap(e, { a, b: c, reason: "ok", by: "s1", owner: false, actor: cto }));
    expect(err.code).toBe("OWNER_ONLY");
    expect(err.message).toContain(`estack allow --task ${a} --with ${c} --reason`);
    acceptOverlap(e, { a, b: c, reason: "owner says", by: "owner", owner: true });
    expect(overlapsFor(e, c).find((o) => o.a === a)?.resolved).toBe(true);
    expect(e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'overlap_accepted'").get()).toEqual({ c: 2 });
  });

  test("starting a task without plan_tasks still checks overlaps", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const w = (title: string, area: string[]) => startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id, area });
    w("First", ["src/orders"]);
    const err = code(() => w("Second", ["src/orders/invoice.ts"]));
    expect(err.code).toBe("OVERLAP");
    expect(err.message).toContain("src/orders");
    expect(w("Third", ["src/other"]).task.status).toBe("open");
    expect(e.db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'Second'").get()).toEqual({ c: 0 });
  });

  test("a task whose dependency was cancelled can't start", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const r = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"]), item("B", ["src/b"], { depends_on: ["#1"] })] });
    const [a, b] = r.tasks.map((t) => t.task.id);
    withdrawTask(e, a, cto);
    const err = code(() => begin(e, f, b));
    expect(err.code).toBe("DEPENDENCY");
    expect(err.message).toContain(`task #${a} was cancelled; withdraw this task or plan it again`);
  });

  test("a dependency in another feature waits for main", () => {
    const gh: Record<string, Partial<ExecResult>> = {};
    const { dir, e } = setup(gh);
    const f1 = feature(e, dir, cto, "One");
    const f2 = feature(e, dir, cto2, "Two");
    const a = planTasks(e, { parent_task_id: f1.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
    const b = planTasks(e, { parent_task_id: f2.task.id, actor: cto2, tasks: [item("B", ["src/b"], { depends_on: [a] })] }).tasks[0].task.id;
    gh[`pr view ${f1.task.branch} --json state`] = { code: 0, stdout: JSON.stringify({ state: "OPEN" }) };
    expect(code(() => begin(e, f2, b, cto2)).code).toBe("DEPENDENCY");
    gh[`pr view ${f1.task.branch} --json state`] = { code: 0, stdout: JSON.stringify({ state: "MERGED" }) };
    expect(begin(e, f2, b, cto2).task.status).toBe("open");
  });

  test("withdraw_task cancels a planned task", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const a = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
    expect(code(() => withdrawTask(e, a, cto2)).code).toBe("OWNER_ONLY");
    withdrawTask(e, a, cto);
    expect(getTask(e, a).task.status).toBe("cancelled");
    expect(e.db.prepare("SELECT kind FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(a)).toEqual({ kind: "task_withdrawn" });
    expect(code(() => withdrawTask(e, a, cto)).code).toBe("TASK_CLOSED");
  });
});

describe("promoting a planned task", () => {
  test("two simultaneous start_task calls: the second is refused and the first's open task is left alone", () => {
    const { dir, e } = setup();
    const e2 = openEngine(dir);
    const f = feature(e, dir, cto);
    const a = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
    // While the first call is still working out its worktree, a second call promotes the same task and finishes.
    let inner: EngineError | undefined;
    let won: ReturnType<typeof begin> | undefined;
    let fired = false;
    e.exec = { ...e.exec, run(file, args, opts) {
      if (!fired && file === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        fired = true;
        won = begin(e2, f, a);
      }
      return realExec.run(file, args, opts);
    } };
    inner = code(() => begin(e, f, a));
    expect(inner.code).toBe("TASK_CLOSED");
    expect(inner.message).toContain(`task #${a} is already being started`);
    const row = getTask(e, a).task;
    expect(row.status).toBe("open");
    expect(row.cwd).toBe(won!.task.cwd);
    expect(row.branch).toBe(won!.task.branch);
  });

  test("a failed promotion never resets a task that another process has opened", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const a = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
    e.exec = { ...e.exec, run(file, args, opts) {
      if (file === "git" && args[0] === "worktree" && args[1] === "add") {
        e.db.prepare("UPDATE tasks SET status = 'open', cwd = '/elsewhere', branch = 'task/other' WHERE id = ?").run(a);
        throw new Error("boom");
      }
      return realExec.run(file, args, opts);
    } };
    expect(() => begin(e, f, a)).toThrow();
    expect(getTask(e, a).task).toMatchObject({ status: "open", cwd: "/elsewhere", branch: "task/other" });
  });
});
