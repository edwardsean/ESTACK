import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_CLAIM_DIFF, allowEdit, checkEdit, claimStatus, claimSymbol, hasGrant, holderOf, isClaimExempt, passClaims, releaseClaim, releaseClaims, syncMerged } from "../src/claims";
import { openEngine, type Engine } from "../src/engine";
import { preCommit } from "../src/githooks";
import { runHook, type HookEvent } from "../src/hooks";
import { cancelTask } from "../src/owner";
import { initRepo } from "../src/policy";
import { completeStep, insertEvidence, startTask } from "../src/tasks";
import type { Actor, Task } from "../src/types";
import { fakeExec, makeRepo, writeFakeGraph } from "./helpers";
import { EngineError } from "../src/types";

const A: Actor = { session_id: "sa" };
const B: Actor = { session_id: "sb" };
const deps = { exec: fakeExec({}) };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function repo(extra = ""): string {
  const dir = makeRepo();
  initRepo(dir);
  if (extra) {
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8") + extra);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "estack");
  return dir;
}
function feature(e: Engine, dir: string, actor: Actor, title: string, goal = "g"): Task {
  return startTask(e, { title, type: "feature", goal, done_check: "d", actor, cwd: dir, worktree: true }).task;
}
function worker(e: Engine, f: Task, actor: Actor, title: string, group?: string): Task {
  return startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor, cwd: f.cwd, worktree: true, parent_task_id: f.id, group }).task;
}
const ev = (cwd: string, o: Partial<HookEvent>): HookEvent => ({ hook_event_name: "PreToolUse", session_id: "sa", cwd, ...o });
const edit = (t: Task, file: string, o: Partial<HookEvent> = {}) =>
  runHook("pre-tool-use", ev(t.cwd, { tool_name: "Edit", tool_input: { file_path: join(t.cwd, file) }, ...o }), deps) as any;
const reason = (r: any) => r?.hookSpecificOutput?.permissionDecisionReason as string | undefined;
const claims = (e: Engine) => e.db.prepare("SELECT task_id, target, status FROM claims ORDER BY id").all() as any[];
const kinds = (e: Engine, kind: string) => e.db.prepare("SELECT task_id, payload_json p FROM events WHERE kind = ? ORDER BY id").all(kind) as any[];

