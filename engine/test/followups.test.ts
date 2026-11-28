import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { allowEdit, checkEdit, keptWorktrees } from "../src/claims";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { planTasks } from "../src/plan";
import { recordOutcomes } from "../src/outcomes";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp";
import { completeStep, insertEvidence, startTask } from "../src/tasks";
import type { Actor, Task } from "../src/types";
import type { Exec } from "../src/exec";
import { realExec } from "../src/exec";
import { fakeExec, makeRepo } from "./helpers";

const A: Actor = { session_id: "sa" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(): string {
  const dir = makeRepo();
  initRepo(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "estack");
  return dir;
}
const feature = (e: Engine, dir: string, title: string): Task =>
  startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor: A, cwd: dir, worktree: true }).task;
const worker = (e: Engine, f: Task, title: string, type = "feature"): Task =>
  startTask(e, { title, type, goal: "g", done_check: "d", actor: A, cwd: f.cwd, worktree: true, parent_task_id: f.id }).task;
const note = (e: Engine, id: number, step: string) => completeStep(e, { task_id: id, step, evidence: { kind: "note", text: "x" }, actor: A });

describe("F1 spike worker worktree", { timeout: 60_000 }, () => {
  test("a clean spike worker's worktree is removed when it closes", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: fakeExec({}) });
    const f = feature(e, dir, "feat");
    const w = worker(e, f, "spike w", "spike");
    expect(existsSync(w.cwd)).toBe(true);
    note(e, w.id, "explore");
    expect(existsSync(w.cwd)).toBe(true);
    note(e, w.id, "report");
    expect(existsSync(w.cwd)).toBe(false);
  });

  test("a dirty spike worker's worktree is kept and listed", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: fakeExec({}) });
    const f = feature(e, dir, "feat");
    const w = worker(e, f, "spike w", "spike");
    writeFileSync(join(w.cwd, "scratch.txt"), "wip");
    note(e, w.id, "explore");
    note(e, w.id, "report");
    expect(existsSync(w.cwd)).toBe(true);
    expect(keptWorktrees(e)).toEqual([{ task_id: w.id, title: "spike w", path: w.cwd, reason: "uncommitted changes" }]);
  });
});

function commitFile(t: Task, file: string, text: string): void {
  mkdirSync(dirname(join(t.cwd, file)), { recursive: true });
  writeFileSync(join(t.cwd, file), text);
  git(t.cwd, "add", "-A");
  git(t.cwd, "commit", "-m", `edit ${file}`);
}
/** t1 holds src/a.ts and t2 is allowed in; returns the grant id. */
function grant(e: Engine, t1: Task, t2: Task, path = "src/a.ts"): number {
  checkEdit(e, t1, path);
  allowEdit(e, { task_id: t2.id, path, reason: "needs it", actor: A, owner: false });
  return Number((e.db.prepare("SELECT id FROM claim_grants WHERE task_id = ? AND path = ?").get(t2.id, path) as { id: number }).id);
}
const outcome = (e: Engine, id: number) => (e.db.prepare("SELECT outcome FROM claim_grants WHERE id = ?").get(id) as { outcome: string | null }).outcome;
const stepsDone = (e: Engine, w: Task) => e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'merge'").run(w.id);
const mergeStep = (e: Engine, w: Task) => completeStep(e, { task_id: w.id, step: "merge", evidence: { kind: "merged" }, actor: A });

describe("F2 conflict outcome is written with the merge step", { timeout: 60_000 }, () => {
  test("a status call racing the merge step cannot record clean first", () => {
    const dir = repo();
    let inject: (() => void) | undefined;
    const exec: Exec = {
      run(file, args, opts) {
        // Fires on the first merge-commit lookup, whichever side of the step's transaction it runs on.
        if (file === "git" && args[0] === "rev-list" && args.includes("--merges") && inject) { const f = inject; inject = undefined; f(); }
        return realExec.run(file, args, opts);
      },
      shell: (c, o) => realExec.shell(c, o),
    };
    const e = openEngine(dir, { exec });
    const f = feature(e, dir, "feat");
    const w1 = worker(e, f, "w1");
    const w2 = worker(e, f, "w2");
    const g = grant(e, w1, w2);
    commitFile(w1, "src/a.ts", "one\n");
    commitFile(w2, "src/a.ts", "two\n");
    stepsDone(e, w1); stepsDone(e, w2);
    git(f.cwd, "merge", "--no-ff", "-m", "m1", w1.branch);
    mergeStep(e, w1);
    expect(() => git(f.cwd, "merge", "--no-ff", "-m", "m2", w2.branch)).toThrow();
    writeFileSync(join(f.cwd, "src/a.ts"), "one and two\n");
    git(f.cwd, "add", "src/a.ts");
    git(f.cwd, "commit", "--no-edit");
    inject = () => recordOutcomes(e, { remote: true });
    mergeStep(e, w2);
    expect(inject).toBeUndefined(); // the injection ran
    expect(outcome(e, g)).toBe("conflict");
  });
});

