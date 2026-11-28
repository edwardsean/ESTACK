import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { openEngine, type Engine } from "../src/engine";
import { runCheck } from "../src/checks";
import {
  afterCommit, checkDuplicates, dismissDuplicate, isTestFile, normaliseName, openDuplicates, paramCount,
} from "../src/duplicates";
import { initRepo } from "../src/policy";
import { getTask, startTask } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { buildGraph } from "../src/graph";
import { HAS_GRAPHIFY, makeRepo, writeFakeGraph } from "./helpers";

const A: Actor = { session_id: "s1", agent_id: "A" };
const B: Actor = { session_id: "s1", agent_id: "B" };
type Node = { id: string; label: string; source_file: string; source_location: string };
const fn = (id: string, name: string, file: string, line: number): Node => ({ id, label: `${name}()`, source_file: file, source_location: `L${line}` });
const method = (id: string, name: string, file: string, line: number): Node => ({ id, label: `.${name}()`, source_file: file, source_location: `L${line}` });
const cls = (id: string, name: string, file: string, line: number): Node => ({ id, label: name, source_file: file, source_location: `L${line}` });
const link = (source: string, target: Node, relation: string) =>
  ({ source, target: target.id, relation, confidence: "EXTRACTED", source_file: target.source_file, source_location: target.source_location });
const fileId = (file: string) => `file:${file}`;

/** Write a graph in Graphify's shape: a node per file, each top-level function linked from its file by `contains`. */
function writeGraph(dir: string, top: Node[], more: { nodes?: Node[]; links?: object[] } = {}) {
  const files = [...new Set([...top, ...(more.nodes ?? [])].map((n) => n.source_file))];
  writeFakeGraph(dir,
    [...files.map((f) => ({ id: fileId(f), label: basename(f), source_file: f, source_location: "L1" })), ...top, ...(more.nodes ?? [])],
    [...top.map((n) => link(fileId(n.source_file), n, "contains")), ...(more.links ?? [])]);
}
const code = (f: () => unknown) => { try { f(); } catch (x) { return x as EngineError; } throw new Error("did not throw"); };

function put(dir: string, rel: string, text: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
function commit(dir: string, rel: string, text: string) {
  put(dir, rel, text);
  git(dir, "add", rel);
  git(dir, "commit", "-m", `edit ${rel}`);
}

/** main has src/utils.ts (and `mainFiles`); the task's branch is `feat`, started before any new commit. */
function setup(mapOn = true, mainFiles: Record<string, string> = {}, branch = "feat") {
  const dir = makeRepo();
  initRepo(dir);
  const p = join(dir, ".estack", "policy.yaml");
  let y = readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, '  test:   "true"').replace(/^ {2}verify:.*$/m, '  verify: "true"');
  if (mapOn) y = y.replace("enabled: false", "enabled: true");
  writeFileSync(p, y);
  commit(dir, "src/utils.ts", "export function formatInvoiceDate(d: Date) {\n  return d;\n}\n");
  for (const [rel, text] of Object.entries(mainFiles)) commit(dir, rel, text);
  git(dir, "checkout", "-b", branch);
  const e = openEngine(dir);
  const id = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: A, cwd: dir }).task.id;
  const graph = (...extra: Node[]) => writeGraph(dir, [fn("u1", "formatInvoiceDate", "src/utils.ts", 1), ...extra]);
  const toVerify = () => {
    for (const n of ["plan", "reuse_check", "implement", "test"]) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, n);
  };
  return { dir, e, id, graph, toVerify };
}
const copy = (dir: string, graph: (...x: Node[]) => void) => {
  commit(dir, "src/orders/format.ts", "export function formatInvoiceDate(d: Date) {\n  return d;\n}\n");
  graph(fn("n1", "formatInvoiceDate", "src/orders/format.ts", 1));
};

