import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { allowEdit, checkEdit, keptWorktrees } from "../src/claims";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { completeStep, startTask } from "../src/tasks";
import type { Actor, Task } from "../src/types";
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
