import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openEngine } from "../src/engine";
import { runHook, type HookEvent } from "../src/hooks";
import { recordOverride } from "../src/owner";
import { initRepo } from "../src/policy";
import { startTask } from "../src/tasks";
import { fakeExec, makeRepo } from "./helpers";

const S = "sess-1";

function repo(): string {
  const dir = makeRepo();
  initRepo(dir);
  const p = join(dir, ".estack", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, '  test:   "true"').replace(/^ {2}verify:.*$/m, '  verify: "true"'));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "estack"], { cwd: dir, stdio: "ignore" });
  return dir;
}
const deps = { exec: fakeExec({}) };
const ev = (cwd: string, o: Partial<HookEvent>): HookEvent => ({ hook_event_name: "PreToolUse", session_id: S, cwd, ...o });
const pre = (cwd: string, o: Partial<HookEvent>) => runHook("pre-tool-use", ev(cwd, o), deps) as any;
const edit = (cwd: string, file: string, o: Partial<HookEvent> = {}) =>
  pre(cwd, { tool_name: "Edit", tool_input: { file_path: file }, ...o });
const bash = (cwd: string, command: string, o: Partial<HookEvent> = {}) =>
  pre(cwd, { tool_name: "Bash", tool_input: { command }, tool_use_id: "tu1", ...o });
const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision;
const reason = (r: any) => r?.hookSpecificOutput?.permissionDecisionReason as string;

function task(dir: string, session = S) {
  const e = openEngine(dir, deps);
  const t = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: session }, cwd: dir });
  e.db.close();
  return t.task.id;
}
function markVerifyDone(dir: string, id: number) {
  const e = openEngine(dir, deps);
  e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name='verify'").run(id);
  e.db.close();
}
function rows(dir: string, sql: string): any[] {
  const e = openEngine(dir, deps);
  try { return e.db.prepare(sql).all() as any[]; } finally { e.db.close(); }
}

