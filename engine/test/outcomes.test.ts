import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCheck } from "../src/checks";
import type { Exec } from "../src/exec";
import { describe, expect, test } from "vitest";
import { allowEdit, checkEdit } from "../src/claims";
import { openEngine, type Engine } from "../src/engine";
import { OUTCOME_BUDGET_MS, recordOutcomes } from "../src/outcomes";
import { initRepo } from "../src/policy";
import { completeStep, insertEvidence, startTask } from "../src/tasks";
import type { Actor, Task } from "../src/types";
import { fakeExec, makeRepo } from "./helpers";

const A: Actor = { session_id: "sa" };
const deps = { exec: fakeExec({}) };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(): string {
  const dir = makeRepo();
  initRepo(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "estack");
  return dir;
}
const feature = (e: Engine, dir: string, title: string): Task =>
  startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor: A, cwd: dir, worktree: true }).task;
const worker = (e: Engine, f: Task, title: string): Task =>
  startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor: A, cwd: f.cwd, worktree: true, parent_task_id: f.id }).task;
function commitFile(t: Task, file: string, text: string): void {
  mkdirSync(dirname(join(t.cwd, file)), { recursive: true });
  writeFileSync(join(t.cwd, file), text);
  git(t.cwd, "add", "-A");
  git(t.cwd, "commit", "-m", `edit ${file}`);
}
/** t1 holds src/a.ts and t2 is allowed in; returns the grant id. */
function grant(e: Engine, t1: Task, t2: Task): number {
  checkEdit(e, t1, "src/a.ts");
  allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: "needs it", actor: A, owner: false });
  return Number((e.db.prepare("SELECT id FROM claim_grants WHERE task_id = ?").get(t2.id) as { id: number }).id);
}
const outcome = (e: Engine, id: number) => e.db.prepare("SELECT outcome, outcome_at FROM claim_grants WHERE id = ?").get(id) as { outcome: string | null; outcome_at: string | null };
const logged = (e: Engine) => e.db.prepare("SELECT payload_json p FROM events WHERE kind = 'grant_outcome' ORDER BY id").all().map((r: any) => JSON.parse(r.p));

