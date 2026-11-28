import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { getTask, startTask } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { removeWorktree, slug } from "../src/worktree";
import { realExec } from "../src/exec";
import { fakeExec, makeRepo } from "./helpers";

const cto: Actor = { session_id: "s1" };
const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup(setupCmd?: string) {
  const dir = makeRepo();
  initRepo(dir);
  if (setupCmd) {
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}# worktree_setup:.*$/m, `  worktree_setup: "${setupCmd}"`));
  }
  return { dir, e: openEngine(dir) };
}
const feature = (e: Engine, dir: string, title = "Add invoice totals") =>
  startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, worktree: true });
const own = (e: Engine, id: number) => e.db.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (?, 's1', NULL, 'cto', 'now')").run(id);
const code = (fn: () => unknown) => { try { fn(); } catch (x) { return (x as EngineError).code; } throw new Error("did not throw"); };

describe("worktrees", () => {
  test("slug makes short branch-safe names", () => {
    expect(slug("Add invoice totals!")).toBe("add-invoice-totals");
    expect(slug("a".repeat(60))).toHaveLength(40);
    expect(slug("  --Hello,   World--  ")).toBe("hello-world");
  });

  test("a feature started from the main checkout leaves it on main", () => {
    const { dir, e } = setup();
    const v = feature(e, dir);
    const id = v.task.id;
    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(v.task.cwd).toBe(join(dir, ".estack", "worktrees", `${id}-add-invoice-totals`));
    expect(v.task.branch).toBe(`feat/${id}-add-invoice-totals`);
    expect(git(v.task.cwd, "branch", "--show-current")).toBe(v.task.branch);
    expect(v.task.base_sha).toBe(git(dir, "rev-parse", "main"));
    expect(v.worktree_path).toBe(v.task.cwd);
    expect(v.steps.map((s) => s.name)).toEqual(["plan", "reuse_check", "implement", "test", "verify", "review", "pr"]);
    expect(e.db.prepare("SELECT role FROM task_bindings WHERE task_id = ?").get(id)).toEqual({ role: "cto" });
    expect(e.db.prepare("SELECT kind FROM events WHERE task_id = ? ORDER BY id").all(id).map((r) => r.kind)).toEqual(["task_claimed", "worktree_created", "task_started"]);
  });

  test("a feature branches from origin/main when an origin exists", () => {
    const { dir, e } = setup();
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "estack-origin-")));
    git(bare, "init", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "origin", "main");
    git(dir, "commit", "--allow-empty", "-m", "local only");
    const v = feature(e, dir);
    expect(v.task.base_sha).toBe(git(dir, "rev-parse", "origin/main"));
    expect(v.task.base_sha).not.toBe(git(dir, "rev-parse", "main"));
  });

  test("a worker branches from its feature's head and ends with merge", () => {
    const { dir, e } = setup();
    const f = feature(e, dir);
    git(f.task.cwd, "commit", "--allow-empty", "-m", "on the feature");
    const head = git(f.task.cwd, "rev-parse", "HEAD");
    const w = startTask(e, {
      title: "Parser", type: "feature", goal: "g", done_check: "d", actor: { session_id: "s1", agent_id: "w1" },
      cwd: dir, worktree: true, parent_task_id: f.task.id, area: ["src/parser"], group: "g1",
    });
    expect(w.task.base_sha).toBe(head);
    expect(w.task.branch).toBe(`task/${w.task.id}-parser`);
    expect(w.task.parent_id).toBe(f.task.id);
    expect(w.task.task_group).toBe("g1");
    expect(w.steps.map((s) => s.name)).toEqual(["plan", "reuse_check", "implement", "test", "verify", "review", "merge"]);
    expect(e.db.prepare("SELECT path FROM task_areas WHERE task_id = ?").all(w.task.id)).toEqual([{ path: "src/parser" }]);
    expect(e.db.prepare("SELECT role FROM task_bindings WHERE task_id = ?").get(w.task.id)).toEqual({ role: "worker" });
  });

  test("a worker needs an open parent", () => {
    const { dir, e } = setup();
    const start = (parent: number) => () => startTask(e, { title: "w", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, worktree: true, parent_task_id: parent });
    expect(code(start(99))).toBe("NO_TASK");
    const f = feature(e, dir);
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.task.id);
    expect(code(start(f.task.id))).toBe("TASK_CLOSED");
  });

  test("without worktree the task starts as today but records parent, area and group", () => {
    const { dir, e } = setup();
    const f = feature(e, dir);
    const v = startTask(e, { title: "sub", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, parent_task_id: f.task.id, area: ["a", "b"], group: "grp" });
    expect(v.task).toMatchObject({ cwd: f.task.cwd, branch: f.task.branch, parent_id: f.task.id, task_group: "grp" });
    expect(v.steps.at(-1)?.name).toBe("pr");
    expect(e.db.prepare("SELECT path FROM task_areas WHERE task_id = ? ORDER BY path").all(v.task.id)).toEqual([{ path: "a" }, { path: "b" }]);
  });

  test("git ignores the worktrees folder without a tracked change", () => {
    const { dir, e } = setup();
    const before = git(dir, "status", "--porcelain");
    feature(e, dir, "one");
    feature(e, dir, "two");
    expect(git(dir, "status", "--porcelain")).toBe(before);
    expect(git(dir, "status", "--porcelain", "--untracked-files=all")).not.toContain("worktrees");
    const exclude = readFileSync(join(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".estack/worktrees/")).toHaveLength(1);
  });

  test("worktree_setup runs in the new worktree, and its failure is reported", () => {
    const ok = setup("touch ok");
    const v = feature(ok.e, ok.dir);
    expect(existsSync(join(v.task.cwd, "ok"))).toBe(true);
    expect(v.setup).toMatchObject({ ok: true });

    const bad = setup("echo boom; exit 3");
    const b = feature(bad.e, bad.dir);
    expect(b.setup?.ok).toBe(false);
    expect(b.setup?.output_tail).toContain("boom");
    expect(getTask(bad.e, b.task.id).task.status).toBe("open");
    expect(bad.e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'worktree_setup_failed'").get()).toEqual({ c: 1 });
  });

  test("a failed worktree leaves no open task", () => {
    const { dir, e } = setup();
    git(dir, "branch", "feat/1-add-invoice-totals");
    expect(code(() => feature(e, dir))).toBe("NOT_A_REPO");
    expect(e.db.prepare("SELECT status FROM tasks WHERE id = 1").get()).toEqual({ status: "cancelled" });
    expect(e.db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'open'").get()).toEqual({ c: 0 });
    expect(e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'worktree_failed'").get()).toEqual({ c: 1 });
  });

  test("removeWorktree keeps a dirty worktree and removes a clean one", () => {
    const { dir, e } = setup();
    const v = feature(e, dir);
    writeFileSync(join(v.task.cwd, "scratch.txt"), "wip");
    expect(removeWorktree(e, v.task)).toBe("kept");
    expect(existsSync(v.task.cwd)).toBe(true);
    execFileSync("rm", [join(v.task.cwd, "scratch.txt")]);
    expect(removeWorktree(e, v.task)).toBe("removed");
    expect(existsSync(v.task.cwd)).toBe(false);
    expect(git(dir, "branch", "--list", v.task.branch)).toBe("");
    expect(removeWorktree(e, v.task)).toBe("missing");
  });

  test("removeWorktree keeps an unmerged branch", () => {
    const { dir, e } = setup();
    const v = feature(e, dir);
    git(v.task.cwd, "commit", "--allow-empty", "-m", "unmerged");
    expect(removeWorktree(e, v.task)).toBe("removed");
    expect(git(dir, "branch", "--list", v.task.branch)).toContain(v.task.branch);
  });

  test("start_task with task_id promotes a planned task and refuses others", () => {
    const { dir, e } = setup();
    const ins = (status: string) => Number(e.db.prepare(
      "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at) VALUES ('Planned one', 'feature', 'g', 'd', ?, '', '', '', 's1/main', 'now')",
    ).run(status).lastInsertRowid);
    const planned = ins("planned");
    own(e, planned);
    const v = startTask(e, { title: "x", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, worktree: true, task_id: planned });
    expect(v.task).toMatchObject({ id: planned, status: "open", title: "Planned one", branch: `feat/${planned}-planned-one` });
    expect(v.steps).toHaveLength(7);
    expect(code(() => startTask(e, { title: "x", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, task_id: planned }))).toBe("TASK_CLOSED");
    expect(code(() => startTask(e, { title: "x", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, task_id: 99 }))).toBe("NO_TASK");
  });

  test("start_task with only task_id promotes a planned task", () => {
    const { dir, e } = setup();
    const id = Number(e.db.prepare(
      "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at) VALUES ('Only id', 'feature', 'g', 'd', 'planned', '', '', '', 's1/main', 'now')",
    ).run().lastInsertRowid);
    own(e, id);
    const v = startTask(e, { actor: cto, cwd: dir, worktree: true, task_id: id });
    expect(v.task).toMatchObject({ id, status: "open", title: "Only id", branch: `feat/${id}-only-id` });
    expect(code(() => startTask(e, { actor: cto, cwd: dir, title: "t" }))).toBe("POLICY_INVALID");
  });

  test("removeWorktree keeps a feature that holds a dirty nested worker worktree", () => {
    const { dir, e } = setup();
    const f = feature(e, dir);
    const w = startTask(e, { title: "w", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id });
    writeFileSync(join(w.task.cwd, "dirty.txt"), "wip");
    expect(removeWorktree(e, f.task)).toBe("kept");
    expect(existsSync(join(w.task.cwd, "dirty.txt"))).toBe(true);
    expect(e.db.prepare("SELECT payload_json p FROM events WHERE kind = 'worktree_kept'").get()).toMatchObject({ p: expect.stringContaining("nested worktrees") });
  });

  test("removeWorktree deletes a worker branch merged into its feature", () => {
    const { dir, e } = setup();
    const f = feature(e, dir);
    const w = startTask(e, { title: "w", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id });
    git(w.task.cwd, "commit", "--allow-empty", "-m", "worker work");
    git(f.task.cwd, "merge", "--no-ff", "-m", "merge", w.task.branch);
    expect(removeWorktree(e, w.task)).toBe("removed");
    expect(git(dir, "branch", "--list", w.task.branch)).toBe("");
  });

  test("removeWorktree reports a task with no cwd as missing before any other check", () => {
    const { e } = setup();
    expect(removeWorktree(e, { id: 1, cwd: "", branch: "", parent_id: null } as any)).toBe("missing");
    expect(e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'worktree_kept'").get()).toEqual({ c: 0 });
  });

  test("removeWorktree keeps the worktree when git cannot list worktrees", () => {
    const { dir, e } = setup();
    const v = feature(e, dir);
    const failing = { run: (file: string, args: string[], opts: any) =>
      file === "git" && args[0] === "worktree" && args[1] === "list" ? { code: 1, stdout: "", stderr: "boom", timedOut: false, durationMs: 0 } : realExec.run(file, args, opts),
      shell: realExec.shell };
    e.exec = failing as any;
    expect(removeWorktree(e, v.task)).toBe("kept");
    expect(existsSync(v.task.cwd)).toBe(true);
    expect(e.db.prepare("SELECT payload_json p FROM events WHERE kind = 'worktree_kept'").get()).toMatchObject({ p: expect.stringContaining("could not list worktrees") });
  });

  test("removeWorktree never removes a worktree the user made", () => {
    const { dir, e } = setup();
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-user-"))), "wt");
    git(dir, "worktree", "add", "-b", "mine", wt);
    const v = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: wt });
    expect(removeWorktree(e, v.task)).toBe("kept");
    expect(existsSync(wt)).toBe(true);
  });

  test("a feature branch has no upstream", () => {
    const { dir, e } = setup();
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "estack-origin-")));
    git(bare, "init", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "origin", "main");
    const v = feature(e, dir);
    expect(v.task.base_sha).toBe(git(dir, "rev-parse", "origin/main"));
    expect(() => git(v.task.cwd, "rev-parse", "--abbrev-ref", `${v.task.branch}@{upstream}`)).toThrow();
  });

  test("a timed-out fetch is ignored", () => {
    const dir = makeRepo();
    initRepo(dir);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "estack-origin-")));
    git(bare, "init", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "origin", "main");
    const exec = {
      ...fakeExec({}),
      run: (file: string, args: string[], opts: Parameters<typeof realExec.run>[2]) =>
        args[0] === "fetch" ? { code: null, stdout: "", stderr: "", timedOut: true, durationMs: 0 } : realExec.run(file, args, opts),
    };
    const v = feature(openEngine(dir, { exec }), dir);
    expect(v.task.status).toBe("open");
  });

  test("a throw after the worktree exists leaves no open task and no cwd", () => {
    const dir = makeRepo();
    initRepo(dir);
    const exec = {
      ...fakeExec({}),
      run: (file: string, args: string[], opts: Parameters<typeof realExec.run>[2]) =>
        args[0] === "rev-parse" && args[1] === "HEAD" ? { code: null, stdout: "", stderr: "", timedOut: true, durationMs: 0 } : realExec.run(file, args, opts),
    };
    const e = openEngine(dir, { exec });
    expect(() => feature(e, dir)).toThrow();
    expect(e.db.prepare("SELECT status, cwd, branch FROM tasks WHERE id = 1").get()).toEqual({ status: "cancelled", cwd: "", branch: "" });
    expect(e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'worktree_failed'").get()).toEqual({ c: 1 });
  });

  test("a planned task takes its parent and group from the row only", () => {
    const { dir, e } = setup();
    const f = feature(e, dir);
    const id = Number(e.db.prepare(
      "INSERT INTO tasks (title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at) VALUES ('P', 'feature', 'g', 'd', 'planned', '', '', '', 's1/main', 'now')",
    ).run().lastInsertRowid);
    own(e, id);
    const v = startTask(e, { actor: cto, cwd: dir, worktree: true, task_id: id, parent_task_id: f.task.id, group: "x" });
    expect(v.task).toMatchObject({ parent_id: null, task_group: null });
    expect(v.task.branch).toBe(`feat/${id}-p`);
  });
});