describe("name and parameter helpers", () => {
  test("normaliseName strips case, separators and one prefix", () => {
    expect(normaliseName("getInvoiceDate")).toBe("invoicedate");
    expect(normaliseName("invoice_date")).toBe("invoicedate");
    expect(normaliseName("Invoice-Date")).toBe("invoicedate");
    expect(normaliseName("getId")).toBe("getid");
    expect(normaliseName("doDo")).toBe("dodo");
  });

  test("paramCount reads arrow and function forms", () => {
    const dir = makeRepo();
    put(dir, "a.ts", "const iso = (e: Engine) =>\n  e.now();\nfunction f() {}\nfunction g(a, b: Map<string, number>) {}\n");
    expect(paramCount(dir, "a.ts", 1)).toBe(1);
    expect(paramCount(dir, "a.ts", 3)).toBe(0);
    expect(paramCount(dir, "a.ts", 4)).toBe(2);
    expect(paramCount(dir, "missing.ts", 1)).toBeNull();
    put(dir, "b.ts", "const x = 1;\n");
    expect(paramCount(dir, "b.ts", 1)).toBeNull();
  });

  test("isTestFile", () => {
    for (const f of ["a.test.ts", "src/a.spec.js", "test/x.ts", "pkg/tests/x.ts", "src/__tests__/x.ts"]) expect(isTestFile(f), f).toBe(true);
    for (const f of ["src/a.ts", "src/latest.ts"]) expect(isTestFile(f), f).toBe(false);
  });
});

