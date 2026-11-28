import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { allowEdit, checkEdit, keptWorktrees } from "../src/claims";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { recordOutcomes } from "../src/outcomes";
import { completeStep, startTask } from "../src/tasks";
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
