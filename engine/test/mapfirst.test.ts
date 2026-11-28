import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCodeQuery } from "../src/codemap";
import { openEngine } from "../src/engine";
import { runHook, type HookEvent } from "../src/hooks";
import { initRepo } from "../src/policy";
import { completeStep, startTask } from "../src/tasks";
import type { Actor } from "../src/types";
import { fakeExec, makeRepo, writeFakeGraph } from "./helpers";

const S = "sess-m";
const deps = { exec: fakeExec({}) };
const A: Actor = { session_id: S, agent_id: "worker-a" };
const B: Actor = { session_id: S, agent_id: "worker-b" };
const C: Actor = { session_id: S, agent_id: "reviewer-c" };

function setup(type = "feature", opts: { graph?: boolean } = {}) {
  const dir = makeRepo();
  initRepo(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export function alpha() {}\n");
  writeFileSync(join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "files"], { cwd: dir, stdio: "ignore" });
  const e = openEngine(dir, deps);
  const t = startTask(e, { title: "t", type, goal: "g", done_check: "d", actor: { session_id: S }, cwd: dir });
  e.db.close();
  const p = join(dir, ".estack", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("enabled: false", "enabled: true"));
  if (opts.graph !== false) {
    writeFakeGraph(dir, [{ id: "a", label: "a.ts", source_file: "src/a.ts", source_location: "L1" },
      { id: "al", label: "alpha()", source_file: "src/a.ts", source_location: "L1" }], []);
  }
  return { dir, id: t.task.id };
}
const read = (dir: string, actor: Actor, file = "src/a.ts") =>
  runHook("pre-tool-use", { hook_event_name: "PreToolUse", session_id: actor.session_id, cwd: dir, agent_id: actor.agent_id,
    tool_name: "Read", tool_input: { file_path: join(dir, file) } } as HookEvent, deps) as any;
const grep = (dir: string, actor: Actor, path?: string) =>
  runHook("pre-tool-use", { hook_event_name: "PreToolUse", session_id: actor.session_id, cwd: dir, agent_id: actor.agent_id,
    tool_name: "Grep", tool_input: { pattern: "alpha", ...(path ? { path } : {}) } } as HookEvent, deps) as any;
const reasonOf = (r: any) => r?.hookSpecificOutput?.permissionDecisionReason as string;
function search(dir: string, actor: Actor, id: number, auto = false) {
  const e = openEngine(dir, deps);
  try { runCodeQuery(e, { tool: "context_for", arg: "alpha", actor, cwd: dir, task_id: id, auto }); } finally { e.db.close(); }
}

describe("map first", () => {
  test("a worker's first read before reuse_check is denied once", () => {
    const { dir, id } = setup();
    const r = read(dir, A);
    expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reasonOf(r)).toContain("context_for");
    expect(reasonOf(r)).toContain(`task #${id}`);
    expect(reasonOf(r)).toContain("src/a.ts");
    expect(read(dir, A)).toBeNull();
  });

  test("after its own search the agent reads freely", () => {
    const { dir, id } = setup();
    search(dir, A, id);
    expect(read(dir, A)).toBeNull();
  });

  test("the automatic start_task context does not unlock it", () => {
    const { dir, id } = setup();
    search(dir, A, id, true);
    expect(read(dir, A).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("each agent gets its own denial", () => {
    const { dir } = setup();
    expect(read(dir, A).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(read(dir, B).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(read(dir, B)).toBeNull();
    expect(read(dir, A)).toBeNull();
  });

  test("past reuse_check nobody is denied", () => {
    const { dir, id } = setup();
    search(dir, A, id);
    const e = openEngine(dir, deps);
    completeStep(e, { task_id: id, step: "plan", evidence: { kind: "note", text: "p" }, actor: A });
    completeStep(e, { task_id: id, step: "reuse_check", evidence: { kind: "note", text: "r" }, actor: A });
    e.db.close();
    expect(read(dir, C)).toBeNull();
  });

  test("no graph means no map-first denial", () => {
    const { dir } = setup("feature", { graph: false });
    expect(read(dir, A)).toBeNull();
  });

  test("a file outside the map is never denied", () => {
    const { dir } = setup();
    expect(read(dir, A, "README.md")).toBeNull();
  });

  test("a task without reuse_check is never denied", () => {
    const { dir } = setup("spike");
    expect(read(dir, A)).toBeNull();
  });

  test("the map being off means no denial", () => {
    const { dir } = setup();
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("enabled: true", "enabled: false"));
    expect(read(dir, A)).toBeNull();
  });

  test("grep inside the checkout counts as a first read", () => {
    const { dir } = setup();
    expect(grep(dir, A, join(dir, "src")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(grep(dir, A, join(dir, "src"))).toBeNull();
    // Another agent is still denied at the root, so the null above came from the once-per-task record.
    expect(grep(dir, B).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a grep with no path is denied once", () => {
    const { dir } = setup();
    const r = grep(dir, A);
    expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reasonOf(r)).toContain("then read .");
    expect(grep(dir, A)).toBeNull();
  });

  test("a grep at the checkout root is denied once", () => {
    const { dir } = setup();
    expect(grep(dir, A, dir).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(grep(dir, A, dir)).toBeNull();
  });

  test("a session with no bound task is never denied", () => {
    const { dir } = setup();
    expect(read(dir, { session_id: "other", agent_id: "x" })).toBeNull();
  });

  /** The setup repo plus a feature worktree and a worker task under it, bound to the CTO session. */
  function withWorker() {
    const { dir } = setup();
    const e = openEngine(dir, deps);
    const f = startTask(e, { title: "Feat", type: "feature", goal: "g", done_check: "d", actor: { session_id: S }, cwd: dir, worktree: true });
    const w = startTask(e, { title: "Work", type: "feature", goal: "g", done_check: "d", actor: { session_id: S }, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id });
    e.db.close();
    return { dir, w: w.task };
  }
  const bindingsOf = (dir: string, id: number) => {
    const e = openEngine(dir, deps);
    try { return e.db.prepare("SELECT agent_id, role FROM task_bindings WHERE task_id = ? ORDER BY rowid").all(id); } finally { e.db.close(); }
  };

  test("a worker is bound on its first edit, read or task tool call", () => {
    const { dir, w } = withWorker();
    expect(bindingsOf(dir, w.id)).toEqual([{ agent_id: null, role: "cto" }]);
    read(w.cwd, A);
    expect(bindingsOf(dir, w.id)).toEqual([{ agent_id: null, role: "cto" }, { agent_id: "worker-a", role: "worker" }]);
    read(w.cwd, { session_id: "other", agent_id: "x" });
    expect(bindingsOf(dir, w.id)).toHaveLength(2);
  });

  test("a worker is bound by a read even with the code map off", () => {
    const { dir, w } = withWorker();
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("enabled: true", "enabled: false"));
    expect(read(w.cwd, A)).toBeNull();
    expect(bindingsOf(dir, w.id)).toEqual([{ agent_id: null, role: "cto" }, { agent_id: "worker-a", role: "worker" }]);
  });

  test("a helper reading in the CTO's checkout is not bound", () => {
    const { dir, id } = setup();
    // Bound to nothing, though that read is the one that is denied by map-first.
    expect(reasonOf(read(dir, A))).toContain("look at the code map");
    expect(bindingsOf(dir, id)).toEqual([{ agent_id: null, role: "cto" }]);
  });
});