describe("duplicate check", () => {
  test("a helper written again is flagged", () => {
    const { dir, e, id, graph } = setup();
    copy(dir, graph);
    const open = checkDuplicates(e, id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      task_id: id, new_symbol: "formatInvoiceDate", new_file: "src/orders/format.ts", new_line: 1,
      existing_symbol: "formatInvoiceDate", existing_file: "src/utils.ts", existing_line: 1, status: "open",
    });
    expect(open[0].commit_sha).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim());
    expect(checkDuplicates(e, id)).toHaveLength(1);
    const kinds = e.db.prepare("SELECT kind FROM events WHERE task_id=? AND kind LIKE '%duplicate%' ORDER BY id").all(id) as { kind: string }[];
    expect(kinds.map((k) => k.kind)).toEqual(["possible_duplicate", "duplicate_check_done", "duplicate_check_done"]);
  });

  test("a different parameter count is not flagged", () => {
    const { dir, e, id, graph } = setup();
    commit(dir, "src/orders/format.ts", "export function formatInvoiceDate(d: Date, locale: string) {\n  return d;\n}\n");
    graph(fn("n1", "formatInvoiceDate", "src/orders/format.ts", 1));
    expect(checkDuplicates(e, id)).toEqual([]);
  });

  test("functions in test files are neither checked nor matched", () => {
    const { dir, e, id, graph } = setup();
    commit(dir, "src/orders/format.test.ts", "export function formatInvoiceDate(d: Date) {\n  return d;\n}\n");
    graph(fn("n1", "formatInvoiceDate", "src/orders/format.test.ts", 1));
    expect(checkDuplicates(e, id)).toEqual([]);
    // an existing function in a test file is not a match either
    commit(dir, "src/orders/format.ts", "export function formatInvoiceDate(d: Date) {\n  return d;\n}\n");
    writeGraph(dir, [fn("t1", "formatInvoiceDate", "test/helpers.ts", 1), fn("n1", "formatInvoiceDate", "src/orders/format.ts", 1)]);
    expect(checkDuplicates(e, id)).toEqual([]);
  });

  test("a later commit that removes the copy resolves it", () => {
    const { dir, e, id, graph } = setup();
    copy(dir, graph);
    const [d] = checkDuplicates(e, id);
    commit(dir, "src/orders/format.ts", "export function other() {}\n");
    graph(fn("n2", "other", "src/orders/format.ts", 1));
    expect(checkDuplicates(e, id)).toEqual([]);
    const row = e.db.prepare("SELECT status, closed_at FROM duplicates WHERE id=?").get(d.id) as { status: string; closed_at: string | null };
    expect(row.status).toBe("resolved");
    expect(row.closed_at).not.toBeNull();
  });

  test("a copy that comes back after being removed is flagged again", () => {
    const { dir, e, id, graph } = setup();
    copy(dir, graph);
    const [d] = checkDuplicates(e, id);
    commit(dir, "src/orders/format.ts", "export function other() {}\n");
    graph(fn("n2", "other", "src/orders/format.ts", 1));
    expect(checkDuplicates(e, id)).toEqual([]);
    commit(dir, "src/orders/format.ts", "// moved\nexport function formatInvoiceDate(d: Date) {\n  return d;\n}\n");
    graph(fn("n3", "formatInvoiceDate", "src/orders/format.ts", 2));
    const open = checkDuplicates(e, id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: d.id, status: "open", new_line: 2, closed_by: null });
    expect(open[0].commit_sha).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim());
    const row = e.db.prepare("SELECT closed_at FROM duplicates WHERE id=?").get(d.id) as { closed_at: string | null };
    expect(row.closed_at).toBeNull();
    const n = e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind='possible_duplicate'").get() as { c: number };
    expect(n.c).toBe(2);
  });

  test("a dismissed pair stays dismissed when re-detected", () => {
    const { dir, e, id, graph } = setup();
    copy(dir, graph);
    const [d] = checkDuplicates(e, id);
    dismissDuplicate(e, { id: d.id, reason: "different on purpose", actor: B });
    expect(checkDuplicates(e, id)).toEqual([]);
    const row = e.db.prepare("SELECT status FROM duplicates WHERE id=?").get(d.id) as { status: string };
    expect(row.status).toBe("dismissed");
    expect(e.db.prepare("SELECT COUNT(*) c FROM duplicates").get()).toEqual({ c: 1 });
  });

  test("a new method or nested function is not checked; a new top-level function still is", () => {
    const { dir, e, id } = setup(true, { "src/page.ts": "export function render() { return 2; }\nexport function inner() { return 2; }\n" });
    commit(dir, "src/view.ts", [
      "export class View {", "  render() { return 1; }", "}",
      "export function outer() {", "  function inner() { return 1; }", "  return inner();", "}",
      "export function formatInvoiceDate(d: Date) {", "  return d;", "}", "",
    ].join("\n"));
    const view = cls("v", "View", "src/view.ts", 1);
    const render = method("vr", "render", "src/view.ts", 2);
    const outer = fn("vo", "outer", "src/view.ts", 4);
    const inner = fn("vi", "inner", "src/view.ts", 5);
    writeGraph(dir, [
      fn("u1", "formatInvoiceDate", "src/utils.ts", 1), fn("pr", "render", "src/page.ts", 1), fn("pi", "inner", "src/page.ts", 2),
      outer, fn("vf", "formatInvoiceDate", "src/view.ts", 8),
    ], {
      nodes: [view, render, inner],
      links: [link(fileId("src/view.ts"), view, "contains"), link("v", render, "method"), link("vo", inner, "contains")],
    });
    const open = checkDuplicates(e, id);
    expect(open.map((d) => [d.new_symbol, d.new_file, d.existing_file])).toEqual([["formatInvoiceDate", "src/view.ts", "src/utils.ts"]]);
  });

  test("a new top-level function is not matched against a method or a nested function", () => {
    const page = "export class Page {\n  render() { return 2; }\n}\nexport function wrap() {\n  function inner() { return 2; }\n  return inner();\n}\n";
    const { dir, e, id } = setup(true, { "src/page.ts": page });
    commit(dir, "src/view.ts", "export function render() { return 1; }\nexport function inner() { return 1; }\n");
    const pageClass = cls("p", "Page", "src/page.ts", 1);
    const render = method("prm", "render", "src/page.ts", 2);
    const inner = fn("pin", "inner", "src/page.ts", 5);
    writeGraph(dir, [
      fn("u1", "formatInvoiceDate", "src/utils.ts", 1), fn("pw", "wrap", "src/page.ts", 4),
      fn("vr", "render", "src/view.ts", 1), fn("vi", "inner", "src/view.ts", 2),
    ], {
      nodes: [pageClass, render, inner],
      links: [link(fileId("src/page.ts"), pageClass, "contains"), link("p", render, "method"), link("pw", inner, "contains")],
    });
    expect(checkDuplicates(e, id)).toEqual([]);
  });

  test("a pair another process records at the same moment is no error", async () => {
    const { dir, e, id, graph } = setup();
    copy(dir, graph);
    // Another connection holds the write lock with the same pair inserted, and commits while this check runs.
    const worker = new Worker(`
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const b = new DatabaseSync(workerData.db);
      b.exec("PRAGMA busy_timeout=5000");
      b.exec("BEGIN IMMEDIATE");
      b.prepare(\`INSERT INTO duplicates (task_id, commit_sha, new_symbol, new_file, new_line, existing_symbol, existing_file, existing_line, status, found_at)
        VALUES (?, 'x', 'formatInvoiceDate', 'src/orders/format.ts', 1, 'formatInvoiceDate', 'src/utils.ts', 1, 'open', 't')\`).run(workerData.id);
      parentPort.postMessage("locked");
      setTimeout(() => { b.exec("COMMIT"); b.close(); parentPort.postMessage("committed"); }, 400);
    `, { eval: true, workerData: { db: join(dir, ".estack", "state.db"), id } });
    const next = () => new Promise<string>((res) => worker.once("message", res));
    expect(await next()).toBe("locked");
    const committed = next();
    const open = checkDuplicates(e, id);
    expect(await committed).toBe("committed");
    expect(open).toHaveLength(1);
    expect(e.db.prepare("SELECT COUNT(*) c FROM duplicates").get()).toEqual({ c: 1 });
  });

  test("afterCommit checks the open task on the checkout's branch", () => {
    const { dir, e, id, graph } = setup();
    copy(dir, graph);
    afterCommit(e, dir);
    expect(openDuplicates(e, id)).toHaveLength(1);
    git(dir, "checkout", "main");
    const before = e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind='duplicate_check_done'").get() as { c: number };
    afterCommit(e, dir);
    const after = e.db.prepare("SELECT COUNT(*) c FROM events WHERE kind='duplicate_check_done'").get() as { c: number };
    expect(after.c).toBe(before.c);
  });
});