describe("file claims", { timeout: 60_000 }, () => {
  test("the first edit holds a file and another task's edit is denied with the CTO hint", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one", "do the first thing");
    const t2 = feature(e, dir, B, "two");
    expect(edit(t1, "src/a.ts")).toBeNull();
    expect(claims(e)).toEqual([{ task_id: t1.id, target: "src/a.ts", status: "active" }]);
    expect(kinds(e, "claim_taken")).toHaveLength(1);
    const r = edit(t2, "src/a.ts", { session_id: "sb" });
    expect(reason(r)).toBe(`src/a.ts is held by task #${t1.id} (goal: do the first thing); report to your CTO, which can check it with claim_status and allow it with allow_edit.`);
    expect(kinds(e, "claim_denied")).toHaveLength(1);
    expect(edit(t1, "src/a.ts")).toBeNull();
    expect(edit(t2, "src/other.ts", { session_id: "sb" })).toBeNull();
    expect(holderOf(e, "src/a.ts")?.task.id).toBe(t1.id);
  });

  test("exempt files and exempt_paths are never held", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    for (const f of ["package-lock.json", "web/yarn.lock", "docs/guide.txt", "README.md"]) {
      expect(isClaimExempt(e, f)).toBe(true);
      expect(edit(t1, f)).toBeNull();
      expect(edit(t2, f, { session_id: "sb" })).toBeNull();
    }
    expect(claims(e)).toEqual([]);
    expect(isClaimExempt(e, "src/a.ts")).toBe(false);
  });

  test("claims.exempt from policy is honoured", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    e.policy.claims.exempt = ["generated/**"];
    expect(isClaimExempt(e, "generated/x.ts")).toBe(true);
    expect(isClaimExempt(e, "package-lock.json")).toBe(false);
  });

  test("a task's own workers and its group are never blocked", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    const w1 = worker(e, f, A, "w1", "g1");
    const w2 = worker(e, f, A, "w2", "g1");
    const w3 = worker(e, f, A, "w3", "other");
    expect(checkEdit(e, f, "src/f.ts")).toEqual({ ok: true });
    expect(checkEdit(e, w1, "src/f.ts")).toEqual({ ok: true });        // child of the holder
    expect(checkEdit(e, w1, "src/w.ts")).toEqual({ ok: true });
    expect(checkEdit(e, f, "src/w.ts")).toEqual({ ok: true });         // parent of the holder
    expect(checkEdit(e, w2, "src/w.ts")).toEqual({ ok: true });        // same group
    const v = checkEdit(e, w3, "src/w.ts");
    expect(v).toMatchObject({ ok: false, holder: { id: w1.id } });
  });

  test("a grant lets another task edit", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    checkEdit(e, t1, "src/a.ts");
    expect(hasGrant(e, t2.id, "src/a.ts")).toBe(false);
    const c = holderOf(e, "src/a.ts")!.claim_id;
    e.db.prepare("INSERT INTO claim_grants (claim_id, task_id, path, reason, by, at) VALUES (?, ?, 'src/a.ts', 'r', 'cto', 'now')").run(c, t2.id);
    expect(hasGrant(e, t2.id, "src/a.ts")).toBe(true);
    expect(checkEdit(e, t2, "src/a.ts")).toEqual({ ok: true });
  });

  test("two tasks racing for a free file: one holds it", () => {
    const dir = repo();
    const e1 = openEngine(dir, deps);
    const e2 = openEngine(dir, deps);
    const t1 = feature(e1, dir, A, "one");
    const t2 = feature(e1, dir, B, "two");
    const r1 = checkEdit(e1, t1, "src/a.ts");
    const r2 = checkEdit(e2, t2, "src/a.ts");
    expect(r1).toEqual({ ok: true });
    expect(r2).toMatchObject({ ok: false, holder: { id: t1.id } });
    expect(claims(e1)).toHaveLength(1);
  });

  test("a lost insert race re-reads the holder instead of failing", () => {
    const dir = repo();
    const e1 = openEngine(dir, deps);
    const e2 = openEngine(dir, deps);
    const t1 = feature(e1, dir, A, "one");
    const t2 = feature(e1, dir, B, "two");
    // e2 saw no holder; e1 takes the file just before e2's write begins.
    const real = e2.db.exec.bind(e2.db);
    let raced = false;
    (e2.db as any).exec = (sql: string) => {
      if (!raced && /BEGIN IMMEDIATE/.test(sql)) {
        raced = true;
        checkEdit(e1, t1, "src/a.ts");
      }
      return real(sql);
    };
    const v = checkEdit(e2, t2, "src/a.ts");
    expect(raced).toBe(true);
    expect(v).toMatchObject({ ok: false, holder: { id: t1.id } });
    expect(claims(e1)).toHaveLength(1);
  });

  test("a worker's edit outside its worktree is denied", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    const w = worker(e, f, A, "work");
    const r = runHook("pre-tool-use", ev(w.cwd, { tool_name: "Edit", agent_id: "W", tool_input: { file_path: join(dir, "src/a.ts") } }), deps) as any;
    expect(reason(r)).toContain("No open estack task for this session");
    expect(claims(e)).toEqual([]);
  });

  test("pre-commit takes claims for files edited through Bash and refuses held ones", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    const stage = (t: Task, file: string) => {
      mkdirSync(join(t.cwd, file, ".."), { recursive: true });
      writeFileSync(join(t.cwd, file), "x\n");
      git(t.cwd, "add", file);
    };
    stage(t1, "src/shell.ts");
    expect(preCommit(e, t1.cwd)).toBeNull();
    expect(claims(e)).toEqual([{ task_id: t1.id, target: "src/shell.ts", status: "active" }]);
    expect(kinds(e, "claim_taken")[0].p).toContain("src/shell.ts");
    stage(t2, "src/shell.ts");
    stage(t2, "src/free.ts");
    const msg = preCommit(e, t2.cwd);
    expect(msg).toBe(`src/shell.ts is held by task #${t1.id} (goal: g); report to your CTO, which can check it with claim_status and allow it with allow_edit.`);
  });

  test("merge passes the worker's claims to the feature, and a cancelled task releases them", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    const w = worker(e, f, A, "work");
    expect(checkEdit(e, w, "src/w.ts")).toEqual({ ok: true });
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'merge'").run(w.id);
    git(w.cwd, "commit", "--allow-empty", "-m", "work");
    git(f.cwd, "merge", "--no-ff", "-m", "m", w.branch);
    completeStep(e, { task_id: w.id, step: "merge", evidence: { kind: "merged" }, actor: A });
    expect(claims(e)).toEqual([{ task_id: f.id, target: "src/w.ts", status: "active" }]);
    expect(kinds(e, "claim_passed")).toHaveLength(1);
    // Another task still can't take it; the feature holds it.
    const other = feature(e, dir, B, "other");
    expect(checkEdit(e, other, "src/w.ts")).toMatchObject({ ok: false, holder: { id: f.id } });
    // Cancelling the feature releases it.
    cancelTask(e, { task_id: f.id, reason: "x" }, {});
    expect(claims(e)).toEqual([{ task_id: f.id, target: "src/w.ts", status: "released" }]);
    expect(kinds(e, "claim_released")).toHaveLength(1);
    expect(checkEdit(e, other, "src/w.ts")).toEqual({ ok: true });
  });

  test("a release hands the file to the task holding a grant", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    const t3 = feature(e, dir, B, "three");
    checkEdit(e, t1, "src/a.ts");
    const c = holderOf(e, "src/a.ts")!.claim_id;
    const grant = (task: number) => Number(e.db.prepare("INSERT INTO claim_grants (claim_id, task_id, path, reason, by, at) VALUES (?, ?, 'src/a.ts', 'r', 'cto', 'now')").run(c, task).lastInsertRowid);
    grant(t2.id);
    const newest = grant(t3.id);
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t3.id);   // not open: skipped
    const g2 = grant(t2.id);
    releaseClaims(e, t1, A);
    expect(claims(e)).toEqual([
      { task_id: t1.id, target: "src/a.ts", status: "released" },
      { task_id: t2.id, target: "src/a.ts", status: "active" },
    ]);
    expect(newest).toBeLessThan(g2);
    expect(JSON.parse(kinds(e, "claim_taken").at(-1).p)).toMatchObject({ from_grant: g2 });
    expect(holderOf(e, "src/a.ts")?.task.id).toBe(t2.id);
  });

  test("passClaims moves only active claims", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    const w = worker(e, f, A, "work");
    checkEdit(e, w, "x.ts");
    releaseClaims(e, w, A);
    passClaims(e, w, f);
    expect(claims(e)).toEqual([{ task_id: w.id, target: "x.ts", status: "released" }]);
  });

  test("a feature merged into main gives up its claims and its engine-made worktree, at start_task time", () => {
    const dir = repo();
    const gh = (state: string) => ({ exec: fakeExec({ "pr view feat/1-feat --json state": { code: 0, stdout: JSON.stringify({ state }) } }) });
    const e = openEngine(dir, gh("OPEN"));
    const f = feature(e, dir, A, "feat");
    expect(f.branch).toBe("feat/1-feat");
    const other = feature(e, dir, B, "other");
    checkEdit(e, f, "src/a.ts");
    git(f.cwd, "commit", "--allow-empty", "-m", "work");
    insertEvidence(e, f.id, "implement", "commit", true, { sha: git(f.cwd, "rev-parse", "HEAD") }, A);
    syncMerged(e);
    expect(claims(e)[0].status).toBe("active");        // still open: left alone
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.id);
    syncMerged(e);
    expect(claims(e)).toEqual([{ task_id: f.id, target: "src/a.ts", status: "active" }]);
    expect(existsSync(f.cwd)).toBe(true);
    e.exec = gh("MERGED").exec;
    startTask(e, { title: "later", type: "feature", goal: "g", done_check: "d", actor: B, cwd: dir });
    expect(claims(e)).toEqual([{ task_id: f.id, target: "src/a.ts", status: "released" }]);
    expect(existsSync(f.cwd)).toBe(false);
    expect(existsSync(other.cwd)).toBe(true);
  });

  test("a worker merging into a cancelled feature releases its claims instead of passing them", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    const w = worker(e, f, A, "work");
    checkEdit(e, w, "src/w.ts");
    cancelTask(e, { task_id: f.id, reason: "x" }, {});
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name != 'merge'").run(w.id);
    git(w.cwd, "commit", "--allow-empty", "-m", "work");
    git(f.cwd, "merge", "--no-ff", "-m", "m", w.branch);
    completeStep(e, { task_id: w.id, step: "merge", evidence: { kind: "merged" }, actor: A });
    expect(claims(e)).toEqual([{ task_id: w.id, target: "src/w.ts", status: "released" }]);
    expect(kinds(e, "claim_passed")).toHaveLength(0);
  });

  test("holds never block a task in the same checkout", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = startTask(e, { title: "one", type: "feature", goal: "g", done_check: "d", actor: A, cwd: dir }).task;
    expect(checkEdit(e, t1, "src/a.ts")).toEqual({ ok: true });
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t1.id);
    const t2 = startTask(e, { title: "two", type: "feature", goal: "g", done_check: "d", actor: A, cwd: dir }).task;
    expect(edit({ ...t2, cwd: dir } as Task, "src/a.ts")).toBeNull();
    expect(checkEdit(e, t2, "src/a.ts")).toEqual({ ok: true });
    expect(claims(e)).toHaveLength(1);
  });

  test("with no origin, a done feature merged into local main releases its claims", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    checkEdit(e, f, "src/a.ts");
    git(f.cwd, "commit", "--allow-empty", "-m", "work");
    git(dir, "merge", "--no-ff", "-m", "m", f.branch);
    insertEvidence(e, f.id, "implement", "commit", true, { sha: git(f.cwd, "rev-parse", "HEAD") }, A);
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.id);
    syncMerged(e);
    expect(claims(e)[0].status).toBe("released");
    expect(existsSync(f.cwd)).toBe(false);
  });

  test("a done feature whose pr was closed unmerged releases its claims with a reason", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: fakeExec({ "pr view feat/1-feat --json state": { code: 0, stdout: JSON.stringify({ state: "CLOSED" }) } }) });
    const f = feature(e, dir, A, "feat");
    checkEdit(e, f, "src/a.ts");
    git(f.cwd, "commit", "--allow-empty", "-m", "work");
    insertEvidence(e, f.id, "implement", "commit", true, { sha: git(f.cwd, "rev-parse", "HEAD") }, A);
    syncMerged(e);
    expect(claims(e)[0].status).toBe("active");
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.id);
    syncMerged(e);
    expect(claims(e)[0].status).toBe("released");
    expect(JSON.parse(kinds(e, "claim_released")[0].p)).toMatchObject({ path: "src/a.ts", reason: "pr closed" });
    expect(existsSync(f.cwd)).toBe(true);
  });

  test("a kept worktree is logged once per reason", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    git(f.cwd, "commit", "--allow-empty", "-m", "work");
    git(dir, "merge", "--no-ff", "-m", "m", f.branch);
    insertEvidence(e, f.id, "implement", "commit", true, { sha: git(f.cwd, "rev-parse", "HEAD") }, A);
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.id);
    writeFileSync(join(f.cwd, "dirty.txt"), "x");
    syncMerged(e);
    syncMerged(e);
    expect(kinds(e, "worktree_kept")).toHaveLength(1);
  });

  test("pre-commit takes nothing when any path is refused, and nothing during a merge commit", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    checkEdit(e, t1, "src/held.ts");
    for (const f of ["src/free.ts", "src/held.ts"]) {
      mkdirSync(join(t2.cwd, "src"), { recursive: true });
      writeFileSync(join(t2.cwd, f), "x\n");
      git(t2.cwd, "add", f);
    }
    expect(preCommit(e, t2.cwd)).toContain("src/held.ts is held");
    expect(claims(e)).toEqual([{ task_id: t1.id, target: "src/held.ts", status: "active" }]);
    // During a merge commit nothing is checked or taken.
    writeFileSync(join(git(t2.cwd, "rev-parse", "--path-format=absolute", "--git-dir"), "MERGE_HEAD"), git(t2.cwd, "rev-parse", "HEAD") + "\n");
    expect(preCommit(e, t2.cwd)).toBeNull();
    expect(claims(e)).toHaveLength(1);
  });
});

