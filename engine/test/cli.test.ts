import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { openEngine } from "../src/engine";
import { saveSessionHandover, saveTaskHandover } from "../src/handover";
import { allowEdit, checkEdit, claimSymbol } from "../src/claims";
import { removeWorktree } from "../src/worktree";
import { getTask, startTask } from "../src/tasks";
import { HAS_GRAPHIFY, fakeExec, makeRepo, writeFakeGraph } from "./helpers";
import { realExec, type Exec } from "../src/exec";

// Graphify scripted as missing unless a test opts in, so init leaves the map off on any machine.
function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, exec: Exec = fakeExec({ graphify: { code: 127 } })) {
  let out = "", err = "";
  const status = main(args, { cwd, env, out: (s) => (out += s), err: (s) => (err += s), exec });
  return { status, out, err };
}
function setup() {
  const dir = makeRepo();
  expect(run(dir, ["init"]).status).toBe(0);
  const e = openEngine(dir);
  const t = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: "s" }, cwd: dir });
  return { dir, e, id: t.task.id };
}

describe("cli", () => {
  test("outside an opted-in repo every command prints one line and exits 1", () => {
    const dir = makeRepo();
    const r = run(dir, ["status"]);
    expect(r.status).toBe(1);
    expect(r.err).toBe("estack: not an estack repository: run /estack:setup\n");
  });

  test("map-hook with the map off does nothing and exits 0", () => {
    const { dir } = setup();
    for (const name of ["post-commit", "post-checkout", "post-merge", "post-rewrite"]) {
      const r = run(dir, ["map-hook", name]);
      expect(r.status).toBe(0);
      expect(r.out + r.err).toBe("");
    }
    const e = openEngine(dir);
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'map_built'").get()).toEqual({ n: 0 });
  });

  test("map-hook outside an opted-in repo exits 0", () => {
    const dir = makeRepo();
    const r = run(dir, ["map-hook", "post-commit"]);
    expect(r.status).toBe(0);
    expect(r.err).toBe("");
  });

  test("init then status shows no open tasks", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    const r = run(dir, ["status"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("no open tasks");
  });

  test("skip under CLAUDECODE=1 is refused as owner-only", () => {
    const { dir, id } = setup();
    const r = run(dir, ["skip", "--task", String(id), "--step", "plan", "--reason", "x"], { CLAUDECODE: "1" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("normal terminal");
  });

  test("skip from a normal terminal marks the step skipped and logs an event", () => {
    const { dir, id } = setup();
    const r = run(dir, ["skip", "--task", String(id), "--step", "plan", "--reason", "not needed"]);
    expect(r.status).toBe(0);
    const e = openEngine(dir);
    expect(getTask(e, id).steps.find((s) => s.name === "plan")!.status).toBe("skipped");
    const ev = e.db.prepare("SELECT payload_json FROM events WHERE kind='step_skipped'").get() as { payload_json: string };
    expect(ev.payload_json).toContain("not needed");
  });

  test("cancel closes the task", () => {
    const { dir, id } = setup();
    expect(run(dir, ["cancel", "--task", String(id), "--reason", "r"]).status).toBe(0);
    expect(getTask(openEngine(dir), id).task.status).toBe("cancelled");
  });

  test("override writes an approvals row with decision override", () => {
    const { dir } = setup();
    expect(run(dir, ["override", "git_push", "--reason", "ok"]).status).toBe(0);
    const db = openEngine(dir).db;
    const row = db.prepare("SELECT action, command, decision FROM approvals").get() as { action: string; command: string; decision: string };
    expect(row).toEqual({ action: "git_push", command: "", decision: "override" });
    const ev = db.prepare("SELECT payload_json FROM events WHERE kind='override'").get() as { payload_json: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ action: "git_push", reason: "ok" });
  });

  test("C4 override of an unknown action exits 1 and names the valid ones", () => {
    const { dir } = setup();
    const r = run(dir, ["override", "push", "--reason", "x"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("unknown action push");
    expect(r.err).toContain("git_push");
    expect(openEngine(dir).db.prepare("SELECT COUNT(*) c FROM approvals").get()).toEqual({ c: 0 });
  });

  test("unknown command exits 2 with usage", () => {
    const dir = makeRepo();
    const r = run(dir, ["bogus"]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("usage");
  });
  test("an internal error prints one line with no stack and exits 1", () => {
    const dir = makeRepo();
    expect(run(dir, ["init"]).status).toBe(0);
    for (const f of ["state.db", "state.db-wal", "state.db-shm"]) rmSync(join(dir, ".estack", f), { force: true });
    mkdirSync(join(dir, ".estack", "state.db"));
    const r = run(dir, ["status"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^estack: internal error: [^\n]+\n$/);
  });
  test("run exits 0 when the check passes and 3 when it ran but failed", () => {
    for (const [cmd, status] of [["true", 0], ["exit 4", 3]] as const) {
      const { dir, e, id } = setup();
      const p = join(dir, ".estack", "policy.yaml");
      writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, `  test: "${cmd}"`));
      for (const s of ["plan", "reuse_check", "implement"]) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, s);
      const r = run(dir, ["run", "--task", String(id), "--step", "test"]);
      expect(r.status, r.err).toBe(status);
    }
  });
});

describe("cli hook", () => {
  test("pre-tool-use reads stdin and prints a deny for a code edit with no task", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    let out = "", err = "";
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: dir, tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    const status = main(["hook", "pre-tool-use"], { cwd: dir, env: {}, out: (s) => (out += s), err: (s) => (err += s), stdin });
    expect(status).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("invalid stdin: deny for pre-tool-use, nothing for others", () => {
    const dir = makeRepo();
    const go = (name: string) => {
      let out = "";
      const status = main(["hook", name], { cwd: dir, env: {}, out: (s) => (out += s), err: () => {}, stdin: "not json" });
      return { status, out };
    };
    const a = go("pre-tool-use");
    expect(a.status).toBe(0);
    expect(JSON.parse(a.out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(go("stop")).toEqual({ status: 0, out: "" });
  });
  test("estack handovers lists pending handovers, else says none", () => {
    const { dir, e, id } = setup();
    expect(run(dir, ["handovers"]).out).toBe("no pending handovers\n");
    const th = saveTaskHandover(e, id, {}, { session_id: "s" });
    const r = run(dir, ["handovers"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(new RegExp(`^#${th.id} task #${id} \\S+ from s manual in main next: #${id} plan\\n$`));
    const sh = saveSessionHandover(e, { goal: "g", workers_done: true }, { session_id: "s" });
    const s = run(dir, ["handovers"]).out;
    expect(s).toMatch(new RegExp(`^#${sh.id} session \\S+ from s manual in main next: #\\d+ plan\\n$`));
    const j = JSON.parse(run(dir, ["handovers", "--json"]).out);
    expect(j).toHaveLength(1);
    expect(j[0].kind).toBe("session");
  });

  test("map update with the map off says so and exits 0", () => {
    const { dir } = setup();
    const r = run(dir, ["map", "update"]);
    expect(r.status).toBe(0);
    expect(r.out).toBe("the code map is off (code_map.enabled is false in .estack/policy.yaml)\n");
  });

  test("map status lists folder shares", () => {
    const { dir } = setup();
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("enabled: false", "enabled: true"));
    const n = (id: string, f: string) => ({ id, label: `${id}()`, source_file: f, source_location: "L2" });
    writeFakeGraph(dir, [n("a", "src/a.ts"), n("b", "src/orders/b.ts"), n("c", "src/orders/c.ts"), n("d", "dist/d.js")], []);
    const r = run(dir, ["map", "status"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("main: built at abc1234, 4 entries, 4 files\n  src 75%\n    src/orders 50%\n  dist 25%\n");
    expect(JSON.parse(run(dir, ["map", "status", "--json"]).out).checkouts[0].entries).toBe(4);
  });
});

describe("cli init and the code map", () => {
  const policyOf = (dir: string) => readFileSync(join(dir, ".estack", "policy.yaml"), "utf8");

  test("init with --code-map off writes enabled false", () => {
    const dir = makeRepo();
    const r = run(dir, ["init", "--code-map", "off"], {}, fakeExec({ graphify: { code: 0, stdout: "graphify 0.9.121\n" } }));
    expect(r.status).toBe(0);
    expect(policyOf(dir)).toMatch(/enabled: false/);
    expect(r.out).not.toContain("Graphify not found");
  });

  test("init with --exclude writes the list", () => {
    const dir = makeRepo();
    const r = run(dir, ["init", "--exclude", "dist/**,vendor/**"]);
    expect(r.status).toBe(0);
    const e = openEngine(dir);
    expect(e.policy.code_map.exclude).toEqual(["dist/**", "vendor/**"]);
  });

  const NOT_FOUND = 'code map off: Graphify not found. Install it with uv tool install "graphifyy>=0.9.121,<0.10", then add a code_map block to .estack/policy.yaml yourself (see /estack:setup) and run "estack map update".\n';
  const NOT_APPLIED = "policy.yaml already exists, so --code-map and --exclude were not applied; to change the code map, edit the code_map block in .estack/policy.yaml yourself.\n";
  const supportedGraphify = () => fakeExec({ graphify: { code: 0, stdout: "graphify 0.9.121\n" } });

  test("init without Graphify turns the map off and says how to turn it on later", () => {
    const dir = makeRepo();
    const r = run(dir, ["init"]);
    expect(r.status).toBe(0);
    expect(openEngine(dir).policy.code_map.enabled).toBe(false);
    expect(r.out).toContain(NOT_FOUND);
    expect(r.out).not.toContain("re-run setup");
  });

  test("re-running init on a policy with no code_map, without Graphify, says how to turn the map on", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, policyOf(dir).replace(/^code_map:.*\n(?:  .*\n)+/m, ""));
    const r = run(dir, ["init"]);
    expect(r.out).toContain("already initialised\n");
    expect(r.out).toContain(NOT_FOUND);
  });

  test("init on an existing policy applies neither --code-map nor --exclude, and says so", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    const before = policyOf(dir);
    for (const flags of [["--code-map", "on"], ["--exclude", "dist/**"], ["--code-map", "off", "--exclude", "x/**"]]) {
      const r = run(dir, ["init", ...flags], {}, supportedGraphify());
      expect(r.status).toBe(0);
      expect(r.out).toContain(NOT_APPLIED);
      expect(policyOf(dir)).toBe(before);
    }
    expect(run(dir, ["init"]).out).not.toContain(NOT_APPLIED);
  });

  test("init on an existing policy with the map on does not call the map off", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, policyOf(dir).replace("enabled: false", "enabled: true"));
    expect(run(dir, ["init"]).out).not.toContain("code map off");
  });

  test("init with a supported Graphify turns the map on, builds it and prints folder shares", () => {
    const dir = makeRepo();
    const n = (id: string, f: string) => ({ id, label: `${id}()`, source_file: f, source_location: "L2" });
    writeFakeGraph(dir, [n("a", "src/a.ts"), n("b", "src/orders/b.ts"), n("c", "lib/c.ts")], []);
    const r = run(dir, ["init"], {}, supportedGraphify());
    expect(r.status).toBe(0);
    expect(openEngine(dir).policy.code_map.enabled).toBe(true);
    expect(r.out).toMatch(/^map built for main: 3 entries, 3 files, \d+ms$/m);
    expect(r.out).toContain("folder shares:\n  src 67%\n    src/orders 33%\n  lib 33%\n");
  });

  const OFF_LATER = "; nothing to map yet. Turn it on later by editing the code_map block in .estack/policy.yaml.\n";

  test("init turns its own new policy's map off when the first build fails", () => {
    const dir = makeRepo();
    const exec = fakeExec({ "graphify --version": { code: 0, stdout: "graphify 0.9.121\n" }, graphify: { code: 1, stderr: "boom" } });
    const r = run(dir, ["init"], {}, exec);
    expect(r.status).toBe(0);
    expect(openEngine(dir).policy.code_map.enabled).toBe(false);
    expect(r.out).toContain(`code map off: graphify exited 1: boom${OFF_LATER}`);
    expect(r.out).not.toContain("map build failed");
  });

  test("init turns its own new policy's map off when the first build maps no files", () => {
    const dir = makeRepo();
    writeFakeGraph(dir, [], []);
    const r = run(dir, ["init", "--exclude", "dist/**"], {}, supportedGraphify());
    expect(r.status).toBe(0);
    expect(openEngine(dir).policy.code_map).toEqual({ enabled: false, exclude: ["dist/**"] });
    expect(r.out).toContain(`code map off: Graphify mapped no files${OFF_LATER}`);
  });

  test("init never rewrites an existing policy when its build fails", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, policyOf(dir).replace("enabled: false", "enabled: true"));
    const before = policyOf(dir);
    const exec = fakeExec({ "graphify --version": { code: 0, stdout: "graphify 0.9.121\n" }, graphify: { code: 1, stderr: "boom" } });
    const r = run(dir, ["init"], {}, exec);
    expect(policyOf(dir)).toBe(before);
    expect(r.out).toContain("map build failed: graphify exited 1: boom\n");
    expect(r.out).not.toContain("code map off");
  });

  test.skipIf(!HAS_GRAPHIFY)("init on a repository with no supported language turns the map off (real Graphify)", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "README.md"), "# readme\n");
    writeFileSync(join(dir, "notes.md"), "notes\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "docs"], { cwd: dir, stdio: "ignore" });
    const r = run(dir, ["init"], {}, realExec);
    expect(r.status).toBe(0);
    expect(openEngine(dir).policy.code_map.enabled).toBe(false);
    expect(r.out).toMatch(/^code map off: graphify exited 1: /m);
    expect(r.out).toContain(OFF_LATER);
    expect(r.out).not.toContain("map build failed");
  });

  test("map suggest lists suggestions, or says there are none", () => {
    const dir = makeRepo();
    run(dir, ["init"]);
    expect(run(dir, ["map", "suggest"]).out).toBe("no exclude suggestions\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "a.js"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    expect(run(dir, ["map", "suggest"]).out).toBe("dist/**  (named dist)\n");
  });

  describe("claims", { timeout: 60_000 }, () => {
    function two() {
      const dir = makeRepo();
      expect(run(dir, ["init"]).status).toBe(0);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "estack"], { cwd: dir });
      const e = openEngine(dir);
      const mk = (title: string, s: string) => startTask(e, { title, type: "feature", goal: `goal ${title}`, done_check: "d", actor: { session_id: s }, cwd: dir, worktree: true }).task;
      return { dir, e, t1: mk("one", "sa"), t2: mk("two", "sb") };
    }

    test("estack allow is refused inside Claude Code and works from a terminal", () => {
      const { dir, e, t1, t2 } = two();
      checkEdit(e, t1, "src/a.ts");
      const args = ["allow", "--task", String(t2.id), "--path", "src/a.ts", "--reason", "needs it"];
      const refused = run(dir, args, { CLAUDECODE: "1" });
      expect(refused.status).toBe(1);
      expect(refused.err).toContain("owner-only");
      expect(checkEdit(e, t2, "src/a.ts", undefined, false).ok).toBe(false);
      const ok = run(dir, args);
      expect(ok.status).toBe(0);
      expect(ok.out).toBe(`allowed task ${t2.id} to edit src/a.ts\n`);
      expect(checkEdit(e, t2, "src/a.ts").ok).toBe(true);
    });

    test("estack allow --with accepts an overlap across CTOs", () => {
      const { dir, e, t1, t2 } = two();
      const args = ["allow", "--task", String(t1.id), "--with", String(t2.id), "--reason", "different files"];
      expect(run(dir, args, { CLAUDECODE: "1" }).status).toBe(1);
      const ok = run(dir, args);
      expect(ok.status).toBe(0);
      expect(ok.out).toBe(`accepted the overlap between tasks ${t1.id} and ${t2.id}\n`);
      expect(e.db.prepare("SELECT a, b, by FROM overlap_accepts").all()).toEqual([{ a: t1.id, b: t2.id, by: "owner" }]);
      expect(run(dir, ["allow", "--task", "1", "--reason", "x"]).status).toBe(2);
    });

    test("estack release frees a stale hold", () => {
      const { dir, e, t1, t2 } = two();
      checkEdit(e, t1, "src/a.ts");
      const args = ["release", "--path", "src/a.ts", "--reason", "stale"];
      expect(run(dir, args, { CLAUDECODE: "1" }).status).toBe(1);
      expect(checkEdit(e, t2, "src/a.ts", undefined, false).ok).toBe(false);
      const ok = run(dir, args);
      expect(ok.status).toBe(0);
      expect(ok.out).toBe("released src/a.ts\n");
      expect(checkEdit(e, t2, "src/a.ts").ok).toBe(true);
    });

    test("estack release --task frees every claim of a task, handing a file to its grant", () => {
      const { dir, e, t1, t2 } = two();
      checkEdit(e, t1, "src/a.ts");
      checkEdit(e, t1, "src/b.ts");
      claimSymbol(e, { task_id: t1.id, name: "parseMoney", file: "src/m.ts", actor: { session_id: "sa" } });
      allowEdit(e, { task_id: t2.id, path: "src/b.ts", reason: "x", owner: true });
      const args = ["release", "--task", String(t1.id), "--reason", "abandoned"];
      expect(run(dir, args, { CLAUDECODE: "1" }).status).toBe(1);
      expect(e.db.prepare("SELECT COUNT(*) c FROM claims WHERE task_id = ? AND status = 'active'").get(t1.id)).toEqual({ c: 3 });
      const ok = run(dir, args);
      expect(ok.status).toBe(0);
      expect(ok.out).toBe(`released 3 claims of task ${t1.id}\n`);
      expect(e.db.prepare("SELECT task_id, kind, target, status FROM claims ORDER BY id").all()).toEqual([
        { task_id: t1.id, kind: "file", target: "src/a.ts", status: "released" },
        { task_id: t1.id, kind: "file", target: "src/b.ts", status: "released" },
        { task_id: t1.id, kind: "new_symbol", target: "parseMoney", status: "released" },
        { task_id: t2.id, kind: "file", target: "src/b.ts", status: "active" },
      ]);
      const reasons = (e.db.prepare("SELECT payload_json p FROM events WHERE kind = 'claim_released'").all() as { p: string }[]).map((r) => JSON.parse(r.p).reason);
      expect(reasons).toEqual(["abandoned", "abandoned", "abandoned"]);
      const again = run(dir, args);
      expect(again.status).toBe(1);
      expect(again.err).toContain(`task #${t1.id} holds nothing`);
      expect(run(dir, ["release", "--task", "1", "--path", "x", "--reason", "x"]).status).toBe(2);
      expect(run(dir, ["release", "--reason", "x"]).status).toBe(2);
    });

    test("status lists claims and kept worktrees", () => {
      const { dir, e, t1 } = two();
      checkEdit(e, t1, "src/a.ts");
      e.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t1.id);
      writeFileSync(join(t1.cwd, "dirty.txt"), "x");
      expect(removeWorktree(e, t1)).toBe("kept");
      const text = run(dir, ["status"]).out;
      expect(text).toContain(`claim: src/a.ts held by #${t1.id} one`);
      expect(text).toContain(`kept worktree: ${t1.cwd} (#${t1.id} one): uncommitted changes`);
      const json = JSON.parse(run(dir, ["status", "--json"]).out);
      expect(json.claims).toEqual([{ kind: "file", target: "src/a.ts", task_id: t1.id, title: "one" }]);
      expect(json.kept_worktrees).toEqual([{ task_id: t1.id, title: "one", path: t1.cwd, reason: "uncommitted changes" }]);
      expect(json.tasks.map((t: { id: number }) => t.id)).toHaveLength(1);
    });
  });
});
