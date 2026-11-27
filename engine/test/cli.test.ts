import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { openEngine } from "../src/engine";
import { getTask, startTask } from "../src/tasks";
import { makeRepo } from "./helpers";

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  let out = "", err = "";
  const status = main(args, { cwd, env, out: (s) => (out += s), err: (s) => (err += s) });
  return { status, out, err };
}
function setup() {
  const dir = makeRepo();
  expect(run(dir, ["init"]).status).toBe(0);
  const e = openEngine(dir);
  const t = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: "s" }, cwd: dir });
  return { dir, e, id: t.task.id };
}

describe("cli", () => {
  test("outside an opted-in repo every command prints one line and exits 1", () => {
    const dir = makeRepo();
    const r = run(dir, ["status"]);
    expect(r.status).toBe(1);
    expect(r.err).toBe("estack: not an estack repository: run /estack:setup\n");
  });

  test("init then status shows no open tasks", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    const r = run(dir, ["status"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("no open tasks");
  });

  test("skip under CLAUDECODE=1 is refused as owner-only", () => {
    const { dir, id } = setup();
    const r = run(dir, ["skip", "--task", String(id), "--step", "plan", "--reason", "x"], { CLAUDECODE: "1" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("normal terminal");
  });

  test("skip from a normal terminal marks the step skipped and logs an event", () => {
    const { dir, id } = setup();
    const r = run(dir, ["skip", "--task", String(id), "--step", "plan", "--reason", "not needed"]);
    expect(r.status).toBe(0);
    const e = openEngine(dir);
    expect(getTask(e, id).steps.find((s) => s.name === "plan")!.status).toBe("skipped");
    const ev = e.db.prepare("SELECT payload_json FROM events WHERE kind='step_skipped'").get() as { payload_json: string };
    expect(ev.payload_json).toContain("not needed");
  });

  test("cancel closes the task", () => {
    const { dir, id } = setup();
    expect(run(dir, ["cancel", "--task", String(id), "--reason", "r"]).status).toBe(0);
    expect(getTask(openEngine(dir), id).task.status).toBe("cancelled");
  });

  test("override writes an approvals row with decision override", () => {
    const { dir } = setup();
    expect(run(dir, ["override", "git_push", "--reason", "ok"]).status).toBe(0);
    const db = openEngine(dir).db;
    const row = db.prepare("SELECT action, command, decision FROM approvals").get() as { action: string; command: string; decision: string };
    expect(row).toEqual({ action: "git_push", command: "", decision: "override" });
    const ev = db.prepare("SELECT payload_json FROM events WHERE kind='override'").get() as { payload_json: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ action: "git_push", reason: "ok" });
  });

  test("C4 override of an unknown action exits 1 and names the valid ones", () => {
    const { dir } = setup();
    const r = run(dir, ["override", "push", "--reason", "x"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("unknown action push");
    expect(r.err).toContain("git_push");
    expect(openEngine(dir).db.prepare("SELECT COUNT(*) c FROM approvals").get()).toEqual({ c: 0 });
  });

  test("unknown command exits 2 with usage", () => {
    const dir = makeRepo();
    const r = run(dir, ["bogus"]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("usage");
  });
  test("an internal error prints one line with no stack and exits 1", () => {
    const dir = makeRepo();
    expect(run(dir, ["init"]).status).toBe(0);
    for (const f of ["state.db", "state.db-wal", "state.db-shm"]) rmSync(join(dir, ".estack", f), { force: true });
    mkdirSync(join(dir, ".estack", "state.db"));
    const r = run(dir, ["status"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^estack: internal error: [^\n]+\n$/);
  });
  test("run exits 0 when the check passes and 3 when it ran but failed", () => {
    for (const [cmd, status] of [["true", 0], ["exit 4", 3]] as const) {
      const { dir, e, id } = setup();
      const p = join(dir, ".estack", "policy.yaml");
      writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, `  test: "${cmd}"`));
      for (const s of ["plan", "reuse_check", "implement"]) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, s);
      const r = run(dir, ["run", "--task", String(id), "--step", "test"]);
      expect(r.status, r.err).toBe(status);
    }
  });
});

describe("cli hook", () => {
  test("pre-tool-use reads stdin and prints a deny for a code edit with no task", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    let out = "", err = "";
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: dir, tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    const status = main(["hook", "pre-tool-use"], { cwd: dir, env: {}, out: (s) => (out += s), err: (s) => (err += s), stdin });
    expect(status).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("invalid stdin: deny for pre-tool-use, nothing for others", () => {
    const dir = makeRepo();
    const go = (name: string) => {
      let out = "";
      const status = main(["hook", name], { cwd: dir, env: {}, out: (s) => (out += s), err: () => {}, stdin: "not json" });
      return { status, out };
    };
    const a = go("pre-tool-use");
    expect(a.status).toBe(0);
    expect(JSON.parse(a.out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(go("stop")).toEqual({ status: 0, out: "" });
  });
});