describe("hooks", () => {
  test("not opted in: every hook returns null", () => {
    const dir = makeRepo();
    for (const n of ["pre-tool-use", "post-tool-use", "session-start", "user-prompt-submit", "stop", "subagent-stop"]) {
      expect(runHook(n, ev(dir, { tool_name: "Edit", tool_input: { file_path: "a.ts" } }), deps)).toBeNull();
    }
  });

  test("edit to an exempt path is allowed with no output", () => {
    const dir = repo();
    expect(edit(dir, "README.md")).toBeNull();
    expect(edit(dir, join(dir, "docs/x.md"))).toBeNull();
  });

  test("edit outside the repo is allowed with no output", () => {
    const dir = repo();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "estack-other-")));
    expect(edit(dir, join(other, "a.ts"))).toBeNull();
  });

  test("edit to a protected path is denied", () => {
    const dir = repo();
    for (const f of [".estack/policy.yaml", "api/.env"]) {
      const r = edit(dir, f);
      expect(decision(r)).toBe("deny");
      expect(reason(r)).toContain("is protected by .estack/policy.yaml");
    }
  });

  test("code edit with no task is denied and says start_task", () => {
    const dir = repo();
    const r = edit(dir, "src/a.ts");
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toContain("start_task");
    expect(reason(r)).toContain("src/a.ts");
  });

  test("code edit with an open task bound to this session is allowed", () => {
    const dir = repo();
    task(dir);
    expect(edit(dir, "src/a.ts")).toBeNull();
    expect(edit(dir, "src/new/dir/a.ts", { tool_name: "Write", tool_input: { file_path: join(dir, "src/new/dir/a.ts") } })).toBeNull();
    expect(edit(dir, "x", { tool_name: "NotebookEdit", tool_input: { notebook_path: "n.ipynb" } })).toBeNull();
  });

  test("a task bound to another session doesn't count", () => {
    const dir = repo();
    task(dir, "other");
    expect(decision(edit(dir, "src/a.ts"))).toBe("deny");
  });

  test("edits inside .git are denied as protected", () => {
    const dir = repo();
    for (const [tool, f] of [["Write", ".git/hooks/pre-push"], ["Edit", ".git/config"]]) {
      const r = edit(dir, join(dir, f), { tool_name: tool });
      expect(decision(r), f).toBe("deny");
      expect(reason(r)).toContain("protected");
    }
  });

  test("a write into a linked worktree's gitdir is denied", () => {
    const dir = repo();
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-wt-"))), "wt");
    execFileSync("git", ["worktree", "add", "-b", "feat", wt], { cwd: dir, stdio: "ignore" });
    const r = edit(dir, join(dir, ".git", "worktrees", "wt", "hooks", "pre-push"), { tool_name: "Write" });
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toContain("protected");
    expect(decision(edit(dir, join(wt, ".git"), { tool_name: "Write" }))).toBe("deny");
  });

  test("a git failure in the edit gate fails closed", () => {
    const dir = repo();
    for (const bad of [{ code: 1, stderr: "boom" }, { code: null, timedOut: true }]) {
      const exec = {
        run: (f: string, a: string[], o: any) => f === "git" && a[0] === "rev-parse"
          ? { stdout: "", stderr: "", timedOut: false, durationMs: 0, ...bad } : fakeExec({}).run(f, a, o),
        shell: fakeExec({}).shell,
      };
      const r = runHook("pre-tool-use", ev(dir, { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }), { exec }) as any;
      expect(decision(r)).toBe("deny");
      expect(reason(r).startsWith("estack: ")).toBe(true);
    }
  });

  test("plain bash is allowed with no output", () => {
    expect(bash(repo(), "ls -la")).toBeNull();
  });

  test("hard-coded denials apply to bash", () => {
    const dir = repo();
    for (const c of ["cat .estack/state.db", "estack override git_push --reason x", "git commit --no-verify -m x"]) {
      const r = bash(dir, c);
      expect(decision(r), c).toBe("deny");
      expect(reason(r)).toContain("blocked by estack");
    }
  });

  test("push from a worker is denied, not asked", () => {
    const r = bash(repo(), "git push origin main", { agent_id: "A" });
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toContain("runs only from the main session");
  });

  test("push with no task for the branch is denied", () => {
    const r = bash(repo(), "git push origin main");
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toContain("no estack task for branch main");
  });

  test("push before verify is denied and names run_check", () => {
    const dir = repo();
    const id = task(dir);
    const r = bash(dir, "git push origin main");
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toContain(`task #${id} has no verify evidence`);
    expect(reason(r)).toContain("run_check");
  });

  test("push after verify asks and records an ask event", () => {
    const dir = repo();
    const id = task(dir);
    markVerifyDone(dir, id);
    const r = bash(dir, "git push origin main");
    expect(decision(r)).toBe("ask");
    expect(reason(r)).toContain("git_push");
    const ev = rows(dir, "SELECT * FROM events WHERE kind='ask'");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload_json)).toMatchObject({ tool_use_id: "tu1", action: "git_push" });
  });

  test("an owner override lets exactly one push through to the ask prompt", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    recordOverride(e, { action: "git_push", reason: "r" }, {});
    e.db.close();
    expect(decision(bash(dir, "git push origin main", { tool_use_id: "a" }))).toBe("ask");
    expect(decision(bash(dir, "git push origin main", { tool_use_id: "b" }))).toBe("deny");
    expect(rows(dir, "SELECT * FROM events WHERE kind='override_used'")).toHaveLength(1);
  });

  test("post-tool-use after an ask records an approval", () => {
    const dir = repo();
    const id = task(dir);
    markVerifyDone(dir, id);
    bash(dir, "git push origin main");
    expect(runHook("post-tool-use", ev(dir, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" }, tool_use_id: "tu1" }), deps)).toBeNull();
    const a = rows(dir, "SELECT * FROM approvals WHERE decision='approved'");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "git_push", command: "git push origin main", task_id: id });
    expect(rows(dir, "SELECT * FROM events WHERE kind='approved'")).toHaveLength(1);
    // no ask for this tool_use_id: nothing recorded
    runHook("post-tool-use", ev(dir, { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "zzz" }), deps);
    expect(rows(dir, "SELECT * FROM approvals WHERE decision='approved'")).toHaveLength(1);
  });

  test("estack MCP calls get the real actor stamped over a typed one", () => {
    const dir = repo();
    const r = pre(dir, { tool_name: "mcp__plugin_estack_estack__start_task", agent_id: "A", tool_input: { title: "x", actor: { session_id: "fake" } } });
    expect(decision(r)).toBe("allow");
    expect(r.hookSpecificOutput.updatedInput).toEqual({ title: "x", actor: { session_id: S, agent_id: "A" } });
    const m = pre(dir, { tool_name: "mcp__plugin_estack_estack__status", tool_input: {} });
    expect(m.hookSpecificOutput.updatedInput.actor).toEqual({ session_id: S });
    expect("agent_id" in m.hookSpecificOutput.updatedInput.actor).toBe(false);
  });

  test("a broken policy denies gates with a one-line reason", () => {
    const dir = repo();
    writeFileSync(join(dir, ".estack", "policy.yaml"), "actions: [unclosed\n");
    const r = edit(dir, "src/a.ts");
    expect(decision(r)).toBe("deny");
    expect(reason(r).startsWith("estack: ")).toBe(true);
    expect(reason(r)).not.toContain("\n");
    expect(runHook("post-tool-use", ev(dir, { tool_name: "Bash" }), deps)).toBeNull();
  });
  describe("context and stop hooks", () => {
    const hook = (name: string, dir: string, o: Partial<HookEvent> = {}) => runHook(name, ev(dir, o), deps) as any;
    const ctx = (r: any) => r?.hookSpecificOutput?.additionalContext as string;
    const commit = (dir: string) => execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: dir, stdio: "ignore" });
    const setDone = (dir: string, id: number, ...names: string[]) => {
      const e = openEngine(dir, deps);
      for (const n of names) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, n);
      e.db.close();
    };
    function agentTask(dir: string, agent: string) {
      const e = openEngine(dir, deps);
      const t = startTask(e, { title: "w", type: "feature", goal: "g", done_check: "d", actor: { session_id: S, agent_id: agent }, cwd: dir });
      e.db.close();
      return t.task.id;
    }

    test("session start lists open tasks and their next step", () => {
      const dir = repo();
      const id = task(dir);
      const r = hook("session-start", dir, { hook_event_name: "SessionStart" });
      expect(r.hookSpecificOutput.hookEventName).toBe("SessionStart");
      const lines = ctx(r).split("\n");
      expect(lines[0]).toBe("estack: this repository is opted in; code edits need an open task (start_task), pushes need verify evidence.");
      expect(lines[1]).toMatch(new RegExp(`^#${id} \\[feature\\] t \\(.+\\) next: plan$`));
    });

    test("session start with no tasks still states the rules", () => {
      const dir = repo();
      const lines = ctx(hook("session-start", dir, { hook_event_name: "SessionStart" })).split("\n");
      expect(lines[0]).toContain("opted in");
      expect(lines[1]).toBe("no open tasks");
    });

    test("prompt submit shows the bound task's next step, else nothing", () => {
      const dir = repo();
      const id = task(dir);
      const r = hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit" });
      expect(r.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(ctx(r)).toBe(`estack: task #${id} next step: plan`);
      expect(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", session_id: "other" })).toBeNull();
    });

    test("stop blocks when commits exist but implement has no evidence", () => {
      const dir = repo();
      const id = task(dir);
      expect(hook("stop", dir, { hook_event_name: "Stop" })).toBeNull();
      commit(dir);
      const r = hook("stop", dir, { hook_event_name: "Stop" });
      expect(r.decision).toBe("block");
      expect(r.reason).toContain(`task #${id} has 1 new commit(s) on`);
      expect(r.reason).toContain("its implement step has no evidence");
    });

    test("stop allows once implement is recorded", () => {
      const dir = repo();
      const id = task(dir);
      commit(dir);
      setDone(dir, id, "implement");
      expect(hook("stop", dir, { hook_event_name: "Stop" })).toBeNull();
    });

    test("stop never blocks when stop_hook_active", () => {
      const dir = repo();
      task(dir);
      commit(dir);
      expect(hook("stop", dir, { hook_event_name: "Stop", stop_hook_active: true })).toBeNull();
    });

    test("subagent stop blocks a worker that implemented but never ran test", () => {
      const dir = repo();
      const id = agentTask(dir, "A");
      setDone(dir, id, "implement");
      const r = hook("subagent-stop", dir, { hook_event_name: "SubagentStop", agent_id: "A" });
      expect(r.decision).toBe("block");
      expect(r.reason).toContain(`task #${id}`);
      expect(r.reason).toContain("run run_check with step test before finishing");
      setDone(dir, id, "test");
      expect(hook("subagent-stop", dir, { hook_event_name: "SubagentStop", agent_id: "A" })).toBeNull();
    });

    test("subagent stop ignores tasks bound to other agents", () => {
      const dir = repo();
      const id = agentTask(dir, "A");
      setDone(dir, id, "implement");
      commit(dir);
      expect(hook("subagent-stop", dir, { hook_event_name: "SubagentStop", agent_id: "B" })).toBeNull();
    });
  });
});
