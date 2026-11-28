import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { acceptOverlap, overlapsFor, planTasks, startingTasks, withdrawTask, type PlanTaskInput } from "../src/plan";
import { getTask, insertEvidence, startTask, STALE_CLAIM_MS } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { realExec } from "../src/exec";
import { cancelTask } from "../src/owner";
import type { ExecResult } from "../src/exec";
import { fakeExec, makeRepo, writeFakeGraph } from "./helpers";

const cto: Actor = { session_id: "s1" };
const cto2: Actor = { session_id: "s2" };
const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

  test("a dependency in another feature waits for main, and never counts before it ran", () => {
    const gh: Record<string, Partial<ExecResult>> = {};
    const { dir, e } = setup(gh);
    const f1 = feature(e, dir, cto, "One");
    const f2 = feature(e, dir, cto2, "Two");
    const a = planTasks(e, { parent_task_id: f1.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
    const b = planTasks(e, { parent_task_id: f2.task.id, actor: cto2, tasks: [item("B", ["src/b"], { depends_on: [a] })] }).tasks[0].task.id;
    gh[`pr view ${f1.task.branch} --json state`] = { code: 0, stdout: JSON.stringify({ state: "MERGED" }) };
    // A never ran, so even a merged feature does not finish it.
    expect(code(() => begin(e, f2, b, cto2)).code).toBe("DEPENDENCY");
    begin(e, f1, a);
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name = 'merge'").run(a);
    insertEvidence(e, a, "merge", "merged", true, { head: "abc123", into: f1.task.branch }, cto);
    gh[`pr view ${f1.task.branch} --json state`] = { code: 0, stdout: JSON.stringify({ state: "OPEN" }) };
    expect(code(() => begin(e, f2, b, cto2)).code).toBe("DEPENDENCY");
    gh[`pr view ${f1.task.branch} --json state`] = { code: 0, stdout: JSON.stringify({ state: "MERGED" }) };
    expect(begin(e, f2, b, cto2).task.status).toBe("open");
  });

  describe("main as seen from a bare origin", () => {
    function withOrigin() {
      const { dir, e } = setup();
      const bare = mkdtempSync(join(tmpdir(), "estack-origin-"));
      execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
      git(dir, "remote", "add", "origin", bare);
      git(dir, "push", "origin", "main");
      const f1 = feature(e, dir, cto, "One");
      const f2 = feature(e, dir, cto2, "Two");
      const b = planTasks(e, { parent_task_id: f2.task.id, actor: cto2, tasks: [item("B", ["src/b"], { depends_on: [f1.task.id] })] }).tasks[0].task.id;
      return { dir, e, f1, f2, b, bare };
    }
    test("a feature untouched at its fork point is not merged", () => {
      const { e, f2, b } = withOrigin();
      expect(code(() => begin(e, f2, b, cto2)).code).toBe("DEPENDENCY");
    });
    test("an untouched feature fast-forwarded to origin/main is not merged", () => {
      const { dir, e, f1, f2, b } = withOrigin();
      git(dir, "commit", "--allow-empty", "-m", "elsewhere");
      git(dir, "push", "origin", "main");
      git(f1.task.cwd, "fetch", "origin", "main");
      git(f1.task.cwd, "merge", "--ff-only", "origin/main");
      expect(code(() => begin(e, f2, b, cto2)).code).toBe("DEPENDENCY");
    });
    test("a feature whose own commit reached origin/main is merged", () => {
      const { e, f1, f2, b } = withOrigin();
      git(f1.task.cwd, "commit", "--allow-empty", "-m", "feature work");
      const sha = git(f1.task.cwd, "rev-parse", "HEAD");
      insertEvidence(e, f1.task.id, "implement", "commit", true, { sha }, cto);
      expect(code(() => begin(e, f2, b, cto2)).code).toBe("DEPENDENCY");
      git(f1.task.cwd, "push", "origin", "HEAD:main");
      expect(begin(e, f2, b, cto2).task.status).toBe("open");
    });
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

describe("review fixes", () => {
  test("another CTO cannot start a planned task and take it over", () => {
    const { dir, e } = setup();
    const f1 = feature(e, dir, cto, "One");
    const f2 = feature(e, dir, cto2, "Two");
    const a = planTasks(e, { parent_task_id: f1.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
    const c = planTasks(e, { parent_task_id: f2.task.id, actor: cto2, tasks: [item("C", ["src/a"])] }).tasks[0].task.id;
    expect(code(() => begin(e, f1, a, cto2)).code).toBe("OWNER_ONLY");
    expect(getTask(e, a).task.status).toBe("planned");
    expect(code(() => acceptOverlap(e, { a, b: c, reason: "x", by: "s2", owner: false, actor: cto2 })).code).toBe("OWNER_ONLY");
  });

  test("a group name is scoped to its feature", () => {
    const { dir, e } = setup();
    const f1 = feature(e, dir, cto, "One");
    const f2 = feature(e, dir, cto2, "Two");
    planTasks(e, { parent_task_id: f1.task.id, actor: cto, tasks: [item("A", ["src/o"], { group: "g" })] });
    const same = planTasks(e, { parent_task_id: f1.task.id, actor: cto, tasks: [item("B", ["src/o"], { group: "g" })] });
    expect(same.overlaps).toEqual([]);
    const other = planTasks(e, { parent_task_id: f2.task.id, actor: cto2, tasks: [item("C", ["src/o"], { group: "g" })] });
    expect(other.overlaps.map((o) => o.kind)).toEqual(["area", "area"]);
  });

  describe("the starting state", () => {
    function claimed() {
      const { dir, e } = setup();
      const f = feature(e, dir, cto);
      const [a, b] = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"]), item("B", ["src/b"], { depends_on: ["#1"] })] }).tasks.map((t) => t.task.id);
      return { dir, e, f, a, b };
    }
    test("a dependent, and an overlapping fresh start, see a task that is being started", () => {
      const { dir, e, f, a, b } = claimed();
      let dependent: EngineError | undefined;
      let fresh: EngineError | undefined;
      let fired = false;
      e.exec = { ...e.exec, run(file, args, opts) {
        if (!fired && file === "git" && args[0] === "worktree" && args[1] === "add") {
          fired = true;
          expect(getTask(e, a).task.status).toBe("starting");
          dependent = code(() => begin(openEngine(dir), f, b));
          fresh = code(() => startTask(openEngine(dir), { title: "Fresh", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id, area: ["src/a/x.ts"] }));
        }
        return realExec.run(file, args, opts);
      } };
      begin(e, f, a);
      expect(dependent?.code).toBe("DEPENDENCY");
      expect(dependent?.message).toContain(`task #${a} is being started; try again when it is open`);
      expect(fresh?.code).toBe("OVERLAP");
    });

    test("a fresh worktree start is visible as starting, with its areas, while it runs", () => {
      const { dir, e, f } = claimed();
      let seen: unknown;
      let fired = false;
      e.exec = { ...e.exec, run(file, args, opts) {
        if (!fired && file === "git" && args[0] === "worktree" && args[1] === "add") {
          fired = true;
          seen = e.db.prepare("SELECT t.status, a.path FROM tasks t JOIN task_areas a ON a.task_id = t.id WHERE t.title = 'Fresh'").get();
        }
        return realExec.run(file, args, opts);
      } };
      startTask(e, { title: "Fresh", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id, area: ["src/z"] });
      expect(seen).toEqual({ status: "starting", path: "src/z" });
      void dir;
    });

    const age = (e: Engine, id: number) => {
      e.now = () => new Date(Date.now() + STALE_CLAIM_MS + 60_000);
      void id;
    };
    const strand = (e: Engine, id: number) =>
      e.db.prepare("UPDATE tasks SET status = 'starting' WHERE id = ?").run(id) && e.db.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES (?, 's1/main', 'task_claimed', ?, '{\"from\":\"planned\"}')").run(new Date().toISOString(), id);

    test("a fresh claim is not stale; a stale planned claim is recovered by start_task", () => {
      const { e, f, a } = claimed();
      strand(e, a);
      expect(code(() => begin(e, f, a)).code).toBe("TASK_CLOSED");
      age(e, a);
      expect(begin(e, f, a).task.status).toBe("open");
    });

    test("a stale planned claim is released back to planned by withdraw_task", () => {
      const { e, a } = claimed();
      strand(e, a);
      expect(code(() => withdrawTask(e, a, cto)).code).toBe("TASK_CLOSED");
      age(e, a);
      withdrawTask(e, a, cto);
      expect(getTask(e, a).task.status).toBe("planned");
    });

    test("a stale fresh row is treated as cancelled", () => {
      const { e, f } = claimed();
      const id = Number(e.db.prepare("INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at, parent_id) VALUES ('Dead', 'feature', 'g', 'd', 'starting', '', '', '', 's1/main', 'now', ?)").run(f.task.id).lastInsertRowid);
      e.db.prepare("INSERT INTO task_areas (task_id, path) VALUES (?, 'src/dead')").run(id);
      e.db.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES (?, 's1/main', 'task_claimed', ?, '{\"from\":\"new\"}')").run(new Date().toISOString(), id);
      const w = () => startTask(e, { title: "W", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id, area: ["src/dead"] });
      expect(code(w).code).toBe("OVERLAP");
      age(e, id);
      expect(w().task.status).toBe("open");
    });
  });

  test("area paths are normalised: absolute, dot-slash and the whole repository", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    mkdirSync(join(f.task.cwd, "src", "orders"), { recursive: true });
    const r = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [
      item("A", [join(f.task.cwd, "src/orders")]), item("B", ["./src/orders/invoice.ts/"]), item("C", ["src/other"]), item("D", ["."]),
    ] });
    const [a, b, c, d] = r.tasks.map((t) => t.task.id);
    expect(e.db.prepare("SELECT path FROM task_areas WHERE task_id = ?").all(a)).toEqual([{ path: "src/orders" }]);
    const pairs = r.overlaps.map((o) => `${o.a}-${o.b}`).sort();
    expect(pairs).toEqual([`${a}-${b}`, `${a}-${d}`, `${b}-${d}`, `${c}-${d}`].sort());
    expect(code(() => planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("E", ["/definitely/outside"])] })).code).toBe("POLICY_INVALID");
  });

  test("a task cannot depend on its own feature, and tasks cannot depend in a circle", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const own = code(() => planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"], { depends_on: [f.task.id] })] }));
    expect(own.code).toBe("DEPENDENCY");
    expect(own.message).toContain("own feature");
    const loop = code(() => planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [
      item("A", ["src/a"], { depends_on: ["#2"] }), item("B", ["src/b"], { depends_on: ["#3"] }), item("C", ["src/c"], { depends_on: ["#1"] }),
    ] }));
    expect(loop.code).toBe("DEPENDENCY");
    expect(loop.message).toContain("circle");
    expect(e.db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'planned'").get()).toEqual({ c: 0 });
  });

  describe("fix round 2", () => {
    function made() {
      const { dir, e } = setup();
      const f = feature(e, dir, cto);
      const a = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
      return { dir, e, f, a };
    }
    const strand = (e: Engine, id: number) => {
      e.db.prepare("UPDATE tasks SET status = 'starting', cwd = '', branch = '' WHERE id = ?").run(id);
      e.db.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES (?, 's1/main', 'task_claimed', ?, '{\"from\":\"planned\"}')").run(new Date().toISOString(), id);
    };
    const age = (e: Engine) => { e.now = () => new Date(Date.now() + STALE_CLAIM_MS + 60_000); };

    test("a stale claim whose worktree was already made is recovered by reusing it", () => {
      const { e, f, a } = made();
      // A start that dies right after `git worktree add`.
      const real = e.exec;
      e.exec = { ...real, run(file, args, opts) {
        if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") throw new Error("killed");
        return real.run(file, args, opts);
      } };
      expect(() => begin(e, f, a)).toThrow("killed");
      e.exec = real;
      const path = join(f.task.cwd, ".estack", "worktrees", `${a}-a`);
      expect(existsSync(path)).toBe(true);
      strand(e, a);
      age(e);
      const v = begin(e, f, a);
      expect(v.task).toMatchObject({ status: "open", cwd: path, branch: `task/${a}-a` });
      expect(git(path, "branch", "--show-current")).toBe(`task/${a}-a`);
      expect(e.db.prepare("SELECT payload_json p FROM events WHERE kind = 'worktree_created' AND task_id = ? ORDER BY id DESC LIMIT 1").get(a))
        .toMatchObject({ p: expect.stringContaining('"reused":true') });
    });

    test("something else at the worktree path, or the branch without its worktree, is refused with what to do", () => {
      const { e, f, a } = made();
      const path = join(f.task.cwd, ".estack", "worktrees", `${a}-a`);
      mkdirSync(path, { recursive: true });
      const e1 = code(() => begin(e, f, a));
      expect(e1.code).toBe("POLICY_INVALID");
      expect(e1.message).toContain(path);
      expect(e1.message).toContain(`git branch -d task/${a}-a`);
      expect(getTask(e, a).task.status).toBe("planned");
      execFileSync("rmdir", [path]);
      git(f.task.cwd, "branch", `task/${a}-a`);
      const e2 = code(() => begin(e, f, a));
      expect(e2.message).toContain(`branch task/${a}-a already exists without its worktree`);
    });

    test("a worker's areas are read against its feature, from any checkout", () => {
      const { dir, e, f } = made();
      mkdirSync(join(f.task.cwd, "src", "a"), { recursive: true });
      // Started from the main checkout, with an absolute path into the feature's worktree.
      const err = code(() => startTask(e, { title: "W", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, worktree: true, parent_task_id: f.task.id, area: [join(f.task.cwd, "src/a/x.ts")] }));
      expect(err.code).toBe("OVERLAP");
      expect(err.message).toContain("src/a contains src/a/x.ts");
    });

    test("another CTO cannot start a fresh worker under a feature it does not own", () => {
      const { dir, e, f } = made();
      const err = code(() => startTask(e, { title: "W", type: "feature", goal: "g", done_check: "d", actor: cto2, cwd: dir, worktree: true, parent_task_id: f.task.id, area: ["src/q"] }));
      expect(err.code).toBe("OWNER_ONLY");
      expect(e.db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'W'").get()).toEqual({ c: 0 });
    });

    test("parentless tasks with the same group still overlap", () => {
      const { dir, e } = setup();
      const w = (title: string, actor: Actor) => startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor, cwd: dir, area: ["src/o"], group: "g" });
      w("One", cto);
      expect(code(() => w("Two", cto2)).code).toBe("OVERLAP");
    });

    test("status shows starting tasks on their own; a stale fresh one is cancelled, and a dependent is told", () => {
      const { dir, e, f, a } = made();
      const id = Number(e.db.prepare("INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at) VALUES ('Top', 'feature', 'g', 'd', 'starting', '', '', '', 's1/main', 'now')").run().lastInsertRowid);
      e.db.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES (?, 's1/main', 'task_claimed', ?, '{\"from\":\"new\"}')").run(new Date().toISOString(), id);
      expect(startingTasks(e).map((s) => [s.task.id, s.stale])).toEqual([[id, false]]);
      expect(getTask(e, id).task.status).toBe("starting");
      age(e);
      expect(startingTasks(e)).toEqual([]);
      expect(getTask(e, id).task.status).toBe("cancelled");
      expect(e.db.prepare("SELECT kind FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id)).toEqual({ kind: "task_released" });
      // A dependent of a stale planned claim.
      const b = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("B", ["src/b"], { depends_on: [a] })] }).tasks[0].task.id;
      strand(e, a);
      const err = code(() => begin(e, f, b));
      expect(err.message).toContain(`task #${a}'s start went stale; its CTO must start it again or withdraw it`);
      void dir;
    });
  });

  describe("fix round 3", () => {
    function half() {
      const { dir, e } = setup();
      const f = feature(e, dir, cto);
      const a = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
      const path = join(f.task.cwd, ".estack", "worktrees", `${a}-a`);
      const real = e.exec;
      e.exec = { ...real, run(file, args, opts) {
        if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") throw new Error("killed");
        return real.run(file, args, opts);
      } };
      expect(() => begin(e, f, a)).toThrow("killed");
      e.exec = real;
      return { dir, e, f, a, path };
    }

    test("a worktree whose folder is gone, or that is still locked, is refused, not reused", () => {
      const { e, f, a, path } = half();
      git(f.task.cwd, "worktree", "lock", "--reason", "initializing", path);
      const locked = code(() => begin(e, f, a));
      expect(locked.code).toBe("POLICY_INVALID");
      expect(locked.message).toContain(`git worktree unlock ${path}`);
      git(f.task.cwd, "worktree", "unlock", path);
      rmSync(path, { recursive: true, force: true });
      const gone = code(() => begin(e, f, a));
      expect(gone.code).toBe("POLICY_INVALID");
      expect(gone.message).toContain("git worktree prune");
      expect(getTask(e, a).task.status).toBe("planned");
      expect(getTask(e, a).task.cwd).toBe(f.task.cwd);
    });

    test("a fresh start never adopts a leftover worktree", () => {
      const { dir, e } = setup();
      const f = feature(e, dir, cto);
      const next = (e.db.prepare("SELECT MAX(id) + 1 n FROM tasks").get() as { n: number }).n;
      const path = join(f.task.cwd, ".estack", "worktrees", `${next}-w`);
      git(f.task.cwd, "worktree", "add", "-b", `task/${next}-w`, path);
      writeFileSync(join(path, "precious.txt"), "work");
      const err = code(() => startTask(e, { title: "W", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id }));
      expect(err.code).toBe("POLICY_INVALID");
      expect(err.message).toContain(path);
      expect(existsSync(join(path, "precious.txt"))).toBe(true);
      expect(getTask(e, next).task.status).toBe("cancelled");
    });

    test("a branch checked out at another path names that path", () => {
      const { dir, e } = setup();
      const f = feature(e, dir, cto);
      const a = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"])] }).tasks[0].task.id;
      const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-else-"))), "wt");
      git(f.task.cwd, "worktree", "add", "-b", `task/${a}-a`, elsewhere);
      const err = code(() => begin(e, f, a));
      expect(err.message).toContain(`checked out in ${elsewhere}`);
      expect(err.message).not.toContain("git branch -d");
    });

    test("the owner can cancel a planned or starting task whose CTO is gone", () => {
      const { dir, e } = setup();
      const f = feature(e, dir, cto);
      const [a, b] = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"]), item("B", ["src/b"])] }).tasks.map((t) => t.task.id);
      e.db.prepare("UPDATE tasks SET status = 'starting' WHERE id = ?").run(b);
      expect(cancelTask(e, { task_id: a, reason: "gone" }, {}).task.status).toBe("cancelled");
      expect(cancelTask(e, { task_id: b, reason: "gone" }, {}).task.status).toBe("cancelled");
      expect(e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'task_cancelled'").get()).toEqual({ c: 2 });
      expect(code(() => cancelTask(e, { task_id: a, reason: "again" }, {})).code).toBe("TASK_CLOSED");
    });
  });
});

describe("workers cannot decide", () => {
  test("a worker subagent in the CTO's session cannot accept overlaps or withdraw tasks", () => {
    const { dir, e } = setup();
    const f = feature(e, dir, cto);
    const p = planTasks(e, { parent_task_id: f.task.id, actor: cto, tasks: [item("A", ["src/a"]), item("B", ["src/a"])] });
    const [a, b] = p.tasks.map((t) => t.task.id);
    const worker: Actor = { session_id: cto.session_id, agent_id: "w1" };
    expect(code(() => acceptOverlap(e, { a, b, reason: "ok", by: "x", owner: false, actor: worker })).message).toMatch(/a worker cannot/);
    expect(code(() => withdrawTask(e, a, worker)).message).toMatch(/a worker cannot/);
    expect(e.db.prepare("SELECT COUNT(*) c FROM overlap_accepts").get()).toEqual({ c: 0 });
    withdrawTask(e, a, cto);
  });
});