describe("F3 conflict involvement", { timeout: 60_000 }, () => {
  test("a cross-feature grant stays open when a sibling's change conflicts; the same-feature grant is a conflict", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: fakeExec({}) });
    const f = feature(e, dir, "feat");
    const other = feature(e, dir, "other");
    const w1 = worker(e, f, "w1");
    const w2 = worker(e, f, "w2");
    const cross = grant(e, w2, other, "src/a.ts");   // w2 holds a.ts, another feature is allowed in
    const same = grant(e, w1, w2, "src/b.ts");       // w1 holds b.ts, its sibling w2 is allowed in
    for (const w of [w1, w2]) { commitFile(w, "src/a.ts", `${w.id}\n`); commitFile(w, "src/b.ts", `${w.id}\n`); stepsDone(e, w); }
    git(f.cwd, "merge", "--no-ff", "-m", "m1", w1.branch);
    mergeStep(e, w1);
    expect(() => git(f.cwd, "merge", "--no-ff", "-m", "m2", w2.branch)).toThrow();
    for (const p of ["src/a.ts", "src/b.ts"]) { writeFileSync(join(f.cwd, p), "both\n"); git(f.cwd, "add", p); }
    git(f.cwd, "commit", "--no-edit");
    mergeStep(e, w2);
    expect(outcome(e, same)).toBe("conflict");
    expect(outcome(e, cross)).toBeNull();
  });
});

describe("F5 status asks once", { timeout: 60_000 }, () => {
  test("one fetch and one gh call per branch for syncMerged and the outcomes together", async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", join(dir, "nowhere.git"));
    const e0 = openEngine(dir, { exec: fakeExec({}) });
    const f1 = feature(e0, dir, "one");
    const f2 = feature(e0, dir, "two");
    const g = grant(e0, f1, f2);
    expect(g).toBeGreaterThan(0);
    for (const f of [f1, f2]) {
      commitFile(f, `src/${f.id}.ts`, "x\n");
      insertEvidence(e0, f.id, "implement", "commit", true, { sha: git(f.cwd, "rev-parse", "HEAD") }, A);
      e0.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.id);
    }
    const calls: string[] = [];
    const base = fakeExec({ [`pr view ${f1.branch} --json state`]: { code: 0, stdout: '{"state":"OPEN"}' }, [`pr view ${f2.branch} --json state`]: { code: 0, stdout: '{"state":"OPEN"}' } });
    const exec: Exec = {
      run(file, args, opts) {
        if ((file === "git" && args[0] === "fetch") || file === "gh") calls.push(`${file} ${args.join(" ")}`);
        return base.run(file, args, opts);
      },
      shell: (c, o) => base.shell(c, o),
    };
    const server = createServer(dir, { exec });
    const client = new Client({ name: "test", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({ name: "status", arguments: {} });
    expect(calls.filter((c) => c.startsWith("git fetch"))).toHaveLength(1);
    for (const f of [f1, f2]) expect(calls.filter((c) => c === `gh pr view ${f.branch} --json state`).length).toBeLessThanOrEqual(1);
  });
});

describe("F4 held_in_area warning", { timeout: 60_000 }, () => {
  const plan = (e: Engine, parent: Task, title: string, area: string[], group?: string) =>
    planTasks(e, { parent_task_id: parent.id, actor: A, tasks: [{ title, type: "feature", goal: "g", done_check: "d", area, group }] });

  test("plan_tasks lists files another feature holds inside the new task's areas, and not the family's", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: fakeExec({}) });
    const f1 = feature(e, dir, "one");
    const f2 = feature(e, dir, "two");
    checkEdit(e, f1, "src/a.ts");
    checkEdit(e, f2, "src/own.ts");
    checkEdit(e, f1, "docs/readme.md");
    const r = plan(e, f2, "plan w", ["src"]);
    expect(r.held_in_area).toEqual([{ path: "src/a.ts", task_id: f1.id, title: "one" }]);   // not f2's own file, not docs/
    expect(plan(e, f2, "far", ["lib"]).held_in_area).toEqual([]);
  });

  test("start_task lists them too, and still starts the task", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: fakeExec({}) });
    const f1 = feature(e, dir, "one");
    const f2 = feature(e, dir, "two");
    checkEdit(e, f1, "src/a.ts");
    const sibling = worker(e, f2, "sib");
    checkEdit(e, sibling, "src/sib.ts");
    const w = startTask(e, { title: "w", type: "feature", goal: "g", done_check: "d", actor: A, cwd: f2.cwd, parent_task_id: f2.id, area: ["src"], group: "g1" });
    expect(w.task.status).toBe("open");
    expect(w.held_in_area).toEqual([
      { path: "src/a.ts", task_id: f1.id, title: "one" },
      { path: "src/sib.ts", task_id: sibling.id, title: "sib" },   // another group: it would block the edit
    ]);
    const clear = startTask(e, { title: "x", type: "feature", goal: "g", done_check: "d", actor: A, cwd: f2.cwd, parent_task_id: f2.id, area: ["lib"] });
    expect(clear.held_in_area).toEqual([]);
  });
});
