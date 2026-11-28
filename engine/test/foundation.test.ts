import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, openDb } from "../src/db";
import { realExec } from "../src/exec";
import { DEFAULT_POLICY_YAML, initRepo, loadPolicy, parsePolicy } from "../src/policy";
import { findRepo } from "../src/repo";
import { makeRepo } from "./helpers";

const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e as { code?: string; message: string }; }
  throw new Error("did not throw");
};

test("findRepo outside git throws NOT_A_REPO", () => {
  const dir = mkdtempSync(join(tmpdir(), "estack-nogit-"));
  expect(codeOf(() => findRepo(dir)).code).toBe("NOT_A_REPO");
});

test("findRepo from a linked worktree resolves the main checkout", () => {
  const main = makeRepo();
  const wt = join(mkdtempSync(join(tmpdir(), "estack-wt-")), "wt");
  execFileSync("git", ["worktree", "add", wt, "-b", "side"], { cwd: main, stdio: "ignore" });
  expect(findRepo(wt).root).toBe(realpathSync(main));
});

test("a repo without policy.yaml is not opted in", () => {
  const repo = findRepo(makeRepo());
  expect(repo.optedIn).toBe(false);
  const e = codeOf(() => loadPolicy(repo));
  expect(e.code).toBe("NOT_OPTED_IN");
  expect(e.message).toBe("not an estack repository: run /estack:setup");
});

test("initRepo writes the three files and never overwrites", () => {
  const dir = makeRepo();
  expect(initRepo(dir).created).toEqual([".estack/policy.yaml", ".estack/brief.md", ".estack/.gitignore"]);
  expect(findRepo(dir).optedIn).toBe(true);
  expect(readFileSync(join(dir, ".estack/.gitignore"), "utf8")).toBe("state.db*\n");
  const brief = join(dir, ".estack/brief.md");
  writeFileSync(brief, "mine");
  expect(initRepo(dir).created).toEqual([]);
  expect(readFileSync(brief, "utf8")).toBe("mine");
});

test("default policy parses and has the spec's task types", () => {
  const p = parsePolicy(DEFAULT_POLICY_YAML);
  expect(Object.keys(p.task_types)).toEqual(["feature", "bugfix", "refactor", "spike"]);
  expect(p.task_types.feature).toEqual(["plan", "reuse_check", "implement", "test", "verify", "review", "pr"]);
});

test("a task type naming an unknown step is POLICY_INVALID", () => {
  const yaml = DEFAULT_POLICY_YAML.replace(/^task_types:\n(?:  .*\n)+/m, 'task_types:\n  x: [plan, dance]\n');
  const e = codeOf(() => parsePolicy(yaml));
  expect(e.code).toBe("POLICY_INVALID");
  expect(e.message).toContain("dance");
});

test("a task type naming an inherited property such as toString is POLICY_INVALID", () => {
  const yaml = DEFAULT_POLICY_YAML.replace(/^task_types:\n(?:  .*\n)+/m, 'task_types:\n  x: [plan, toString]\n');
  const e = codeOf(() => parsePolicy(yaml));
  expect(e.code).toBe("POLICY_INVALID");
  expect(e.message).toContain("toString");
});

test("openDb twice is idempotent and sets WAL", () => {
  const path = join(mkdtempSync(join(tmpdir(), "estack-db-")), "state.db");
  openDb(path).close();
  const db = openDb(path);
  expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "5" });
  db.close();
});

test("two connections writing at once both succeed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "estack-db-")), "state.db");
  const a = openDb(path);
  a.exec("BEGIN IMMEDIATE");
  const code = `
    const { DatabaseSync } = require("node:sqlite");
    const { parentPort, workerData } = require("node:worker_threads");
    try {
      const b = new DatabaseSync(workerData);
      b.exec("PRAGMA busy_timeout=5000");
      b.prepare("INSERT INTO events (at, actor, kind, task_id, payload_json) VALUES ('t','b','x',NULL,'{}')").run();
      b.close();
      parentPort.postMessage("ok");
    } catch (e) { parentPort.postMessage("error: " + e.message); }
  `;
  const worker = new Worker(code, { eval: true, workerData: path });
  const result = new Promise<string>((res) => worker.once("message", res));
  await new Promise((r) => setTimeout(r, 200));
  a.exec("COMMIT");
  expect(await result).toBe("ok");
  expect((a.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(1);
  a.close();
});

test("a version-2 database upgrades to 3 and keeps its rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "estack-mig3-")), "state.db");
  const old = new DatabaseSync(path);
  old.exec(MIGRATION_1);
  old.exec(MIGRATION_2);
  old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
  old.prepare(`INSERT INTO tasks (id, title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at)
    VALUES (1, 't', 'feature', 'g', 'd', 'open', 'main', '/x', 'abc', 's1/main', 't')`).run();
  old.prepare("INSERT INTO handovers (kind, task_id, from_session, created_at, auto, body_json) VALUES ('k', 1, 's1', 't', 0, '{}')").run();
  old.close();
  const db = openDb(path);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "5" });
  for (const t of ["code_queries", "duplicates"]) {
    expect(db.prepare("SELECT COUNT(*) c FROM " + t).get()).toMatchObject({ c: 0 });
  }
  expect(db.prepare("SELECT COUNT(*) c FROM tasks").get()).toMatchObject({ c: 1 });
  expect(db.prepare("SELECT COUNT(*) c FROM handovers").get()).toMatchObject({ c: 1 });
  expect(indexes(db)).toEqual(PHASE_5_INDEXES);
  db.close();
});

