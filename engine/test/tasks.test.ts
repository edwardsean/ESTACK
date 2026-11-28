import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { openEngine, type Engine } from "../src/engine";
import { initRepo } from "../src/policy";
import { bindWorker, completeStep, getTask, insertEvidence, ownsTask, startTask, type EvidenceInput } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import type { Exec, ExecResult } from "../src/exec";
import { fakeExec, makeRepo, writeFakeGraph } from "./helpers";
import { runCodeQuery } from "../src/codemap";

const cto: Actor = { session_id: "s1" };
const worker: Actor = { session_id: "s1", agent_id: "w1" };
const reviewer: Actor = { session_id: "s1", agent_id: "r1" };
const PR = "https://github.com/o/r/pull/1";
const PR_KEY = `pr view ${PR} --json headRefName`;
const prOn = (branch: string) => ({ code: 0, stdout: JSON.stringify({ headRefName: branch }) });

function setup(gh: Record<string, Partial<ExecResult>> = {}) {
  const dir = makeRepo();
  initRepo(dir);
  const e = openEngine(dir, { exec: fakeExec(gh) });
  return { dir, e };
}
const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
    const rows = e.db.prepare("SELECT session_id, agent_id, role FROM task_bindings").all();
    expect(rows).toEqual([{ session_id: "s1", agent_id: null, role: "cto" }]);
    startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: worker, cwd: dir });
    const w = e.db.prepare("SELECT session_id, agent_id, role FROM task_bindings WHERE agent_id = ?").all("w1");
    expect(w).toEqual([{ session_id: "s1", agent_id: "w1", role: "worker" }]);
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
    const key = PR_KEY;
    const bad = setup({ [key]: { code: 1 } });
    let id = start(bad.e, bad.dir).task.id;
    force(bad.e, id, ["plan", "reuse_check", "implement", "test", "verify", "review"]);
    expect(code(() => done(bad.e, id, "pr", { kind: "pr", url: PR })).code).toBe("BAD_EVIDENCE");
    const good = setup({ [key]: prOn("main") });
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
  test("evidence checks run outside the write lock: another connection can write while gh runs", () => {
    const dir = makeRepo();
    initRepo(dir);
    const inner = fakeExec({});
    const seen: string[] = [];
    const exec: Exec = {
      ...inner,
      run(file, args, opts) {
        if (file !== "gh") return inner.run(file, args, opts);
        const other = new DatabaseSync(join(dir, ".estack", "state.db"));
        try {
          other.exec("PRAGMA busy_timeout=100");
          other.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES ('t','other','x',NULL,'{}')").run();
          seen.push("wrote");
        } catch (x) {
          seen.push(`blocked: ${(x as Error).message}`);
        } finally {
          other.close();
        }
        return { code: 0, stdout: JSON.stringify({ url: PR, headRefName: "main" }), stderr: "", timedOut: false, durationMs: 0 };
      },
    };
    const e = openEngine(dir, { exec });
    const id = start(e, dir).task.id;
    force(e, id, ["plan", "reuse_check", "implement", "test", "verify", "review"]);
    const v = done(e, id, "pr", { kind: "pr", url: PR });
    expect(seen).toEqual(["wrote"]);
    expect(v.task.status).toBe("done");
  });

  test("evidence git/gh calls have a 30s timeout and a timeout is BAD_EVIDENCE", () => {
    const dir = makeRepo();
    initRepo(dir);
    const timeouts: (number | undefined)[] = [];
    const inner = fakeExec({});
    const exec: Exec = {
      ...inner,
      run(file, args, opts) {
        timeouts.push(opts.timeoutMs);
        if (file === "gh") return { code: null, stdout: "", stderr: "", timedOut: true, durationMs: 30_000 };
        return inner.run(file, args, opts);
      },
    };
    const e = openEngine(dir, { exec });
    const id = toImplement(e, dir);
    timeouts.length = 0;
    done(e, id, "implement", { kind: "commit", sha: commit(dir) }, worker);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((t) => t === 30_000)).toBe(true);
    force(e, id, ["test", "verify", "review"]);
    const err = code(() => done(e, id, "pr", { kind: "pr", url: PR }));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toBe("gh/git timed out");
  });
  test("a commit made before the task started is BAD_EVIDENCE", () => {
    const { dir, e } = setup();
    const base = git(dir, "rev-parse", "HEAD");
    const id = toImplement(e, dir);
    const err = code(() => done(e, id, "implement", { kind: "commit", sha: base }, worker));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain("commit predates the task");
  });

  test("a new commit is accepted and stored as the full sha", () => {
    const { dir, e } = setup();
    const id = toImplement(e, dir);
    const sha = commit(dir);
    const v = done(e, id, "implement", { kind: "commit", sha: sha.slice(0, 8) }, worker);
    const stored = v.evidence.find((x) => x.kind === "commit")!.payload.sha;
    expect(stored).toBe(sha);
    expect(String(stored)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("startTask records the branch head as base_sha and the worktree top level as cwd", () => {
    const { dir, e } = setup();
    const t = start(e, dir);
    expect(t.task.base_sha).toBe(git(dir, "rev-parse", "HEAD"));
    expect(t.task.cwd).toBe(dir);
  });

  test("an empty or unknown branch is refused at startTask", () => {
    const { dir, e } = setup();
    for (const branch of ["", "no-such-branch"]) {
      const err = code(() => startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, branch }));
      expect(err.code).toBe("POLICY_INVALID");
    }
  });
  test("a pr for a different branch than the task's is BAD_EVIDENCE", () => {
    const { dir, e } = setup({ [PR_KEY]: prOn("other") });
    const id = start(e, dir).task.id;
    force(e, id, ["plan", "reuse_check", "implement", "test", "verify", "review"]);
    const err = code(() => done(e, id, "pr", { kind: "pr", url: PR }));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toBe("PR is for branch other, task is on main");
  });

  test("a review from the default unknown actor is BAD_EVIDENCE", () => {
    const { e, id } = toReview();
    const err = code(() => done(e, id, "review", { kind: "review", verdict: "approve", findings: "" }, { session_id: "unknown" }));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toBe("review needs a reviewer identity");
  });

  test("a changes verdict is recorded as failed evidence and the step stays open", () => {
    const { e, id } = toReview();
    const err = code(() => done(e, id, "review", { kind: "review", verdict: "changes", findings: "fix x" }, reviewer));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toBe("changes requested");
    const v = getTask(e, id);
    const row = v.evidence.at(-1)!;
    expect(row).toMatchObject({ step: "review", kind: "review", ok: false, payload: { verdict: "changes", findings: "fix x" } });
    expect(v.next?.name).toBe("review");
  });
});