const code = (fn: () => unknown): EngineError => { try { fn(); } catch (x) { return x as EngineError; } throw new Error("did not throw"); };

describe("claims fixes carried from task 5", { timeout: 60_000 }, () => {
  test("an open feature whose pr gh reports merged keeps its worktree and claims (only done tasks are synced)", () => {
    const dir = repo();
    const e = openEngine(dir, { exec: fakeExec({ "pr view feat/1-feat --json state": { code: 0, stdout: JSON.stringify({ state: "MERGED" }) } }) });
    const f = feature(e, dir, A, "feat");
    checkEdit(e, f, "src/a.ts");
    git(f.cwd, "commit", "--allow-empty", "-m", "work");
    git(dir, "merge", "--no-ff", "-m", "m", f.branch);
    syncMerged(e);
    expect(claims(e)).toEqual([{ task_id: f.id, target: "src/a.ts", status: "active" }]);
    expect(existsSync(f.cwd)).toBe(true);
  });

  test("pre-commit refuses a path another task took between its two passes", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    mkdirSync(join(t2.cwd, "src"), { recursive: true });
    for (const f of ["src/a.ts", "src/b.ts"]) {
      writeFileSync(join(t2.cwd, f), "x\n");
      git(t2.cwd, "add", f);
    }
    // Taking src/a.ts is the moment another task takes src/b.ts.
    e.db.exec(`CREATE TRIGGER race BEFORE INSERT ON claims WHEN NEW.target = 'src/a.ts' BEGIN
      INSERT INTO claims (task_id, kind, target, status, at) VALUES (${t1.id}, 'file', 'src/b.ts', 'active', 'x'); END`);
    const r = preCommit(e, t2.cwd);
    expect(r).toContain(`src/b.ts is held by task #${t1.id}`);
  });
});