test("a version-3 database upgrades to 4: handovers gain a checkout, old rows keep null", () => {
  const path = join(mkdtempSync(join(tmpdir(), "estack-mig4-")), "state.db");
  const old = new DatabaseSync(path);
  old.exec(MIGRATION_1);
  old.exec(MIGRATION_2);
  old.exec(MIGRATION_3);
  old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
  old.prepare("INSERT INTO handovers (kind, task_id, from_session, created_at, auto, body_json) VALUES ('session', NULL, 's1', 't', 0, '{}')").run();
  old.close();
  const db = openDb(path);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "5" });
  expect(db.prepare("SELECT checkout FROM handovers").get()).toMatchObject({ checkout: null });
  db.close();
});

const PHASE_5_INDEXES = [
  { name: "claim_grants_task_path", tbl_name: "claim_grants" },
  { name: "claims_active", tbl_name: "claims" },
  { name: "code_queries_task_actor", tbl_name: "code_queries" },
  { name: "events_kind_task_actor", tbl_name: "events" },
];
const indexes = (db: DatabaseSync) =>
  db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name").all();

test("a new database has the indexes the map-first and reuse_check look-ups use", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "estack-idx-")), "state.db"));
  expect(indexes(db)).toEqual(PHASE_5_INDEXES);
  const plan = (sql: string) => (db.prepare("EXPLAIN QUERY PLAN " + sql).all() as { detail: string }[]).map((r) => r.detail).join("\n");
  expect(plan("SELECT 1 FROM events WHERE kind = 'map_first_denied' AND task_id = 1 AND actor = 'a' LIMIT 1")).toContain("events_kind_task_actor");
  expect(plan("SELECT 1 FROM code_queries WHERE task_id = 1 AND recorded_by = 'a' AND ok = 1 AND auto = 0 LIMIT 1")).toContain("code_queries_task_actor");
  db.close();
});

test("policy without code_map behaves as phase 4", () => {
  const phase4 = DEFAULT_POLICY_YAML.replace(/^code_map:.*\n(?:  .*\n)+/m, "");
  expect(phase4).not.toContain("code_map");
  expect(parsePolicy(phase4).code_map).toEqual({ enabled: false, exclude: [] });
});

test("initRepo writes code_map from its options", () => {
  const dir = makeRepo();
  initRepo(dir, { codeMap: true, exclude: ["dist/**"] });
  expect(loadPolicy(findRepo(dir)).code_map).toEqual({ enabled: true, exclude: ["dist/**"] });
});

test("exec run passes extra env", () => {
  const r = realExec.run("sh", ["-c", 'printf %s "$X"'], { cwd: tmpdir(), env: { X: "y" } });
  expect(r.stdout).toBe("y");
});

const NEW_TASK = `INSERT INTO tasks (id, title, type, goal, done_check, status, branch, cwd, base_sha, created_by, created_at)
  VALUES (?, 't', 'feature', 'g', 'd', 'open', 'main', '/x', 'abc', 's1/main', 't')`;

test("a version-4 database upgrades to 5 and keeps its rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "estack-mig5-")), "state.db");
  const old = new DatabaseSync(path);
  for (const m of [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4]) old.exec(m);
  old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  old.prepare(NEW_TASK).run(1);
  old.prepare("INSERT INTO handovers (kind, task_id, from_session, created_at, auto, body_json) VALUES ('k', 1, 's1', 't', 0, '{}')").run();
  old.close();
  const db = openDb(path);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "5" });
  expect(db.prepare("SELECT parent_id, task_group FROM tasks").get()).toMatchObject({ parent_id: null, task_group: null });
  expect(db.prepare("SELECT COUNT(*) c FROM handovers").get()).toMatchObject({ c: 1 });
  for (const t of ["task_areas", "task_deps", "plan_items", "overlap_accepts", "claims", "claim_grants"]) {
    expect(db.prepare("SELECT COUNT(*) c FROM " + t).get()).toMatchObject({ c: 0 });
  }
  db.close();
});

test("claims allow one active holder per target", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "estack-claims-")), "state.db"));
  db.prepare(NEW_TASK).run(1);
  db.prepare(NEW_TASK).run(2);
  const ins = db.prepare("INSERT INTO claims (task_id, kind, target, status, at) VALUES (?, 'file', 'a.ts', ?, 't')");
  ins.run(1, "active");
  expect(() => ins.run(2, "active")).toThrow(/UNIQUE/);
  ins.run(2, "released");
  db.prepare("UPDATE claims SET status = 'released' WHERE task_id = 1").run();
  ins.run(2, "active");
  db.close();
});

test("policy has claims.exempt and worktree_setup defaults", () => {
  const p = parsePolicy(DEFAULT_POLICY_YAML);
  expect(p.claims.exempt).toEqual(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
    "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "Gemfile.lock", "composer.lock"]);
  expect(p.commands.worktree_setup).toBeUndefined();
  expect(DEFAULT_POLICY_YAML).toContain("# worktree_setup:");
  const noClaims = DEFAULT_POLICY_YAML.replace(/^claims:.*\n(?:  .*\n)+/m, "");
  expect(noClaims).not.toContain("claims:");
  expect(parsePolicy(noClaims).claims.exempt).toContain("package-lock.json");
  const set = DEFAULT_POLICY_YAML.replace("# worktree_setup:", "worktree_setup:");
  expect(parsePolicy(set).commands.worktree_setup).toBeTruthy();
});

test("merge is a known step", () => {
  const yaml = DEFAULT_POLICY_YAML.replace(/^task_types:\n(?:  .*\n)+/m, "task_types:\n  worker: [implement, merge]\n");
  expect(parsePolicy(yaml).task_types.worker).toEqual(["implement", "merge"]);
});
