import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { completeStep, getTask, startTask, type EvidenceInput } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { fakeExec, makeRepo } from "./helpers";

const cto: Actor = { session_id: "s1" };
const worker: Actor = { session_id: "s1", agent_id: "w1" };
const reviewer: Actor = { session_id: "s1", agent_id: "r1" };
const PR = "https://github.com/o/r/pull/1";

function setup(gh: Record<string, { code: number }> = {}) {
  const dir = makeRepo();
  initRepo(dir);
  const e = openEngine(dir, { exec: fakeExec(gh) });
  return { dir, e };
}
const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
const note = (text = "ok"): EvidenceInput => ({ kind: "note", text });
const start = (e: Engine, dir: string, type = "feature") =>
  startTask(e, { title: "t", type, goal: "g", done_check: "d", actor: cto, cwd: dir });
const done = (e: Engine, id: number, step: string, ev: EvidenceInput = note(), actor = cto) =>
  completeStep(e, { task_id: id, step, evidence: ev, actor });
const code = (fn: () => unknown) => { try { fn(); } catch (x) { return x as EngineError; } throw new Error("did not throw"); };
const events = (e: Engine) => (e.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
function commit(dir: string): string {
  git(dir, "commit", "--allow-empty", "-m", "work");
  return git(dir, "rev-parse", "HEAD");
}
/** Advance a feature task through plan and reuse_check. */
function toImplement(e: Engine, dir: string) {
  const t = start(e, dir);
  done(e, t.task.id, "plan"); done(e, t.task.id, "reuse_check");
  return t.task.id;
}
/** Mark steps done directly, to reach later steps without running checks. */
function force(e: Engine, id: number, names: string[]) {
  for (const n of names) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, n);
}