describe.skipIf(!HAS_GRAPHIFY)("duplicate check on real Graphify", () => {
  test("only top-level functions are compared: methods and nested functions are left out", () => {
    const { dir, e, id } = setup(true, {
      "src/page.ts": "export class Page {\n  render() { return 2; }\n}\nexport function wrap() {\n  function inner() { return 2; }\n  return inner();\n}\n",
      "src/b.py": "class Foo:\n    def __init__(self):\n        pass\n",
    });
    commit(dir, "src/view.ts", [
      "export class View {", "  render() { return 1; }", "  toString() { return 'v'; }", "}",
      "export function outer() {", "  function inner() { return 1; }", "  return inner();", "}",
      "export function formatInvoiceDate(d: Date) {", "  return d;", "}", "",
    ].join("\n"));
    commit(dir, "src/c.py", "class Bar:\n    def __init__(self):\n        pass\n");
    const b = buildGraph(e, dir);
    expect(b.error).toBeUndefined();
    const open = checkDuplicates(e, id);
    expect(open.map((d) => [d.new_symbol, d.new_file, d.existing_file])).toEqual([["formatInvoiceDate", "src/view.ts", "src/utils.ts"]]);
  });
});

describe("verify gate and dismissal", () => {
  test("verify is held back while a duplicate is open", () => {
    const { dir, e, id, graph, toVerify } = setup();
    copy(dir, graph);
    toVerify();
    const err = code(() => runCheck(e, { task_id: id, step: "verify", actor: A }));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain(`task #${id} has possible duplicates: formatInvoiceDate (src/orders/format.ts:1) matches formatInvoiceDate (src/utils.ts:1) [#`);
    expect(err.message).toContain("dismiss_duplicate");
  });

  test("the author can't dismiss, another agent can, then verify runs", () => {
    const { dir, e, id, graph, toVerify } = setup();
    copy(dir, graph);
    toVerify();
    // the author is the actor that recorded the newest ok commit
    e.db.prepare("INSERT INTO evidence (task_id, step, kind, ok, payload_json, recorded_by, recorded_at) VALUES (?, 'implement', 'commit', 1, ?, ?, 'now')")
      .run(id, JSON.stringify({ sha: "abc" }), "s1/A");
    const [d] = checkDuplicates(e, id);
    expect(code(() => dismissDuplicate(e, { id: d.id, reason: "  ", actor: B })).code).toBe("BAD_EVIDENCE");
    expect(code(() => dismissDuplicate(e, { id: d.id, reason: "different on purpose", actor: { session_id: "unknown" } })).code).toBe("BAD_EVIDENCE");
    const own = code(() => dismissDuplicate(e, { id: d.id, reason: "fine", actor: A }));
    expect(own.code).toBe("BAD_EVIDENCE");
    expect(own.message).toBe("the task's author can't dismiss its own possible duplicate; ask a reviewer");
    const r = dismissDuplicate(e, { id: d.id, reason: "different on purpose", actor: B });
    expect(r).toMatchObject({ status: "dismissed", reason: "different on purpose", closed_by: "s1/B" });
    expect(code(() => dismissDuplicate(e, { id: d.id, reason: "again", actor: B })).code).toBe("BAD_EVIDENCE");
    expect(runCheck(e, { task_id: id, step: "verify", actor: A }).ok).toBe(true);
    expect(getTask(e, id).steps.find((s) => s.name === "verify")!.status).toBe("done");
  });

  test("with the map off verify runs as before", () => {
    const { dir, e, id, graph, toVerify } = setup(false);
    copy(dir, graph);
    toVerify();
    expect(runCheck(e, { task_id: id, step: "verify", actor: A }).ok).toBe(true);
    expect(e.db.prepare("SELECT COUNT(*) c FROM duplicates").get()).toEqual({ c: 0 });
  });
});