describe("grant outcomes", { timeout: 60_000 }, () => {
  test("a conflicted merge in the granted file records conflict", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    const g = grant(e, t1, t2);
    commitFile(t1, "src/a.ts", "one\n");
    commitFile(t2, "src/a.ts", "two\n");
    recordOutcomes(e);
    expect(outcome(e, g).outcome).toBeNull();           // nothing has happened yet
    expect(() => git(t2.cwd, "merge", t1.branch)).toThrow();   // conflict, merge left in progress
    recordOutcomes(e);
    expect(outcome(e, g)).toEqual({ outcome: "conflict", outcome_at: expect.any(String) });
    expect(logged(e)).toEqual([{ grant_id: g, outcome: "conflict" }]);
  });

  test("a conflicting pull request with the path in both features' changes records conflict", () => {
    const dir = repo();
    const fake = openEngine(dir, { exec: fakeExec({}) });
    const t1 = feature(fake, dir, "one");
    const t2 = feature(fake, dir, "two");
    const g = grant(fake, t1, t2);
    commitFile(t1, "src/a.ts", "one\n");
    commitFile(t2, "src/a.ts", "two\n");
    const e = openEngine(dir, { exec: fakeExec({ [`pr view ${t2.branch} --json mergeable`]: { code: 0, stdout: '{"mergeable":"CONFLICTING"}' } }) });
    recordOutcomes(e);
    expect(outcome(e, g).outcome).toBe("conflict");
  });

  test("the holder's failing test after a grant records holder_failed", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    const g = grant(e, t1, t2);
    commitFile(t1, "src/a.ts", "one\n");
    recordOutcomes(e);
    expect(outcome(e, g).outcome).toBeNull();
    insertEvidence(e, t1.id, "test", "command", false, { command: "x" }, A);
    recordOutcomes(e);
    expect(outcome(e, g).outcome).toBe("holder_failed");
    expect(logged(e)).toEqual([{ grant_id: g, outcome: "holder_failed" }]);
  });

  test("a holder failure on a change without the file does not count", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    const g = grant(e, t1, t2);
    commitFile(t1, "src/other.ts", "x\n");
    insertEvidence(e, t1.id, "verify", "command", false, { command: "x" }, A);
    recordOutcomes(e);
    expect(outcome(e, g).outcome).toBeNull();
  });

  test("both merged with no trouble records clean", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, "feat");
    const w1 = worker(e, f, "w1");
    const w2 = worker(e, f, "w2");
    const g = grant(e, w1, w2);
    commitFile(w1, "src/a.ts", "one\n");
    commitFile(w2, "src/b.ts", "two\n");
    const merge = (w: Task) => {
      e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'merge'").run(w.id);
      git(f.cwd, "merge", "--no-ff", "-m", "m", w.branch);
      completeStep(e, { task_id: w.id, step: "merge", evidence: { kind: "merged" }, actor: A });
    };
    merge(w1);
    expect(outcome(e, g).outcome).toBeNull();          // only one side is merged
    merge(w2);
    expect(outcome(e, g)).toEqual({ outcome: "clean", outcome_at: expect.any(String) });
    expect(logged(e)).toEqual([{ grant_id: g, outcome: "clean" }]);
  });

  test("outcomes are recorded once", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    const g = grant(e, t1, t2);
    commitFile(t1, "src/a.ts", "one\n");
    insertEvidence(e, t1.id, "test", "command", false, { command: "x" }, A);
    recordOutcomes(e);
    const first = outcome(e, g);
    commitFile(t2, "src/a.ts", "two\n");
    expect(() => git(t2.cwd, "merge", t1.branch)).toThrow();
    recordOutcomes(e);
    recordOutcomes(e);
    expect(outcome(e, g)).toEqual(first);
    expect(first.outcome).toBe("holder_failed");
    expect(logged(e)).toHaveLength(1);
  });

  test("a failing grant never throws and does not stop the others", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    const g = grant(e, t1, t2);
    // A grant whose event payload is unreadable throws while judged; the good one is still recorded.
    const t3 = feature(e, dir, "three");
    e.db.prepare("INSERT INTO claim_grants (id, claim_id, task_id, path, reason, by, at) VALUES (100, 1, ?, 'src/z.ts', 'r', 'b', 'now')").run(t3.id);
    e.db.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES ('now', 'x', 'claim_granted', ?, 'not json')").run(t3.id);
    insertEvidence(e, t1.id, "test", "command", false, { command: "x" }, A);
    commitFile(t1, "src/a.ts", "one\n");
    expect(() => recordOutcomes(e)).not.toThrow();
    expect(outcome(e, g).outcome).toBe("holder_failed");
    expect(outcome(e, 100).outcome).toBeNull();
  });

  /** Wrap an exec, counting gh calls and fetches. `gh` answers with the scripted responses. */
  function counting(responses: Record<string, any> = {}): { exec: Exec; gh: string[]; fetches: number } {
    const inner = fakeExec(responses);
    const out = { gh: [] as string[], fetches: 0, exec: undefined as unknown as Exec };
    out.exec = {
      run(file, args, opts) {
        if (file === "gh") out.gh.push(args.join(" "));
        if (file === "git" && args[0] === "fetch") out.fetches++;
        return inner.run(file, args, opts);
      },
      shell: (c, o) => inner.shell(c, o),
    };
    return out;
  }
  const withTestCommand = (dir: string) => {
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace(/commands:[\s\S]*$/, 'commands:\n  test: "true"\n'));
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "cmd");
  };

  test("complete_step and run_check make no gh call or fetch", () => {
    const dir = repo();
    withTestCommand(dir);
    const spy = counting({ "pr view feat/1-one --json state": { code: 1 } });
    const e = openEngine(dir, { exec: spy.exec });
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    grant(e, t1, t2);
    commitFile(t1, "src/a.ts", "one\n");
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name IN ('plan', 'reuse_check', 'implement')").run(t1.id);
    runCheck(e, { task_id: t1.id, step: "test", actor: A });
    recordOutcomes(e, { remote: false });
    expect(spy.gh).toEqual([]);
    expect(spy.fetches).toBe(0);
  });

  test("complete_step still succeeds when gh is missing", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: { run: (f, a, o) => (f === "gh" ? { code: 127, stdout: "", stderr: "gh: not found", timedOut: false, durationMs: 0 } : fakeExec({}).run(f, a, o)), shell: (c, o) => fakeExec({}).shell(c, o) } });
    const f = feature(e, dir, "feat");
    const w1 = worker(e, f, "w1");
    const w2 = worker(e, f, "w2");
    const g = grant(e, w1, w2);
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'merge'").run(w1.id);
    commitFile(w1, "src/a.ts", "one\n");
    git(f.cwd, "merge", "--no-ff", "-m", "m", w1.branch);
    expect(() => completeStep(e, { task_id: w1.id, step: "merge", evidence: { kind: "merged" }, actor: A })).not.toThrow();
    expect(outcome(e, g).outcome).toBeNull();
  });

  test("many grants across the same two features make a bounded number of gh calls from status", () => {
    const dir = repo();
    const spy = counting();
    const e = openEngine(dir, { exec: spy.exec });
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    for (const f of ["a", "b", "c", "d", "e"]) {
      commitFile(t1, `src/${f}.ts`, "one\n");
      checkEdit(e, t1, `src/${f}.ts`);
      allowEdit(e, { task_id: t2.id, path: `src/${f}.ts`, reason: "r", actor: A, owner: false });
    }
    recordOutcomes(e, { remote: true });
    // One mergeable and one state call per feature, however many grants.
    expect(spy.gh.length).toBeLessThanOrEqual(4);
    expect(spy.fetches).toBeLessThanOrEqual(1);
  });

  test("an exhausted budget leaves the grants untouched", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, "one");
    const t2 = feature(e, dir, "two");
    const g = grant(e, t1, t2);
    commitFile(t1, "src/a.ts", "one\n");
    insertEvidence(e, t1.id, "test", "command", false, { command: "x" }, A);
    recordOutcomes(e, { budget_ms: 0 });
    expect(outcome(e, g).outcome).toBeNull();
    expect(OUTCOME_BUDGET_MS).toBe(10_000);
    recordOutcomes(e);
    expect(outcome(e, g).outcome).toBe("holder_failed");
  });

  test("workers of different features are not clean until both features are merged into main", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f1 = feature(e, dir, "feat one");
    const f2 = feature(e, dir, "feat two");
    const w1 = worker(e, f1, "w1");
    const w2 = worker(e, f2, "w2");
    const g = grant(e, w1, w2);
    for (const w of [w1, w2]) {
      commitFile(w, `src/${w.id}.ts`, "x\n");
      e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'merge'").run(w.id);
      git(w.parent_id === f1.id ? f1.cwd : f2.cwd, "merge", "--no-ff", "-m", "m", w.branch);
      completeStep(e, { task_id: w.id, step: "merge", evidence: { kind: "merged" }, actor: A });
    }
    recordOutcomes(e, { remote: true });
    expect(outcome(e, g).outcome).toBeNull();      // both workers merged, neither feature in main
    for (const f of [f1, f2]) {
      commitFile(f, `src/${f.id}.ts`, "y\n");
      insertEvidence(e, f.id, "commit", "commit", true, { sha: git(f.cwd, "rev-parse", "HEAD") }, A);
      git(dir, "merge", "--no-ff", "-m", "m", f.branch);
    }
    recordOutcomes(e, { remote: true });
    expect(outcome(e, g).outcome).toBe("clean");
  });
});
