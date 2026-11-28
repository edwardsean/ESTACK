import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { openEngine } from "../src/engine";
import { installGitHooks } from "../src/githooks";
import { runHook } from "../src/hooks";
import { recordOverride, skipStep } from "../src/owner";
import { startTask } from "../src/tasks";
import { makeRepo, tempDir } from "./helpers";

const root = resolve(__dirname, "../..");
const shimDir = tempDir("estack-shim-");
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
  expect(main(["init", "--engine", shim, "--code-map", "off"], io)).toBe(0);
  const bare = tempDir("estack-bare-");
  git(bare, "init", "--bare", "-b", "main");
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

  test("init installs the four map hooks", () => {
    const { dir } = setup();
    for (const n of ["post-commit", "post-checkout", "post-merge", "post-rewrite"]) {
      expect(statSync(hook(dir, n)).mode & 0o111).toBeTruthy();
      expect(readFileSync(hook(dir, n), "utf8")).toContain("# estack-managed-hook");
    }
  });

  test("map hooks run in the background and never check CLAUDECODE", () => {
    const { dir } = setup();
    const body = readFileSync(hook(dir, "post-commit"), "utf8");
    expect(body).toContain("nohup");
    expect(body).toContain("map-hook post-commit </dev/null >/dev/null 2>&1 &");
    expect(body).toContain("exit 0");
    expect(body).not.toContain("CLAUDECODE");
  });

  test("an existing post-commit hook is chained, even when it fails", () => {
    const dir = makeRepo();
    const marker = join(dir, "pc-marker.txt");
    writeFileSync(hook(dir, "post-commit"), `#!/bin/sh\necho ran > '${marker}'\nexit 3\n`, { mode: 0o755 });
    installGitHooks(dir, join(dir, "no-such-engine.mjs"));
    expect(existsSync(hook(dir, "post-commit") + ".estack-prev")).toBe(true);
    const r = gitTry(dir, false, "commit", "--allow-empty", "-m", "x");
    expect(r.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toContain("ran");
  });

  test("a commit returns without waiting for the map", () => {
    const dir = makeRepo();
    const stubDir = tempDir("estack-stub-");
    const stub = join(stubDir, "estack.mjs");
    const pidFile = join(stubDir, "pid");
    writeFileSync(stub, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 3000);\n`);
    installGitHooks(dir, stub);
    const t0 = Date.now();
    const r = gitTry(dir, false, "commit", "--allow-empty", "-m", "x");
    const took = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(took).toBeLessThan(1500);
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) spawnSync("sleep", ["0.1"]);
    try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch { /* already gone */ }
  });

  test("a missing engine makes a map hook exit 0 silently", () => {
    const dir = makeRepo();
    installGitHooks(dir, join(dir, "gone.mjs"));
    const home = tempDir("estack-home-");
    const r = spawnSync("git", ["commit", "--allow-empty", "-m", "x"], { cwd: dir, env: { ...process.env, HOME: home, CLAUDECODE: "" }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("engine not found");
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

  test("a foreign hook that replaces ours is chained too; the original is kept", () => {
    const dir = makeRepo();
    const a = join(dir, "a.marker"), b = join(dir, "b.marker");
    writeFileSync(hook(dir, "pre-commit"), `#!/bin/sh\necho a > '${a}'\n`, { mode: 0o755 });
    installGitHooks(dir, shim);
    writeFileSync(hook(dir, "pre-commit"), `#!/bin/sh\necho b > '${b}'\n`, { mode: 0o755 });
    const r = installGitHooks(dir, shim);
    expect(r.chained).toEqual(["pre-commit"]);
    expect(existsSync(hook(dir, "pre-commit") + ".estack-prev")).toBe(true);
    expect(existsSync(hook(dir, "pre-commit") + ".estack-prev.2")).toBe(true);
    writeFileSync(join(dir, "x.txt"), "x");
    git(dir, "add", "x.txt");
    expect(gitTry(dir, false, "commit", "-m", "x").status).toBe(0);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test("core.hooksPath set: nothing is installed and the message says why", () => {
    const dir = makeRepo();
    git(dir, "config", "core.hooksPath", ".githooks");
    mkdirSync(join(dir, ".githooks"));
    let out = "";
    const io = { cwd: dir, env: {}, out: (s: string) => (out += s), err: () => {} };
    expect(main(["init", "--engine", shim, "--code-map", "off"], io)).toBe(0);
    expect(out).toContain("git hooks not installed: core.hooksPath is set (.githooks)");
    expect(readdirSync(join(dir, ".githooks"))).toEqual([]);
  });

  test("a chained pre-push hook receives the ref list on stdin", () => {
    const { dir } = setup();
    const marker = join(dir, "stdin.marker");
    const e = openEngine(dir);
    const t = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: "s" }, cwd: dir });
    e.db.prepare("UPDATE steps SET status = 'done' WHERE task_id = ? AND name = 'verify'").run(t.task.id);
    e.db.close();
    writeFileSync(hook(dir, "pre-push") + ".estack-prev", `#!/bin/sh\ncat > '${marker}'\n`, { mode: 0o755 });
    const r = gitTry(dir, true, "push", "origin", "main");
    expect(r.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toContain("refs/heads/main");
  });

  const ctoPush = (dir: string, id: string) => runHook("pre-tool-use", {
    hook_event_name: "PreToolUse", session_id: "s", cwd: dir, tool_name: "Bash",
    tool_input: { command: "git push origin main" }, tool_use_id: id,
  }) as any;

  test("F1 one override: the Bash gate asks without spending it, pre-push spends it once", () => {
    const { dir } = setup();
    const e = openEngine(dir);
    recordOverride(e, { action: "git_push", reason: "hotfix" }, {});
    e.db.close();
    const r = ctoPush(dir, "t1");
    expect(r.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain("override");
    // owner approved: the agent's push runs through the installed hooks
    const ok = gitTry(dir, true, "push", "origin", "main");
    expect(ok.stderr).not.toContain("estack:");
    expect(ok.status).toBe(0);
    git(dir, "commit", "--allow-empty", "-m", "more");
    const again = gitTry(dir, true, "push", "origin", "main");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("no estack task for branch main");
  });

  test("F6 a skipped verify: the Bash gate asks and the agent push passes", () => {
    const { dir } = setup();
    const e = openEngine(dir);
    const t = startTask(e, { title: "t", type: "bugfix", goal: "g", done_check: "d", actor: { session_id: "s" }, cwd: dir });
    for (const s of ["reproduce", "reuse_check", "fix", "test", "verify"]) {
      skipStep(e, { task_id: t.task.id, step: s, reason: "owner" }, {});
    }
    e.db.close();
    const r = ctoPush(dir, "t2");
    expect(r.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain(`task #${t.task.id}`);
    const ok = gitTry(dir, true, "push", "origin", "main");
    expect(ok.stderr).not.toContain("estack:");
    expect(ok.status).toBe(0);
  });

  test("F9 a missing engine falls back to the newest plugin cache copy, else says re-run setup", () => {
    const dir = makeRepo();
    const gone = join(tempDir("estack-gone-"), "estack.mjs");
    copyFileSync(shim, gone);
    expect(main(["init", "--engine", gone, "--code-map", "off"], { cwd: dir, env: {}, out: () => {}, err: () => {} })).toBe(0);
    rmSync(gone);
    const home = tempDir("estack-home-");
    const commit = () => spawnSync("git", ["commit", "-m", "a"], { cwd: dir, env: { ...process.env, CLAUDECODE: "1", HOME: home }, encoding: "utf8" });
    stage(dir, "src/a.ts");
    const none = commit();
    expect(none.status).not.toBe(0);
    expect(none.stderr).toContain("engine not found");
    expect(none.stderr).toContain("re-run /estack:setup");
    for (const [ver, body] of [["0.9.0", `process.stderr.write("old engine ran\\n"); process.exit(7);\n`], ["0.10.0", null]] as const) {
      const d = join(home, ".claude/plugins/cache/estack/estack", ver, "engine");
      mkdirSync(d, { recursive: true });
      if (body === null) copyFileSync(shim, join(d, "estack.mjs"));
      else writeFileSync(join(d, "estack.mjs"), body);
    }
    const r = commit();
    expect(r.stderr).not.toContain("old engine ran");
    expect(r.stderr).toContain("no open estack task");
    expect(r.status).not.toBe(0);
  });
});
