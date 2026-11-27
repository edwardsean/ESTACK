import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openEngine } from "../src/engine";
import { runHook, type HookEvent } from "../src/hooks";
import { recordOverride, skipStep } from "../src/owner";
import { initRepo } from "../src/policy";
import { realExec, type Exec } from "../src/exec";
import { preCommit, prePush } from "../src/githooks";
import { logEvent, startTask } from "../src/tasks";
import { consumeHandover, saveSessionHandover, type HandoverInput } from "../src/handover";
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

  test("an owner override turns the push refusal into an ask without spending it (pre-push spends it)", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    recordOverride(e, { action: "git_push", reason: "r" }, {});
    e.db.close();
    const a = bash(dir, "git push origin main", { tool_use_id: "a" });
    expect(decision(a)).toBe("ask");
    expect(reason(a)).toMatch(/owner override \(approval #\d+\)/);
    expect(decision(bash(dir, "git push origin main", { tool_use_id: "b" }))).toBe("ask");
    expect(rows(dir, "SELECT * FROM events WHERE kind='override_used'")).toHaveLength(0);
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
    expect(r.hookSpecificOutput.updatedInput).toEqual({ title: "x", cwd: dir, actor: { session_id: S, agent_id: "A" } });
    const m = pre(dir, { tool_name: "mcp__plugin_estack_estack__status", tool_input: {} });
    expect(m.hookSpecificOutput.updatedInput.actor).toEqual({ session_id: S });
    expect("cwd" in m.hookSpecificOutput.updatedInput).toBe(false);
    expect("agent_id" in m.hookSpecificOutput.updatedInput.actor).toBe(false);
  });

  test("resume calls get the real actor stamped", () => {
    const dir = repo();
    const r = pre(dir, { tool_name: "mcp__plugin_estack_estack__resume", agent_id: "A", tool_input: { actor: { session_id: "fake" } } });
    expect(decision(r)).toBe("allow");
    expect(r.hookSpecificOutput.updatedInput.actor).toEqual({ session_id: S, agent_id: "A" });
  });

  test("C6 start_task gets the caller's cwd stamped over a typed one", () => {
    const dir = repo();
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-wt-"))), "wt");
    execFileSync("git", ["worktree", "add", "-b", "feat", wt], { cwd: dir, stdio: "ignore" });
    const r = pre(wt, { tool_name: "mcp__plugin_estack_estack__start_task", tool_input: { title: "x", cwd: "/elsewhere" } });
    expect(decision(r)).toBe("allow");
    expect(r.hookSpecificOutput.updatedInput.cwd).toBe(wt);
  });

  test("F7 realExec.run pins LC_ALL=C, and an outside-repo write under a foreign locale is allowed", () => {
    const dir = repo();
    expect(realExec.run("sh", ["-c", 'printf %s "$LC_ALL"'], { cwd: dir }).stdout).toBe("C");
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.LC_ALL = "de_DE.UTF-8";
    process.env.LANG = "de_DE.UTF-8";
    try {
      const other = realpathSync(mkdtempSync(join(tmpdir(), "estack-other-")));
      expect(edit(dir, join(other, "a.ts"), { tool_name: "Write" })).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test("C3 every git call from the hooks uses a 5 s timeout", () => {
    const dir = repo();
    const seen: { args: string; timeoutMs?: number }[] = [];
    const exec: Exec = {
      run: (f, a, o) => { if (f === "git") seen.push({ args: a.join(" "), timeoutMs: o.timeoutMs }); return realExec.run(f, a, o); },
      shell: realExec.shell,
    };
    const d = { exec };
    const e0 = openEngine(dir, d);
    const id = startTask(e0, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: S }, cwd: dir }).task.id;
    e0.db.close();
    seen.length = 0;
    execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: dir, stdio: "ignore" });
    runHook("pre-tool-use", ev(dir, { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }), d);
    runHook("pre-tool-use", ev(dir, { tool_name: "Bash", tool_input: { command: "git push origin main" }, tool_use_id: "x" }), d);
    runHook("stop", ev(dir, { hook_event_name: "Stop" }), d);
    const e = openEngine(dir, d);
    try {
      preCommit(e, dir);
      prePush(e, dir, "refs/heads/main abc refs/heads/main 0000000000000000000000000000000000000000\n");
    } finally { e.db.close(); }
    expect(id).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const c of seen) expect(c.timeoutMs, c.args).toBe(5000);
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

    describe("handover hooks", () => {
      const usage = (dir: string, tokens: number) => {
        const p = join(dir, `tr-${tokens}.jsonl`);
        writeFileSync(p, JSON.stringify({ type: "assistant", isSidechain: false, message: { usage: { input_tokens: tokens } } }) + "\n");
        return p;
      };
      const withEngine = <T,>(dir: string, f: (e: ReturnType<typeof openEngine>) => T): T => {
        const e = openEngine(dir, deps);
        try { return f(e); } finally { e.db.close(); }
      };
      const save = (dir: string, session: string, input: HandoverInput = {}) =>
        withEngine(dir, (e) => saveSessionHandover(e, input, { session_id: session }, false));

      test("pre-compact saves one auto session handover and returns nothing", () => {
        const dir = repo();
        expect(hook("pre-compact", dir, { hook_event_name: "PreCompact" })).toBeNull();
        expect(rows(dir, "SELECT * FROM handovers")).toHaveLength(0);
        const id = task(dir);
        expect(hook("pre-compact", dir, { hook_event_name: "PreCompact", trigger: "auto" })).toBeNull();
        const h = rows(dir, "SELECT * FROM handovers");
        expect(h).toHaveLength(1);
        expect(h[0].kind).toBe("session");
        expect(h[0].auto).toBe(1);
        expect(h[0].from_session).toBe(S);
        expect(JSON.parse(h[0].body_json).tasks[0].task.id).toBe(id);
      });

      test("after compaction, session start injects the recorded state", () => {
        const dir = repo();
        const id = task(dir);
        writeFileSync(join(dir, "new.ts"), "x");
        save(dir, S, { goal: "ship the thing", plan: ["do later"], decisions: [{ what: "use sqlite", why: "simple" }], open_questions: ["which port?"], files: ["docs/arch.md"] });
        hook("pre-compact", dir, { hook_event_name: "PreCompact", trigger: "auto" });
        const text = ctx(hook("session-start", dir, { hook_event_name: "SessionStart", source: "compact" }));
        expect(text).toContain("ship the thing");
        expect(text).toContain("do later");
        expect(text).toContain(`#${id} next: plan`);
        expect(text).toContain("use sqlite");
        expect(text).toContain("which port?");
        expect(text).toContain("new.ts");
        expect(text).toContain("docs/arch.md");
        expect(text).toContain("estack: context was compacted; this is the recorded state of your work. Re-read the listed files before changing anything.");
        expect(text).not.toContain("a handover is waiting");
      });

      test("after /clear with one waiting handover, session start tells the agent to resume it", () => {
        const dir = repo();
        task(dir);
        const h = save(dir, S, { goal: "g" });
        const text = ctx(hook("session-start", dir, { hook_event_name: "SessionStart", source: "clear", session_id: "new" }));
        expect(text).toMatch(new RegExp(`estack: a handover is waiting \\(#${h.id}, session, \\d+s ago, goal: g\\)\\. Call the resume tool now, then re-read the files it lists and continue\\.`));
      });

      test("with several waiting handovers, session start lists them and says to ask the owner", () => {
        const dir = repo();
        task(dir);
        const h1 = save(dir, S, { goal: "g" });
        task(dir, "s2-abcdefghij");
        const h2 = save(dir, "s2-abcdefghij", { goal: "x".repeat(70) });
        const text = ctx(hook("session-start", dir, { hook_event_name: "SessionStart", source: "startup", session_id: "new" }));
        expect(text).toContain("estack: several handovers are waiting; ask the owner which one, then call the resume tool with handover_id.");
        expect(text).not.toContain("Call the resume tool now");
        const listed = text.split("\n").filter((l) => /^#\d+ (session|task #\d+) from /.test(l));
        expect(listed).toHaveLength(2);
        expect(listed[0]).toMatch(new RegExp(`^#${h1.id} session from ${S.slice(0, 8)} \\d+s ago goal: g$`));
        expect(listed[1]).toMatch(new RegExp(`^#${h2.id} session from s2-abcde \\d+s ago goal: ${"x".repeat(60)}$`));
      });

      test("prompt submit suggests a handover once per step above the threshold", () => {
        const dir = repo();
        const id = task(dir);
        const transcript_path = usage(dir, 120000);
        const first = ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path }));
        expect(first).toContain(`estack: task #${id} next step: plan`);
        expect(first).toContain("estack: context is 60% full. Finish the current step and collect any running workers, then call the handover tool and tell the owner to run /clear; the new session picks up automatically. Use /compact instead only if the conversation itself must be kept.");
        const ev1 = rows(dir, "SELECT * FROM events WHERE kind = 'handover_suggested'");
        expect(ev1).toHaveLength(1);
        expect(JSON.parse(ev1[0].payload_json)).toEqual({ session_id: S, task_id: id, step: "plan", ratio: 0.6 });
        const second = ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path }));
        expect(second).toBe(`estack: task #${id} next step: plan`);
        setDone(dir, id, "plan");
        const third = ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path }));
        expect(third).toContain("context is 60% full");
        expect(rows(dir, "SELECT * FROM events WHERE kind = 'handover_suggested'")).toHaveLength(2);
      });

      const clocked = (startMs: number) => {
        const c = { t: startMs, deps: { exec: fakeExec({}), now: () => new Date(c.t) } };
        return c;
      };
      const MIN = 60 * 1000;

      test("C1 a finished session's handover is not offered: manual handover, PreCompact, task closed", () => {
        const dir = repo();
        const id = task(dir);
        save(dir, S, { goal: "ship X" });
        hook("pre-compact", dir, { hook_event_name: "PreCompact", trigger: "auto" });
        withEngine(dir, (e) => e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id));
        const text = ctx(hook("session-start", dir, { hook_event_name: "SessionStart", source: "startup", session_id: "next-day" }));
        expect(text).toContain("no open tasks");
        expect(text).not.toContain("resume");
        expect(text).not.toContain("waiting");
      });

      test("I1 after compaction and a new task, the resuming session can edit both tasks' worktrees", () => {
        const dir = repo();
        task(dir, "A");
        hook("pre-compact", dir, { hook_event_name: "PreCompact", session_id: "A" });
        const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-wt-"))), "wt");
        execFileSync("git", ["worktree", "add", "-b", "b2", wt], { cwd: dir, stdio: "ignore" });
        withEngine(dir, (e) => startTask(e, { title: "b", type: "feature", goal: "g2", done_check: "d", actor: { session_id: "A" }, cwd: wt }));
        withEngine(dir, (e) => consumeHandover(e, { session_id: "B" }));
        expect(edit(wt, join(wt, "x.ts"), { session_id: "B" })).toBeNull();
        expect(edit(dir, join(dir, "x.ts"), { session_id: "B" })).toBeNull();
      });

      test("I3 a handover with no later activity from its session auto-resumes", () => {
        const dir = repo();
        const c = clocked(Date.parse("2026-01-01T00:00:00Z"));
        const e = openEngine(dir, c.deps);
        startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: S }, cwd: dir });
        const h = saveSessionHandover(e, { goal: "the goal" }, { session_id: S });
        e.db.close();
        c.t += 1000;
        const text = ctx(runHook("session-start", ev(dir, { hook_event_name: "SessionStart", source: "clear", session_id: "new" }), c.deps));
        expect(text).toContain(`estack: a handover is waiting (#${h.id}, session, 1s ago, goal: the goal). Call the resume tool now, then re-read the files it lists and continue.`);
      });

      test("I3 a handover whose session was active 2 minutes later is listed as maybe still running, not auto-resumed", () => {
        const dir = repo();
        const c = clocked(Date.parse("2026-01-01T00:00:00Z"));
        const e = openEngine(dir, c.deps);
        startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: S }, cwd: dir });
        const h = saveSessionHandover(e, { goal: "the goal" }, { session_id: S });
        c.t += 2 * MIN;
        logEvent(e, { session_id: S }, "step_done", null, {});
        e.db.close();
        c.t += 1 * MIN;
        const text = ctx(runHook("session-start", ev(dir, { hook_event_name: "SessionStart", source: "clear", session_id: "new" }), c.deps));
        expect(text).not.toContain("Call the resume tool now");
        expect(text).toContain(`#${h.id} session from ${S.slice(0, 8)} 3m ago goal: the goal (that session was active 1m ago; it may still be running)`);
        expect(text).toContain("ask the owner");
        expect(text).toContain("handover_id");
      });

      test("I3 a handover whose session was last active 20 minutes ago auto-resumes", () => {
        const dir = repo();
        const c = clocked(Date.parse("2026-01-01T00:00:00Z"));
        const e = openEngine(dir, c.deps);
        startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: S }, cwd: dir });
        const h = saveSessionHandover(e, { goal: "the goal" }, { session_id: S });
        c.t += 2 * MIN;
        logEvent(e, { session_id: S }, "step_done", null, {});
        e.db.close();
        c.t += 20 * MIN;
        const text = ctx(runHook("session-start", ev(dir, { hook_event_name: "SessionStart", source: "clear", session_id: "new" }), c.deps));
        expect(text).toContain(`estack: a handover is waiting (#${h.id}, session, 22m ago, goal: the goal). Call the resume tool now`);
      });

      test("M1 after compaction an hours-old manual handover is not presented as current state", () => {
        const dir = repo();
        const c = clocked(Date.parse("2026-01-01T00:00:00Z"));
        const e = openEngine(dir, c.deps);
        const t = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: S }, cwd: dir });
        saveSessionHandover(e, { goal: "old goal", plan: ["old plan"] }, { session_id: S });
        e.db.close();
        writeFileSync(join(dir, "live.ts"), "x");
        c.t += 3 * 60 * MIN;
        const text = ctx(runHook("session-start", ev(dir, { hook_event_name: "SessionStart", source: "compact" }), c.deps));
        expect(text).not.toContain("old goal");
        expect(text).not.toContain("old plan");
        expect(text).toContain(`#${t.task.id} next: plan`);
        expect(text).toContain("live.ts");
        expect(text).toContain("Re-read the listed files before changing anything.");
      });

      test("I4 on a 1M-context model the default window does not print over 100%", () => {
        const dir = repo();
        task(dir);
        const text = ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path: usage(dir, 660000) }));
        expect(text).toContain("estack: context is 66% full.");
      });

      test("I2 the waiting list stops at 10 handovers with a +N more line", () => {
        const dir = repo();
        for (let i = 0; i < 12; i++) { task(dir, `sess-${i}`); save(dir, `sess-${i}`, { goal: `g${i}` }); }
        const lines = ctx(hook("session-start", dir, { hook_event_name: "SessionStart", source: "startup", session_id: "new" })).split("\n");
        expect(lines.filter((l) => /^#\d+ session from /.test(l))).toHaveLength(10);
        expect(lines.at(-2)).toBe("+2 more");
        expect(lines.at(-1)).toBe("estack: several handovers are waiting; ask the owner which one, then call the resume tool with handover_id.");
      });

      test("M2 pre-compact from a worker writes no session handover", () => {
        const dir = repo();
        task(dir);
        expect(hook("pre-compact", dir, { hook_event_name: "PreCompact", agent_id: "w1" })).toBeNull();
        expect(rows(dir, "SELECT * FROM handovers")).toHaveLength(0);
      });

      test("M3 after a resume the new session is nudged on a step the old one was already nudged on", () => {
        const dir = repo();
        const id = task(dir);
        const transcript_path = usage(dir, 120000);
        expect(ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path }))).toContain("context is 60% full");
        save(dir, S, { goal: "g" });
        withEngine(dir, (e) => consumeHandover(e, { session_id: "B" }));
        const b = ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path, session_id: "B" }));
        expect(b).toContain(`estack: task #${id} next step: plan`);
        expect(b).toContain("context is 60% full");
      });

      test("prompt submit stays quiet below the threshold or when the transcript can't be read", () => {
        const dir = repo();
        const id = task(dir);
        const line = `estack: task #${id} next step: plan`;
        expect(ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path: usage(dir, 50000) }))).toBe(line);
        expect(ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit", transcript_path: join(dir, "missing.jsonl") }))).toBe(line);
        expect(ctx(hook("user-prompt-submit", dir, { hook_event_name: "UserPromptSubmit" }))).toBe(line);
        expect(rows(dir, "SELECT * FROM events WHERE kind = 'handover_suggested'")).toHaveLength(0);
      });
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
    // Skip steps in order up to and including `through` (owner action, so no CLAUDECODE in env).
    function skipThrough(dir: string, id: number, through: string, doneBefore: string[] = []) {
      const e = openEngine(dir, deps);
      try {
        for (const s of e.db.prepare("SELECT name FROM steps WHERE task_id=? ORDER BY ordinal").all(id) as { name: string }[]) {
          if (doneBefore.includes(s.name)) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, s.name);
          else skipStep(e, { task_id: id, step: s.name, reason: "test" }, {});
          if (s.name === through) break;
        }
      } finally { e.db.close(); }
    }

    test("a skipped implement step does not block stop", () => {
      const dir = repo();
      const id = task(dir);
      skipThrough(dir, id, "implement");
      commit(dir);
      expect(hook("stop", dir, { hook_event_name: "Stop" })).toBeNull();
    });

    test("a skipped test step does not block subagent stop", () => {
      const dir = repo();
      const id = agentTask(dir, "A");
      skipThrough(dir, id, "test", ["implement"]);
      expect(hook("subagent-stop", dir, { hook_event_name: "SubagentStop", agent_id: "A" })).toBeNull();
    });
  });
});