describe("reuse_check with the code map", () => {
  function mapSetup(on = true) {
    const dir = makeRepo();
    initRepo(dir);
    if (on) {
      const p = join(dir, ".estack", "policy.yaml");
      writeFileSync(p, readFileSync(p, "utf8").replace("enabled: false", "enabled: true"));
      writeFakeGraph(dir, [{ id: "f", label: "fmt()", source_file: "src/a.ts", source_location: "L3" }], []);
    }
    const e = openEngine(dir, { exec: fakeExec({}) });
    const t = start(e, dir);
    done(e, t.task.id, "plan");
    return { dir, e, id: t.task.id };
  }
  const search = (e: Engine, dir: string, id: number, actor: Actor, arg = "src") =>
    runCodeQuery(e, { tool: "find_existing", arg, actor, cwd: dir, task_id: id });

  test("with the map on, reuse_check needs the agent's own search", () => {
    const { dir, e, id } = mapSetup();
    expect(code(() => done(e, id, "reuse_check", note("nothing"))).code).toBe("BAD_EVIDENCE");
    search(e, dir, id, cto, "format");
    const qid = (e.db.prepare("SELECT id FROM code_queries WHERE task_id = ?").get(id) as { id: number }).id;
    const v = done(e, id, "reuse_check", note("nothing"));
    expect(v.evidence.at(-1)?.payload).toEqual({ text: "nothing", queries: [qid] });
  });

  test("start_task's automatic context doesn't count", () => {
    const { dir, e, id } = mapSetup();
    runCodeQuery(e, { tool: "context_for", arg: "src", actor: cto, cwd: dir, task_id: id, auto: true });
    expect(code(() => done(e, id, "reuse_check")).code).toBe("BAD_EVIDENCE");
  });

  test("another agent's search doesn't count", () => {
    const { dir, e, id } = mapSetup();
    search(e, dir, id, worker);
    expect(code(() => done(e, id, "reuse_check")).code).toBe("BAD_EVIDENCE");
  });

  test("a failed search doesn't count", () => {
    const { dir, e, id } = mapSetup();
    rmSync(join(dir, "graphify-out"), { recursive: true });
    expect(code(() => search(e, dir, id, cto)).code).toBe("MAP_BROKEN");
    expect((e.db.prepare("SELECT ok FROM code_queries").get() as { ok: number }).ok).toBe(0);
    expect(code(() => done(e, id, "reuse_check")).code).toBe("BAD_EVIDENCE");
  });

  test("the reuse_check refusal names the task it checked", () => {
    const { e, id } = mapSetup();
    const err = code(() => done(e, id, "reuse_check", note("nothing")));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain(`task #${id}`);
  });

  test("a search with no task_id counts for the session's task still on reuse_check, else its newest", () => {
    const { dir, e, id } = mapSetup();
    const newer = start(e, dir).task.id;
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name IN ('plan', 'reuse_check')").run(newer);
    const lastTask = () => (e.db.prepare("SELECT task_id FROM code_queries ORDER BY id DESC LIMIT 1").get() as { task_id: number | null }).task_id;
    runCodeQuery(e, { tool: "find_existing", arg: "fmt", actor: cto, cwd: dir });
    expect(lastTask()).toBe(id);
    expect(done(e, id, "reuse_check", note("found fmt")).steps.find((s) => s.name === "reuse_check")!.status).toBe("done");
    runCodeQuery(e, { tool: "find_existing", arg: "fmt", actor: cto, cwd: dir });
    expect(lastTask()).toBe(newer);
  });

  test("with the map off, reuse_check takes a plain note", () => {
    const { e, id } = mapSetup(false);
    const v = done(e, id, "reuse_check", note("nothing"));
    expect(v.evidence.at(-1)?.payload).toEqual({ text: "nothing" });
  });
});

