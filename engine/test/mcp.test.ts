import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { runHook } from "../src/hooks";
import { createServer } from "../src/mcp";
import { initRepo } from "../src/policy";
import { fakeExec, makeRepo, writeFakeGraph } from "./helpers";

const PR = "https://github.com/o/r/pull/1";
const A = { session_id: "s1", agent_id: "A" };
const B = { session_id: "s1", agent_id: "B" };

async function connect(cwd: string, gh: Record<string, { code: number; stdout?: string }> = {}) {
  const server = createServer(cwd, { exec: fakeExec(gh) });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: r.isError === true, text: r.content[0].text };
  };
  return { client, call };
}

function initedRepo(): string {
  const dir = makeRepo();
  initRepo(dir);
  const p = join(dir, ".estack", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, '  test:   "true"').replace(/^ {2}verify:.*$/m, '  verify: "true"'));
  return dir;
}

describe("mcp server", () => {
  test("lists exactly the thirteen tools", async () => {
    const { client } = await connect(initedRepo());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["accept_overlap", "complete_step", "context_for", "dismiss_duplicate", "find_existing", "handover", "plan_tasks", "resume", "run_check", "start_task", "status", "who_uses", "withdraw_task"]);
  });

  test("dismiss_duplicate by the author is refused", async () => {
    const dir = initedRepo();
    const { call } = await connect(dir);
    const id = JSON.parse((await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", cwd: dir, actor: A })).text).task.id;
    const db = new DatabaseSync(join(dir, ".estack", "state.db"));
    try {
      db.prepare("INSERT INTO duplicates (task_id, commit_sha, new_symbol, new_file, new_line, existing_symbol, existing_file, existing_line, status, found_at) VALUES (?, 'x', 'f', 'a.ts', 1, 'f', 'b.ts', 1, 'open', 'now')").run(id);
    } finally { db.close(); }
    const r = await call("dismiss_duplicate", { duplicate_id: 1, reason: "fine", actor: A });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^BAD_EVIDENCE: the task's author can't dismiss/);
    const ok = await call("dismiss_duplicate", { duplicate_id: 1, reason: "fine", actor: B });
    expect(ok.isError, ok.text).toBe(false);
    expect(JSON.parse(ok.text).status).toBe("dismissed");
  });

  test("code-map tools say the map is off", async () => {
    const { call } = await connect(initedRepo());
    for (const [tool, args] of [["context_for", { area: "src" }], ["find_existing", { description: "format dates" }], ["who_uses", { symbol: "x" }]] as const) {
      const r = await call(tool, { ...args, actor: A });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^MAP_OFF: /);
    }
  });

  describe("with the map on", () => {
    const mapRepo = (graph = true) => {
      const dir = initedRepo();
      const p = join(dir, ".estack", "policy.yaml");
      writeFileSync(p, readFileSync(p, "utf8").replace("enabled: false", "enabled: true"));
      if (graph) writeFakeGraph(dir, [{ id: "f", label: "fmt()", source_file: "src/a.ts", source_location: "L3" }], []);
      return dir;
    };
    const rows = (dir: string) => {
      const db = new DatabaseSync(join(dir, ".estack", "state.db"));
      try { return db.prepare("SELECT * FROM code_queries ORDER BY id").all() as Record<string, unknown>[]; } finally { db.close(); }
    };

    test("no graph for checkout", async () => {
      const dir = mapRepo(false);
      const { call } = await connect(dir);
      const r = await call("context_for", { area: "src", actor: A });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^MAP_BROKEN: /);
      expect(r.text).toContain("estack map update");
      const q = rows(dir);
      expect(q).toHaveLength(1);
      expect(q[0].ok).toBe(0);
      expect(q[0].graph_version).toBeNull();
    });

    test("context_for logs a code_queries row for the caller's task", async () => {
      const dir = mapRepo();
      const { call } = await connect(dir);
      const started = await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", cwd: dir, actor: A });
      const id = JSON.parse(started.text).task.id;
      const r = await call("context_for", { area: "src", cwd: dir, actor: A });
      expect(r.isError, r.text).toBe(false);
      expect(JSON.parse(r.text).defines[0].symbol).toBe("fmt");
      const q = rows(dir).filter((x) => x.auto === 0);
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({ task_id: id, tool: "context_for", recorded_by: "s1/A", ok: 1, auto: 0, checkout: dir, graph_version: "0.9.121@abc1234" });
    });

    test("start_task with an area returns that area's context and logs it as automatic", async () => {
      const dir = mapRepo();
      const { call } = await connect(dir);
      const r = await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", area: "src", cwd: dir, actor: A });
      expect(r.isError, r.text).toBe(false);
      const out = JSON.parse(r.text);
      expect(out.task.id).toBeGreaterThan(0);
      expect(out.context.area).toBe("src");
      const q = rows(dir);
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({ task_id: out.task.id, auto: 1, ok: 1, recorded_by: "s1/A" });
    });

    test("start_task without an area asks for context_for", async () => {
      const { call } = await connect(mapRepo());
      const out = JSON.parse((await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", actor: A })).text);
      expect(out.map_note).toMatch(/call context_for/);
    });
  });

  test("not opted in returns isError with NOT_OPTED_IN text, server keeps working", async () => {
    const { call } = await connect(makeRepo());
    const r = await call("status", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^NOT_OPTED_IN: /);
    expect((await call("status", {})).isError).toBe(true);
  });

  test("drives a feature task end to end", async () => {
    const dir = initedRepo();
    const { call } = await connect(dir, { [`pr view ${PR} --json headRefName`]: { code: 0, stdout: '{"headRefName":"main"}' } });
    const started = await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", actor: A });
    expect(started.isError).toBe(false);
    const id = JSON.parse(started.text).task.id;
    const step = async (s: string, evidence: unknown, actor = A) => {
      const r = await call("complete_step", { task_id: id, step: s, evidence, actor });
      expect(r.isError, r.text).toBe(false);
    };
    await step("plan", { kind: "note", text: "plan" });
    await step("reuse_check", { kind: "note", text: "nothing to reuse" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: dir, stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    await step("implement", { kind: "commit", sha });
    for (const s of ["test", "verify"]) {
      const r = await call("run_check", { task_id: id, step: s, actor: A });
      expect(r.isError, r.text).toBe(false);
      expect(JSON.parse(r.text).check.ok).toBe(true);
    }
    await step("review", { kind: "review", verdict: "approve", findings: "fine" }, B);
    await step("pr", { kind: "pr", url: PR });
    const final = JSON.parse((await call("status", { task_id: id })).text);
    expect(final.task.status).toBe("done");
    expect(final.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
    expect(final.evidence).toHaveLength(7);
    expect(final.evidence.every((x: { ok: boolean }) => x.ok)).toBe(true);
  });

  test("an engine error comes back as isError, not a thrown exception", async () => {
    const { call } = await connect(initedRepo());
    const t = JSON.parse((await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d" })).text);
    const r = await call("complete_step", { task_id: t.task.id, step: "implement", evidence: { kind: "commit", sha: "abcd" } });
    expect(r.isError).toBe(true);
    expect(r.text.startsWith("OUT_OF_ORDER")).toBe(true);
  });

  test("start_task with worktree returns the worktree path", async () => {
    const dir = initedRepo();
    const { call } = await connect(dir);
    const r = await call("start_task", { title: "Totals", type: "feature", goal: "g", done_check: "d", worktree: true, area: ["src"], cwd: dir, actor: A });
    expect(r.isError, r.text).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.worktree_path).toBe(join(dir, ".estack", "worktrees", `${out.task.id}-totals`));
    expect(out.task).toMatchObject({ cwd: out.worktree_path, branch: `feat/${out.task.id}-totals` });
  });

  test("C6 start_task records the cwd it is given (a linked worktree)", async () => {
    const dir = initedRepo();
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-wt-"))), "wt");
    execFileSync("git", ["worktree", "add", "-b", "feat", wt], { cwd: dir, stdio: "ignore" });
    const { call } = await connect(dir);
    const r = await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", actor: A, cwd: wt });
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text).task).toMatchObject({ cwd: wt, branch: "feat" });
  });
  test("CTO handover in session s1, resume in s2: s2 gets goal and plan and can edit every task of s1", async () => {
    const dir = initedRepo();
    const { call } = await connect(dir);
    const s1 = { session_id: "s1" };
    const wts: string[] = [];
    const ids: number[] = [];
    for (const n of ["one", "two"]) {
      const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-wt-"))), "wt");
      execFileSync("git", ["worktree", "add", "-b", `feat-${n}`, wt], { cwd: dir, stdio: "ignore" });
      const r = await call("start_task", { title: n, type: "feature", goal: `goal ${n}`, done_check: "d", actor: s1, cwd: wt });
      expect(r.isError, r.text).toBe(false);
      wts.push(wt);
      ids.push(JSON.parse(r.text).task.id);
    }
    expect((await call("complete_step", { task_id: ids[0], step: "plan", evidence: { kind: "note", text: "p" }, actor: s1 })).isError).toBe(false);
    const h = await call("handover", {
      goal: "ship it", plan: ["UI later"], decisions: [{ what: "sqlite", why: "simple" }], actor: s1,
    });
    expect(h.isError, h.text).toBe(false);
    const saved = JSON.parse(h.text);
    expect(saved.kind).toBe("session");
    expect(saved.next).toBe("Handover saved. Tell the owner: run /clear; the new session will load this automatically.");

    const s2 = { session_id: "s2" };
    const r = await call("resume", { actor: s2 });
    expect(r.isError, r.text).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.handover.body.goal).toBe("ship it");
    expect(out.handover.body.plan).toEqual(["UI later"]);
    expect(out.views.map((v: { task: { id: number } }) => v.task.id).sort()).toEqual([...ids].sort());
    expect(out.instructions).toBe(
      `Re-read every file listed in the handover before changing anything; do not trust a summary of code. Goal: ship it. Next: #${ids[0]} reuse_check, #${ids[1]} plan.`);

    for (const [i, wt] of wts.entries()) {
      const ev = (sid: string) => ({
        hook_event_name: "PreToolUse", session_id: sid, cwd: wt, tool_name: "Write", tool_input: { file_path: join(wt, `x${i}.txt`) },
      });
      expect(runHook("pre-tool-use", ev("s2"), { exec: fakeExec({}) })).toBeNull();
      const denied = runHook("pre-tool-use", ev("s3"), { exec: fakeExec({}) }) as any;
      expect(denied?.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });

  test("handover refuses while a worker is mid-task and names it", async () => {
    const { call } = await connect(initedRepo());
    const t = JSON.parse((await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", actor: A })).text);
    const r = await call("handover", { goal: "g", actor: { session_id: "s1" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^BAD_EVIDENCE: /);
    expect(r.text).toContain(`#${t.task.id}`);
  });

  test("resume with nothing waiting is a NO_TASK tool error", async () => {
    const { call } = await connect(initedRepo());
    const r = await call("resume", { actor: { session_id: "s2" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^NO_TASK: /);
  });

  test("I2 resume with handover_id picks that handover", async () => {
    const dir = initedRepo();
    const { call } = await connect(dir);
    for (const sid of ["A", "C"]) {
      expect((await call("start_task", { title: sid, type: "feature", goal: "g", done_check: "d", actor: { session_id: sid }, cwd: dir })).isError).toBe(false);
    }
    const older = JSON.parse((await call("handover", { goal: "A goal", actor: { session_id: "A" } })).text);
    expect((await call("handover", { goal: "C goal", actor: { session_id: "C" } })).isError).toBe(false);
    const r = await call("resume", { handover_id: older.id, actor: { session_id: "N" } });
    expect(r.isError, r.text).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.handover.id).toBe(older.id);
    expect(out.instructions).toContain("Goal: A goal.");
    const again = await call("resume", { handover_id: older.id, actor: { session_id: "M" } });
    expect(again.text).toMatch(/^NO_TASK: /);
  });

  test("a worker is bound on its first edit, read or task tool call", async () => {
    const dir = initedRepo();
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "estack"], { cwd: dir });
    const { call } = await connect(dir);
    const cto = { session_id: "s1" };
    const f = JSON.parse((await call("start_task", { title: "Feat", type: "feature", goal: "g", done_check: "d", cwd: dir, worktree: true, actor: cto })).text).task;
    const id = JSON.parse((await call("start_task", { title: "Work", type: "feature", goal: "g", done_check: "d", cwd: f.cwd, worktree: true, parent_task_id: f.id, actor: cto })).text).task.id;
    const bindings = (task = id) => {
      const db = new DatabaseSync(join(dir, ".estack", "state.db"));
      try { return db.prepare("SELECT session_id, agent_id, role FROM task_bindings WHERE task_id = ? ORDER BY rowid").all(task); } finally { db.close(); }
    };
    expect(bindings()).toEqual([{ session_id: "s1", agent_id: null, role: "cto" }]);
    expect((await call("status", { task_id: id, actor: A })).isError).toBe(false);
    expect(bindings()).toEqual([{ session_id: "s1", agent_id: null, role: "cto" }, { session_id: "s1", agent_id: "A", role: "worker" }]);
    await call("status", { actor: B });
    expect(bindings()).toHaveLength(2);
    // A failing call binds nothing; an unrelated session is never bound; a feature takes no helper.
    expect((await call("status", { task_id: 999, actor: B })).text).toMatch(/^NO_TASK/);
    expect((await call("complete_step", { task_id: id, step: "plan", evidence: { kind: "note", text: " " }, actor: B })).isError).toBe(true);
    expect(bindings()).toHaveLength(2);
    expect((await call("status", { task_id: id, actor: { session_id: "stranger", agent_id: "Z" } })).isError).toBe(false);
    expect(bindings()).toHaveLength(2);
    expect((await call("status", { task_id: f.id, actor: B })).isError).toBe(false);
    expect(bindings(f.id)).toEqual([{ session_id: "s1", agent_id: null, role: "cto" }]);
  });
});
