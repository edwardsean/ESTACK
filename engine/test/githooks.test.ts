import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { openEngine } from "../src/engine";
import { installGitHooks } from "../src/githooks";
import { startTask } from "../src/tasks";
import { makeRepo } from "./helpers";

const root = resolve(__dirname, "../..");
const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "estack-shim-")));
const shim = join(shimDir, "estack.mjs");
writeFileSync(shim, `import { spawnSync } from "node:child_process";
const r = spawnSync(${JSON.stringify(join(root, "node_modules/.bin/tsx"))}, [${JSON.stringify(join(root, "engine/src/cli.ts"))}, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });
process.exit(r.status ?? 1);
`);

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
function gitTry(cwd: string, agent: boolean, ...a: string[]) {
  const env = { ...process.env, CLAUDECODE: agent ? "1" : "" };
  return spawnSync("git", a, { cwd, env, encoding: "utf8" });
}
function setup() {
  const dir = makeRepo();
  const io = { cwd: dir, env: {}, out: () => {}, err: () => {} };
  expect(main(["init", "--engine", shim], io)).toBe(0);
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "estack-bare-")));
  git(bare, "init", "--bare");
  git(dir, "remote", "add", "origin", bare);
  return { dir };
}
const stage = (dir: string, file: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), "x\n");
  git(dir, "add", file);
};
const hook = (dir: string, n: string) => join(git(dir, "rev-parse", "--path-format=absolute", "--git-path", "hooks"), n);

describe("git hooks", { timeout: 60_000 }, () => {
  test("install writes both hooks, executable, and is idempotent", () => {
    const { dir } = setup();
    for (const n of ["pre-commit", "pre-push"]) {
      expect(statSync(hook(dir, n)).mode & 0o111).toBeTruthy();
      expect(readFileSync(hook(dir, n), "utf8")).toContain("# estack-managed-hook");
    }
    const before = readFileSync(hook(dir, "pre-commit"), "utf8");
    const r = installGitHooks(dir, shim);
    expect(readFileSync(hook(dir, "pre-commit"), "utf8")).toBe(before);
    expect(r.chained).toEqual([]);
    expect(existsSync(hook(dir, "pre-commit") + ".estack-prev")).toBe(false);
  });

  test("an existing hook is chained and still runs", () => {
    const dir = makeRepo();
    const marker = join(dir, "marker.txt");
    writeFileSync(hook(dir, "pre-commit"), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
    const r = installGitHooks(dir, shim);
    expect(r.chained).toEqual(["pre-commit"]);
    git(dir, "config", "user.name", "T");
    writeFileSync(join(dir, "a.txt"), "a");
    git(dir, "add", "a.txt");
    const c = gitTry(dir, false, "commit", "-m", "a");
    expect(c.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  test("owner commit without a task passes (no CLAUDECODE)", () => {
    const { dir } = setup();
    stage(dir, "src/a.ts");
    expect(gitTry(dir, false, "commit", "-m", "a").status).toBe(0);
  });

  test("agent commit of code without a task is refused", () => {
    const { dir } = setup();
    stage(dir, "src/a.ts");
    const r = gitTry(dir, true, "commit", "-m", "a");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no open estack task");
  });

  test("agent commit of only exempt files passes", () => {
    const { dir } = setup();
    stage(dir, "docs/a.md");
    const r = gitTry(dir, true, "commit", "-m", "a");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("agent commit touching a protected path is refused", () => {
    const { dir } = setup();
    stage(dir, ".env.local");
    const r = gitTry(dir, true, "commit", "-m", "a");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("protected");
  });

  test("agent push without verify is refused; with verify it passes", () => {
    const { dir } = setup();
    const e = openEngine(dir);
    const t = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: "s" }, cwd: dir });
    const r = gitTry(dir, true, "push", "origin", "main");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`branch main has no verify evidence (task #${t.task.id})`);
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name = 'verify'").run(t.task.id);
    e.db.close();
    const ok = gitTry(dir, true, "push", "origin", "main");
    expect(ok.stderr).not.toContain("estack:");
    expect(ok.status).toBe(0);
  });

  test("owner push without a task passes", () => {
    const { dir } = setup();
    expect(gitTry(dir, false, "push", "origin", "main").status).toBe(0);
  });
});