describe("hooks: read tools and code-map tools", () => {
  test("code-map tools get the real cwd stamped", () => {
    const dir = repo();
    for (const t of ["context_for", "find_existing", "who_uses"]) {
      const r = pre(dir, { tool_name: `mcp__plugin_estack_estack__${t}`, agent_id: "w1", tool_input: { area: "x" } });
      expect(r.hookSpecificOutput.updatedInput.cwd).toBe(dir);
      expect(r.hookSpecificOutput.updatedInput.actor).toEqual({ session_id: S, agent_id: "w1" });
    }
  });

  test("read tools fail open when the engine errors", () => {
    const dir = repo();
    writeFileSync(join(dir, ".estack", "policy.yaml"), "not: [valid");
    expect(pre(dir, { tool_name: "Read", tool_input: { file_path: join(dir, "a.ts") } })).toBeNull();
    expect(pre(dir, { tool_name: "Grep", tool_input: { pattern: "x" } })).toBeNull();
    expect(decision(edit(dir, "a.ts"))).toBe("deny");
  });

  const script = join(__dirname, "../../core/hooks/scripts/estack-hook.sh");
  const runScript = (dir: string, tool: string, path: string) => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: S, cwd: dir, tool_name: tool, tool_input: { file_path: join(dir, "a.ts") } });
    return spawnSync("/bin/sh", [script, "pre-tool-use"], { input, encoding: "utf8", env: { PATH: path, CLAUDE_PROJECT_DIR: dir } });
  };
  const mapOn = (dir: string) => {
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("enabled: false", "enabled: true"));
  };

  test("the hook script lets Read through without node", () => {
    const dir = repo();
    mapOn(dir);
    for (const t of ["Read", "Grep"]) {
      const r = runScript(dir, t, "/usr/bin:/bin");
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    const r = runScript(dir, "Edit", "/usr/bin:/bin");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("with the map off the hook script lets Read and Grep through without starting node", () => {
    const dir = repo();
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "estack-bin-")));
    const marker = join(bin, "node-started");
    writeFileSync(join(bin, "node"), `#!/bin/sh\ncat >/dev/null\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
    const path = `${bin}:/usr/bin:/bin`;
    for (const t of ["Read", "Grep"]) {
      const r = runScript(dir, t, path);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(existsSync(marker)).toBe(false);
    runScript(dir, "Edit", path);
    expect(existsSync(marker)).toBe(true);
    // With the map on (the line init writes, comment and all) a Read starts node again.
    rmSync(marker);
    mapOn(dir);
    runScript(dir, "Read", path);
    expect(existsSync(marker)).toBe(true);
  });
});