/** Mark the checkout's graph as built at its branch head, so it is not read as stale. */
function stamp(dir: string) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
  const p = join(dir, "graphify-out", "graph.json");
  const g = JSON.parse(readFileSync(p, "utf8"));
  g.built_at_commit = head;
  writeFileSync(p, JSON.stringify(g));
}

describe("duplicates across open tasks", () => {
  test("a feature that merged its open worker's helper raises no duplicate against that worker", () => {
    const { dir, e, id } = setup(true, {}, "work");
    e.db.prepare("INSERT INTO task_bindings (task_id, session_id, agent_id, role, bound_at) VALUES (?, 's1', NULL, 'cto', ?)").run(id, e.now().toISOString());
    const w = startTask(e, { title: "worker", type: "feature", goal: "g", done_check: "d", actor: { session_id: "s1" }, cwd: dir, worktree: true, parent_task_id: id }).task;
    commit(w.cwd, "src/totals.ts", "export function computeInvoiceTotal(items: number[]) {\n  return items.length;\n}\n");
    writeGraph(w.cwd, [fn("o1", "computeInvoiceTotal", "src/totals.ts", 1)]);
    stamp(w.cwd);
    git(dir, "merge", "--no-edit", w.branch);
    writeGraph(dir, [fn("u1", "formatInvoiceDate", "src/utils.ts", 1), fn("n1", "computeInvoiceTotal", "src/totals.ts", 1)]);
    expect(checkDuplicates(e, id)).toEqual([]);
  });

  test("the duplicate check flags a helper another open task is already adding", () => {
    const { dir, e, id } = setup(true, {}, "work");
    const other = startTask(e, { title: "other", type: "feature", goal: "g", done_check: "d", actor: B, cwd: dir, worktree: true }).task;
    commit(other.cwd, "src/totals.ts", "export function computeInvoiceTotal(items: number[]) {\n  return items.length;\n}\n");
    writeGraph(other.cwd, [fn("o1", "computeInvoiceTotal", "src/totals.ts", 1)]);
    stamp(other.cwd);
    commit(dir, "src/orders/sum.ts", "export function calculateInvoiceTotal(rows: number[]) {\n  return rows.length;\n}\n");
    writeGraph(dir, [fn("u1", "formatInvoiceDate", "src/utils.ts", 1), fn("n1", "calculateInvoiceTotal", "src/orders/sum.ts", 1)]);
    const open = checkDuplicates(e, id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      new_symbol: "calculateInvoiceTotal", existing_symbol: "computeInvoiceTotal",
      existing_file: `task #${other.id}: src/totals.ts`, existing_line: 1, status: "open",
    });
    // still open on a second run, not duplicated
    expect(checkDuplicates(e, id)).toHaveLength(1);
  });
});