describe("workers and the merge step", () => {
  function pair() {
    const { dir, e } = setup();
    const f = startTask(e, { title: "Feat", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, worktree: true });
    const w = startTask(e, { title: "Work", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: f.task.cwd, worktree: true, parent_task_id: f.task.id });
    // Everything before the merge step is done, so merge is next.
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'merge'").run(w.task.id);
    return { dir, e, f, w };
  }
  const merge = (e: Engine, id: number, actor = cto) => completeStep(e, { task_id: id, step: "merge", evidence: { kind: "merged" }, actor });
  const kinds = (e: Engine, kind: string) => e.db.prepare("SELECT payload_json p FROM events WHERE kind = ?").all(kind) as { p: string }[];

  test("bindWorker binds an agent once as worker, and never a bare session", () => {
    const { e, w } = pair();
    bindWorker(e, w.task.id, cto);
    bindWorker(e, w.task.id, worker);
    bindWorker(e, w.task.id, worker);
    const rows = e.db.prepare("SELECT agent_id, role FROM task_bindings WHERE task_id = ? ORDER BY rowid").all(w.task.id);
    expect(rows).toEqual([{ agent_id: null, role: "cto" }, { agent_id: "w1", role: "worker" }]);
  });

  test("bindWorker binds only worker tasks, not a feature or a plain task", () => {
    const { dir, e, f } = pair();
    bindWorker(e, f.task.id, worker);
    const plain = startTask(e, { title: "Plain", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir });
    bindWorker(e, plain.task.id, worker);
    const n = (id: number) => (e.db.prepare("SELECT COUNT(*) c FROM task_bindings WHERE task_id = ? AND agent_id IS NOT NULL").get(id) as { c: number }).c;
    expect(n(f.task.id)).toBe(0);
    expect(n(plain.task.id)).toBe(0);
  });

  test("a merge refuses a worker branch reset behind its implement commit", () => {
    const { e, f, w } = pair();
    git(w.task.cwd, "commit", "--allow-empty", "-m", "worker work");
    const sha = git(w.task.cwd, "rev-parse", "HEAD");
    insertEvidence(e, w.task.id, "implement", "commit", true, { sha }, cto);
    git(w.task.cwd, "reset", "--hard", w.task.base_sha);
    git(f.task.cwd, "merge", "--no-ff", "-m", "nothing", w.task.branch);
    const err = code(() => merge(e, w.task.id));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain(`commit ${sha} from this task is not in ${f.task.branch}`);
    expect(getTask(e, w.task.id).task.status).toBe("open");
  });

  test("a throw while removing the worktree after the merge is logged as kept", () => {
    const { e, f, w } = pair();
    git(w.task.cwd, "commit", "--allow-empty", "-m", "work");
    git(f.task.cwd, "merge", "--no-ff", "-m", "m", w.task.branch);
    const real = e.exec;
    e.exec = { ...real, run: (file, args, opts) => file === "git" && args[0] === "worktree" && args[1] === "list"
      ? { code: 1, stdout: "", stderr: "", timedOut: true, durationMs: 0 } : real.run(file, args, opts) };
    expect(merge(e, w.task.id).task.status).toBe("done");
    expect(existsSync(w.task.cwd)).toBe(true);
    expect(kinds(e, "worktree_kept").map((r) => JSON.parse(r.p))).toEqual([{ path: w.task.cwd, reason: "gh/git timed out" }]);
  });

  test("ownsTask is true for the cto of the task or of its parent", () => {
    const { e, f, w } = pair();
    expect(ownsTask(e, "s1", w.task.id)).toBe(true);
    expect(ownsTask(e, "s1", f.task.id)).toBe(true);
    expect(ownsTask(e, "other", w.task.id)).toBe(false);
    bindWorker(e, w.task.id, { session_id: "s2", agent_id: "x" });
    expect(ownsTask(e, "s2", w.task.id)).toBe(false);
    e.db.prepare("DELETE FROM task_bindings WHERE task_id = ? AND role = 'cto'").run(w.task.id);
    expect(ownsTask(e, "s1", w.task.id)).toBe(true);
  });

  test("the merge step needs the worker merged into its feature", () => {
    const { e, f, w } = pair();
    git(w.task.cwd, "commit", "--allow-empty", "-m", "worker work");
    const err = code(() => merge(e, w.task.id));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toBe(`${w.task.branch} is not merged into ${f.task.branch} yet; merge it there first (git -C ${f.task.cwd} merge --no-ff ${w.task.branch})`);
    expect(getTask(e, w.task.id).task.status).toBe("open");
    const head = git(w.task.cwd, "rev-parse", "HEAD");
    git(f.task.cwd, "merge", "--no-ff", "-m", "merge worker", w.task.branch);
    const v = merge(e, w.task.id);
    expect(v.task.status).toBe("done");
    expect(v.evidence.at(-1)).toMatchObject({ kind: "merged", ok: true, payload: { head, into: f.task.branch } });
    expect(kinds(e, "task_merged").map((r) => JSON.parse(r.p))).toEqual([{ into: f.task.branch }]);
  });

  test("a merge step on a task with no parent is refused", () => {
    const { dir, e } = setup();
    const t = startTask(e, { title: "Solo", type: "feature", goal: "g", done_check: "d", actor: cto, cwd: dir, worktree: true });
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'pr'").run(t.task.id);
    e.db.prepare("UPDATE steps SET name = 'merge' WHERE task_id = ? AND name = 'pr'").run(t.task.id);
    expect(code(() => merge(e, t.task.id)).message).toContain("no parent");
  });

  test("a merged worker's dirty worktree is kept, and its clean one is removed", () => {
    const a = pair();
    git(a.w.task.cwd, "commit", "--allow-empty", "-m", "work");
    git(a.f.task.cwd, "merge", "--no-ff", "-m", "m", a.w.task.branch);
    writeFileSync(join(a.w.task.cwd, "scratch.txt"), "wip");
    expect(merge(a.e, a.w.task.id).task.status).toBe("done");
    expect(existsSync(a.w.task.cwd)).toBe(true);
    expect(kinds(a.e, "worktree_kept")).toHaveLength(1);

    const b = pair();
    git(b.w.task.cwd, "commit", "--allow-empty", "-m", "work");
    git(b.f.task.cwd, "merge", "--no-ff", "-m", "m", b.w.task.branch);
    expect(merge(b.e, b.w.task.id).task.status).toBe("done");
    expect(existsSync(b.w.task.cwd)).toBe(false);
    expect(git(b.dir, "branch", "--list", b.w.task.branch)).toBe("");
    expect(kinds(b.e, "worktree_removed")).toHaveLength(1);
  });

  test("a feature's own steps run on the merged result", () => {
    const { e, f, w } = pair();
    git(w.task.cwd, "commit", "--allow-empty", "-m", "worker work");
    git(f.task.cwd, "merge", "--no-ff", "-m", "merge worker", w.task.branch);
    merge(e, w.task.id);
    const sha = git(f.task.cwd, "rev-parse", "HEAD");
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name IN ('plan','reuse_check')").run(f.task.id);
    const v = completeStep(e, { task_id: f.task.id, step: "implement", evidence: { kind: "commit", sha }, actor: cto });
    expect(v.evidence.at(-1)).toMatchObject({ kind: "commit", ok: true, payload: { sha } });
  });
});
