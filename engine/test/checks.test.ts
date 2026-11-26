import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngine, type Engine } from "../src/engine";
import { runCheck } from "../src/checks";
import { initRepo } from "../src/policy";
import { getTask, startTask } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { makeRepo } from "./helpers";

const cto: Actor = { session_id: "s1" };

function writeCommands(dir: string, commands: Record<string, string>) {
  initRepo(dir);
  const p = join(dir, ".estack", "policy.yaml");
  const lines = Object.entries(commands).map(([k, v]) => `  ${k}: "${v}"`).join("\n");
  const text = readFileSync(p, "utf8").replace(/commands:[\s\S]*$/, `commands:\n${lines}\n`);
  writeFileSync(p, text);
}
function setup(commands: Record<string, string>, type = "feature") {
  const dir = makeRepo();
  writeCommands(dir, commands);
  const e = openEngine(dir);
  const t = startTask(e, { title: "t", type, goal: "g", done_check: "d", actor: cto, cwd: dir });
  return { e, id: t.task.id };
}
function force(e: Engine, id: number, names: string[]) {
  for (const n of names) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, n);
}
const code = (fn: () => unknown) => { try { fn(); } catch (x) { return x as EngineError; } throw new Error("did not throw"); };
const toTest = (e: Engine, id: number) => force(e, id, ["plan", "reuse_check", "implement"]);

describe("runCheck", () => {
  test("a passing test command completes the test step", () => {
    const { e, id } = setup({ test: "true" });
    toTest(e, id);
    const r = runCheck(e, { task_id: id, step: "test", actor: cto });
    expect(r.ok).toBe(true);
    const v = getTask(e, id);
    expect(v.steps.find((s) => s.name === "test")!.status).toBe("done");
    expect(v.evidence.at(-1)!.ok).toBe(true);
  });

  test("a failing command records evidence and leaves the step open", () => {
    const { e, id } = setup({ test: "exit 3" });
    toTest(e, id);
    const r = runCheck(e, { task_id: id, step: "test", actor: cto });
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(3);
    const v = getTask(e, id);
    expect(v.steps.find((s) => s.name === "test")!.status).not.toBe("done");
    expect(v.evidence.at(-1)!.ok).toBe(false);
  });

  test("a hanging command times out and is recorded as failed", () => {
    const { e, id } = setup({ test: "sleep 5" });
    toTest(e, id);
    const r = runCheck(e, { task_id: id, step: "test", actor: cto, timeout_ms: 300 });
    expect(r.timed_out).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBeNull();
    const v = getTask(e, id);
    expect(v.evidence.at(-1)!.payload.timed_out).toBe(true);
    expect(v.steps.find((s) => s.name === "test")!.status).not.toBe("done");
  });

  test("a command that ignores SIGTERM is still bounded by the timeout", () => {
    const { e, id } = setup({ test: "trap '' TERM; sleep 4" });
    toTest(e, id);
    const t0 = Date.now();
    const r = runCheck(e, { task_id: id, step: "test", actor: cto, timeout_ms: 300 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.timed_out).toBe(true);
    expect(r.ok).toBe(false);
  });

  test("the command comes from policy, not the caller", () => {
    const { e, id } = setup({ test: "echo hi" });
    toTest(e, id);
    runCheck(e, { task_id: id, step: "test", actor: cto });
    const ev = getTask(e, id).evidence.at(-1)!;
    expect(ev.payload.command).toBe(e.policy.commands.test);
    expect(String(ev.payload.output_tail)).toContain("hi");
  });

  test("missing commands.verify is POLICY_INVALID", () => {
    const { e, id } = setup({ test: "true" });
    force(e, id, ["plan", "reuse_check", "implement", "test"]);
    const err = code(() => runCheck(e, { task_id: id, step: "verify", actor: cto }));
    expect(err.code).toBe("POLICY_INVALID");
    expect(err.message).toBe("policy.yaml has no commands.verify");
  });

  test("run_check on a non-command step is BAD_EVIDENCE", () => {
    const { e, id } = setup({ test: "true" });
    expect(code(() => runCheck(e, { task_id: id, step: "plan", actor: cto })).code).toBe("BAD_EVIDENCE");
  });
  test("the command evidence records the tested HEAD sha", () => {
    const { e, id } = setup({ test: "true" });
    toTest(e, id);
    runCheck(e, { task_id: id, step: "test", actor: cto });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: e.repo.root, encoding: "utf8" }).trim();
    expect(getTask(e, id).evidence.at(-1)!.payload.head_sha).toBe(head);
  });

  test("run_check refuses when the task's worktree is on another branch", () => {
    const dir = makeRepo();
    writeCommands(dir, { test: "true" });
    execFileSync("git", ["branch", "feat-x"], { cwd: dir });
    const e = openEngine(dir);
    const id = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, branch: "feat-x" }).task.id;
    toTest(e, id);
    const err = code(() => runCheck(e, { task_id: id, step: "test", actor: cto }));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toBe(`worktree ${dir} is on main, task is on feat-x`);
    expect(getTask(e, id).evidence).toEqual([]);
  });

  test("a task started from a linked worktree records it and runs its check there", () => {
    const dir = makeRepo();
    writeCommands(dir, { test: "test -f only-in-worktree" });
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-wt-"))), "wt");
    execFileSync("git", ["worktree", "add", wt, "-b", "side"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(wt, "only-in-worktree"), "");
    const e = openEngine(wt);
    const t = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: cto });
    expect(t.task.cwd).toBe(wt);
    expect(t.task.branch).toBe("side");
    toTest(e, t.task.id);
    const r = runCheck(e, { task_id: t.task.id, step: "test", actor: cto });
    expect(r.ok, r.output_tail).toBe(true);
  });
});