describe("deciding on held files and helper names", { timeout: 60_000 }, () => {
  test("claim_status shows the holder's goal and its changes, committed and not", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one", "build the thing");
    expect(claimStatus(e, "src/a.ts")).toEqual({ path: "src/a.ts", holder: null, diff: "", grants: [] });
    checkEdit(e, t1, "src/a.ts");
    mkdirSync(join(t1.cwd, "src"), { recursive: true });
    writeFileSync(join(t1.cwd, "src/a.ts"), "committed line\n");
    git(t1.cwd, "add", "src/a.ts");
    git(t1.cwd, "commit", "-m", "a");
    writeFileSync(join(t1.cwd, "src/a.ts"), "committed line\nuncommitted line\n");
    const s = claimStatus(e, "src/a.ts");
    expect(s.holder).toEqual({ task_id: t1.id, title: "one", goal: "build the thing", cwd: t1.cwd });
    expect(s.diff).toContain("+committed line");
    expect(s.diff).toContain("+uncommitted line");
    writeFileSync(join(t1.cwd, "src/a.ts"), "y".repeat(MAX_CLAIM_DIFF * 2) + "\n");
    const big = claimStatus(e, "src/a.ts");
    expect(big.diff.endsWith("(truncated)")).toBe(true);
    expect(big.diff.length).toBeLessThan(MAX_CLAIM_DIFF + 40);
    rmSync(t1.cwd, { recursive: true, force: true });
    const gone = claimStatus(e, "src/a.ts");
    expect(gone.diff).toBe("");
    expect(gone.note).toMatch(/worktree is gone/);
  });

  test("the owning CTO allows an edit and the task then edits freely", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, A, "two");
    checkEdit(e, t1, "src/a.ts");
    expect(checkEdit(e, t2, "src/a.ts").ok).toBe(false);
    expect(code(() => allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: " ", actor: A, owner: false })).code).toBe("BAD_EVIDENCE");
    allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: "needs the type", actor: A, owner: false });
    expect(checkEdit(e, t2, "src/a.ts")).toEqual({ ok: true });
    expect(claimStatus(e, "src/a.ts").grants).toEqual([{ task_id: t2.id, reason: "needs the type", by: "sa/main", at: expect.any(String) }]);
    expect(JSON.parse(kinds(e, "claim_granted")[0].p)).toEqual({ path: "src/a.ts", holder: t1.id, by: "sa/main" });
    expect(code(() => allowEdit(e, { task_id: t2.id, path: "src/free.ts", reason: "x", actor: A, owner: false })).message).toMatch(/not held/);
  });

  test("across CTOs allow_edit names the owner command", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    checkEdit(e, t1, "src/a.ts");
    const x = code(() => allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: "x", actor: B, owner: false }));
    expect(x.code).toBe("OWNER_ONLY");
    expect(x.message).toContain(`estack allow --task ${t2.id} --path src/a.ts --reason <text>`);
    allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: "ok", actor: { session_id: "owner" }, owner: true });
    expect(checkEdit(e, t2, "src/a.ts").ok).toBe(true);
  });

  test("release frees a stale hold, and a path nobody holds is an error", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, B, "two");
    checkEdit(e, t1, "src/a.ts");
    releaseClaim(e, "src/a.ts", "stale");
    expect(claims(e)).toEqual([{ task_id: t1.id, target: "src/a.ts", status: "released" }]);
    expect(JSON.parse(kinds(e, "claim_released")[0].p)).toMatchObject({ path: "src/a.ts", reason: "stale" });
    expect(checkEdit(e, t2, "src/a.ts").ok).toBe(true);
    expect(code(() => releaseClaim(e, "src/zzz.ts", "x")).message).toMatch(/not held/);
    expect(code(() => releaseClaim(e, "src/a.ts", " ")).code).toBe("BAD_EVIDENCE");
  });

  test("claim_symbol returns the existing helper, another task's claim, or claims it", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const f = feature(e, dir, A, "feat");
    const w = worker(e, f, A, "work");
    const w2 = worker(e, f, A, "more");
    // Only the parent has a graph: the worker falls back to it.
    writeFakeGraph(f.cwd,
      [{ id: "file:src/utils.ts", label: "utils.ts", source_file: "src/utils.ts", source_location: "L1" },
        { id: "fd", label: "formatDate()", source_file: "src/utils.ts", source_location: "L7" }],
      [{ source: "file:src/utils.ts", target: "fd", relation: "contains", confidence: "EXTRACTED", source_file: "src/utils.ts", source_location: "L7" }]);
    expect(claimSymbol(e, { task_id: w.id, name: "format_date", file: "src/new.ts", actor: A })).toEqual({ status: "exists", file: "src/utils.ts", line: 7 });
    expect(claimSymbol(e, { task_id: w.id, name: "parseMoney", file: "src/money.ts", actor: A })).toEqual({ status: "claimed" });
    expect(claimSymbol(e, { task_id: w2.id, name: "parse_money", file: "src/other.ts", actor: A })).toEqual({ status: "claimed_by", task_id: w.id });
    expect(claimSymbol(e, { task_id: w.id, name: "parseMoney", file: "src/money.ts", actor: A })).toEqual({ status: "claimed" });
    expect(e.db.prepare("SELECT task_id, kind, target, status FROM claims WHERE kind = 'new_symbol'").all()).toEqual([
      { task_id: w.id, kind: "new_symbol", target: "parseMoney", status: "active" }]);
    expect(JSON.parse(kinds(e, "symbol_claimed")[0].p)).toMatchObject({ name: "parseMoney", file: "src/money.ts" });
  });

  test("a worker subagent in the CTO's session cannot allow edits", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, A, "two");
    checkEdit(e, t1, "src/a.ts");
    const x = code(() => allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: "x", actor: { session_id: "sa", agent_id: "w" }, owner: false }));
    expect(x.code).toBe("OWNER_ONLY");
    expect(x.message).toContain("a worker cannot allow edits");
    expect(hasGrant(e, t2.id, "src/a.ts")).toBe(false);
  });

  test("claim_status shows a file the holder created and has not staged", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    checkEdit(e, t1, "src/new.ts");
    mkdirSync(join(t1.cwd, "src"), { recursive: true });
    writeFileSync(join(t1.cwd, "src/new.ts"), "export const brandNew = 1;\n");
    const s = claimStatus(e, "src/new.ts");
    expect(s.diff).toContain("+export const brandNew = 1;");
    expect(s.note).toBeUndefined();
  });

  test("release hands the file to the newest open grant, like any other release", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, A, "two");
    checkEdit(e, t1, "src/a.ts");
    allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: "x", actor: A, owner: false });
    releaseClaim(e, "src/a.ts", "stale");
    expect(claims(e)).toEqual([{ task_id: t1.id, target: "src/a.ts", status: "released" }, { task_id: t2.id, target: "src/a.ts", status: "active" }]);
  });

  test("allow_edit is idempotent, needs an open task, and paths are normalised to the checkout", () => {
    const dir = repo();
    const e = openEngine(dir, deps);
    const t1 = feature(e, dir, A, "one");
    const t2 = feature(e, dir, A, "two");
    checkEdit(e, t1, "src/a.ts");
    for (const p of ["src/a.ts", "./src/a.ts", join(t1.cwd, "src/a.ts")]) {
      allowEdit(e, { task_id: t2.id, path: p, reason: "x", actor: A, owner: false });
    }
    expect(e.db.prepare("SELECT COUNT(*) c FROM claim_grants").get()).toEqual({ c: 1 });
    expect(claimStatus(e, "./src/a.ts").holder?.task_id).toBe(t1.id);
    e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t2.id);
    expect(code(() => allowEdit(e, { task_id: t2.id, path: "src/a.ts", reason: "x", actor: A, owner: false })).code).toBe("TASK_CLOSED");
    expect(code(() => claimSymbol(e, { task_id: t2.id, name: "foo", file: "x", actor: A })).code).toBe("TASK_CLOSED");
  });
});
