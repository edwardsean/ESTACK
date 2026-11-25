import { describe, expect, test } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openEngine, type Engine } from "../src/engine";
import { runCheck } from "../src/checks";
import { initRepo } from "../src/policy";
import { getTask, startTask } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { makeRepo } from "./helpers";

const cto: Actor = { session_id: "s1" };

function setup(commands: Record<string, string>, type = "feature") {
  const dir = makeRepo();
  initRepo(dir);
  const p = join(dir, ".estack", "policy.yaml");
  const lines = Object.entries(commands).map(([k, v]) => `  ${k}: "${v}"`).join("\n");
  const text = readFileSync(p, "utf8").replace(/commands:[\s\S]*$/, `commands:\n${lines}\n`);
  writeFileSync(p, text);
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
    expect(getTask(e, id).evidence.at(-1)!.payload.timed_out).toBe(true);
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
});
