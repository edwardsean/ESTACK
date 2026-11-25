import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { openDb } from "../src/db";
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

test("openDb twice is idempotent and sets WAL", () => {
  const path = join(mkdtempSync(join(tmpdir(), "estack-db-")), "state.db");
  openDb(path).close();
  const db = openDb(path);
  expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "1" });
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