describe("tasks", () => {
  test("startTask creates the policy's steps in order and binds the actor", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    expect(t.steps.map((s) => s.name)).toEqual(e.policy.task_types.feature);
    expect(t.next?.name).toBe("plan");
    expect(t.task.branch).toBe("main");
    const rows = e.db.prepare("SELECT role FROM task_bindings").all() as { role: string }[];
    expect(rows).toEqual([{ role: "cto" }]);
  });

  test("an unknown task type is POLICY_INVALID", () => {
    const { dir, e } = setup();
    expect(code(() => start(e, dir, "nope")).code).toBe("POLICY_INVALID");
  });

  test("completing the wrong step is OUT_OF_ORDER and names the expected step", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    const err = code(() => done(e, t.task.id, "implement"));
    expect(err.code).toBe("OUT_OF_ORDER");
    expect(err.message).toContain("plan");
  });

  test("a note completes a note step", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    const v = done(e, t.task.id, "plan");
    expect(v.next?.name).toBe("reuse_check");
  });

  test("a blank note is BAD_EVIDENCE", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    expect(code(() => done(e, t.task.id, "plan", note("   "))).code).toBe("BAD_EVIDENCE");
  });

  test("a command step cannot be completed by hand", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    force(e, t.task.id, ["plan", "reuse_check", "implement"]);
    const err = code(() => done(e, t.task.id, "test", note()));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain("run_check");
  });

  test("a commit on the task branch is accepted", () => {
    const { dir, e } = setup();
    const id = toImplement(e, dir);
    const sha = commit(dir);
    const v = done(e, id, "implement", { kind: "commit", sha }, worker);
    expect(v.next?.name).toBe("test");
  });

  test("a nonexistent sha is BAD_EVIDENCE", () => {
    const { dir, e } = setup();
    const id = toImplement(e, dir);
    const err = code(() => done(e, id, "implement", { kind: "commit", sha: "deadbeef".repeat(5) }, worker));
    expect(err.code).toBe("BAD_EVIDENCE");
  });

  test("a commit not on the task branch is BAD_EVIDENCE", () => {
    const { dir, e } = setup();
    const id = toImplement(e, dir);
    git(dir, "checkout", "-b", "other");
    const sha = commit(dir);
    git(dir, "checkout", "main");
    expect(code(() => done(e, id, "implement", { kind: "commit", sha }, worker)).code).toBe("BAD_EVIDENCE");
  });

  test("a pr is accepted only when gh pr view succeeds", () => {
    const key = `pr view ${PR} --json url`;
    const bad = setup({ [key]: { code: 1 } });
    let id = start(bad.e, bad.dir).task.id;
    force(bad.e, id, ["plan", "reuse_check", "implement", "test", "verify", "review"]);
    expect(code(() => done(bad.e, id, "pr", { kind: "pr", url: PR })).code).toBe("BAD_EVIDENCE");
    const good = setup({ [key]: { code: 0 } });
    id = start(good.e, good.dir).task.id;
    force(good.e, id, ["plan", "reuse_check", "implement", "test", "verify", "review"]);
    const v = done(good.e, id, "pr", { kind: "pr", url: PR });
    expect(v.task.status).toBe("done");
  });

  test("a pr url that could be a gh option or is not a pull request url is BAD_EVIDENCE and gh is not called", () => {
    const dir = makeRepo();
    initRepo(dir);
    const calls: string[][] = [];
    const inner = fakeExec({});
    const e = openEngine(dir, { exec: { ...inner, run: (f, a, o) => { if (f === "gh") calls.push(a); return inner.run(f, a, o); } } });
    const id = start(e, dir).task.id;
    force(e, id, ["plan", "reuse_check", "implement", "test", "verify", "review"]);
    for (const url of ["--help", "--web", "https://github.com/o/r/issues/1", "http://github.com/o/r/pull/1", "https://github.com/o/r/pull/x"]) {
      expect(code(() => done(e, id, "pr", { kind: "pr", url })).code).toBe("BAD_EVIDENCE");
    }
    expect(calls).toEqual([]);
  });

  test("a branch name starting with a dash is refused at startTask", () => {
    const { dir, e } = setup();
    const err = code(() => startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, branch: "--orphan" }));
    expect(err.code).toBe("POLICY_INVALID");
  });

  function toReview() {
    const { dir, e } = setup();
    const id = toImplement(e, dir);
    done(e, id, "implement", { kind: "commit", sha: commit(dir) }, worker);
    force(e, id, ["test", "verify"]);
    return { e, id };
  }

  test("the author cannot review their own work", () => {
    const { e, id } = toReview();
    const err = code(() => done(e, id, "review", { kind: "review", verdict: "approve", findings: "" }, worker));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain("different agent");
  });

  test("a different agent's approval completes review", () => {
    const { e, id } = toReview();
    const changes = code(() => done(e, id, "review", { kind: "review", verdict: "changes", findings: "x" }, reviewer));
    expect(changes.code).toBe("BAD_EVIDENCE");
    const v = done(e, id, "review", { kind: "review", verdict: "approve", findings: "" }, reviewer);
    expect(v.next?.name).toBe("pr");
  });

  test("finishing the last step closes the task, and a closed task is TASK_CLOSED", () => {
    const { dir, e } = setup();
    const t = start(e, dir, "spike");
    done(e, t.task.id, "explore");
    const v = done(e, t.task.id, "report");
    expect(v.task.status).toBe("done");
    expect(v.next).toBeNull();
    expect(code(() => done(e, t.task.id, "report")).code).toBe("TASK_CLOSED");
    expect(code(() => getTask(e, 999)).code).toBe("NO_TASK");
  });

  test("every successful mutation logs one event", () => {
    const { dir, e } = setup();
    const e0 = events(e);
    const t = start(e, dir);
    expect(events(e)).toBe(e0 + 1);
    done(e, t.task.id, "plan");
    expect(events(e)).toBe(e0 + 2);
    code(() => done(e, t.task.id, "plan"));
    expect(events(e)).toBe(e0 + 2);
  });
});
