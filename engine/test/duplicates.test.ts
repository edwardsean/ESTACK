import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openEngine, type Engine } from "../src/engine";
import { runCheck } from "../src/checks";
import {
  afterCommit, checkDuplicates, dismissDuplicate, isTestFile, normaliseName, openDuplicates, paramCount,
} from "../src/duplicates";
import { initRepo } from "../src/policy";
import { getTask, startTask } from "../src/tasks";
import { EngineError, type Actor } from "../src/types";
import { makeRepo, writeFakeGraph } from "./helpers";

const A: Actor = { session_id: "s1", agent_id: "A" };
const B: Actor = { session_id: "s1", agent_id: "B" };
const fn = (id: string, name: string, file: string, line: number) => ({ id, label: `${name}()`, source_file: file, source_location: `L${line}` });
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

/** main has src/utils.ts; the task's branch is `feat`, started before any new commit. */
function setup(mapOn = true) {
  const dir = makeRepo();
  initRepo(dir);
  const p = join(dir, ".estack", "policy.yaml");
  let y = readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, '  test:   "true"').replace(/^ {2}verify:.*$/m, '  verify: "true"');
  if (mapOn) y = y.replace("enabled: false", "enabled: true");
  writeFileSync(p, y);
  commit(dir, "src/utils.ts", "export function formatInvoiceDate(d: Date) {\n  return d;\n}\n");
  git(dir, "checkout", "-b", "feat");
  const e = openEngine(dir);
  const id = startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: A, cwd: dir }).task.id;
  const graph = (...extra: object[]) =>
    writeFakeGraph(dir, [fn("u1", "formatInvoiceDate", "src/utils.ts", 1), ...extra], []);
  const toVerify = () => {
    for (const n of ["plan", "reuse_check", "implement", "test"]) e.db.prepare("UPDATE steps SET status='done' WHERE task_id=? AND name=?").run(id, n);
  };
  return { dir, e, id, graph, toVerify };
}
const copy = (dir: string, graph: (...x: object[]) => void) => {
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
    writeFakeGraph(dir, [fn("t1", "formatInvoiceDate", "test/helpers.ts", 1), fn("n1", "formatInvoiceDate", "src/orders/format.ts", 1)], []);
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
