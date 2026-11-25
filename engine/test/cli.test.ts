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
    const row = openEngine(dir).db.prepare("SELECT action, decision FROM approvals").get() as { action: string; decision: string };
    expect(row).toEqual({ action: "git_push", decision: "override" });
  });

  test("unknown command exits 2 with usage", () => {
    const dir = makeRepo();
    const r = run(dir, ["bogus"]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("usage");
  });
});
