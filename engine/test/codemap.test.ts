import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openEngine } from "../src/engine";
import { initRepo } from "../src/policy";
import { loadGraph } from "../src/graph";
import { MAX_LIST, contextFor, descriptionWords, findExisting, runCodeQuery, whoUses, type ContextResult, type FindResult, type WhoUsesResult } from "../src/codemap";
import { inProgressFunctions } from "../src/duplicates";
import { startTask } from "../src/tasks";
import { EngineError } from "../src/types";
import { makeRepo, writeFakeGraph } from "./helpers";

const thrown = (f: () => unknown): EngineError => {
  try { f(); } catch (x) { return x as EngineError; }
  throw new Error("did not throw");
};

const fileNode = (id: string, file: string) => ({ id, label: file.split("/").pop(), source_file: file, source_location: "L1" });
const fn = (id: string, name: string, file: string, line: number) => ({ id, label: `${name}()`, source_file: file, source_location: `L${line}` });
const link = (source: string, target: string, relation: string, file: string, line: number) =>
  ({ source, target, relation, confidence: "EXTRACTED", source_file: file, source_location: `L${line}` });

function put(dir: string, rel: string, text: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function setup(extraNodes: object[] = [], extraLinks: object[] = []) {
  const dir = makeRepo();
  initRepo(dir);
  put(dir, "src/utils.ts", "export function formatInvoiceDate(d: Date) { return d; }\n\nexport function runBounded(cmd: string, timeoutMs: number) { // timeout\n}\n");
  put(dir, "src/orders/invoice.ts", "import { formatInvoiceDate } from \"../utils\";\nexport function render() {\n  return formatInvoiceDate(new Date());\n}\n");
  put(dir, "dist/utils.js", "function formatInvoiceDate() {}\nfunction runBounded() { /* timeout */ }\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "fixtures"], { cwd: dir, stdio: "ignore" });
  writeFakeGraph(dir, [
    fileNode("u", "src/utils.ts"), fn("fmt", "formatInvoiceDate", "src/utils.ts", 1), fn("rb", "runBounded", "src/utils.ts", 3),
    fileNode("inv", "src/orders/invoice.ts"), fn("render", "render", "src/orders/invoice.ts", 2),
    ...extraNodes,
  ], [
    link("inv", "fmt", "imports_from", "src/orders/invoice.ts", 1),
    link("render", "fmt", "calls", "src/orders/invoice.ts", 3),
    ...extraLinks,
  ]);
  return { dir, g: loadGraph(dir)!, e: openEngine(dir) };
}

describe("codemap", () => {
  test("context_for an area lists what it defines, uses and is used by", () => {
    const { g } = setup();
    const c = contextFor(g, "main", "src/orders/");
    expect(c.graph).toBe("main");
    expect(c.defines.map((h) => h.symbol)).toEqual(["render"]);
    expect(c.uses.some((h) => h.symbol === "formatInvoiceDate" && h.file === "src/utils.ts")).toBe(true);
    expect(c.uses.every((h) => !h.file.startsWith("dist/"))).toBe(true);
    const u = contextFor(g, "main", "src/utils.ts");
    expect(u.used_by.map((h) => h.symbol)).toContain("render");
  });

  test("context_for takes an absolute, ./-prefixed or slash-ended area", () => {
    const { dir, g } = setup();
    for (const area of [join(dir, "src/orders"), "./src/orders", "./src/orders/", `${dir}/src/orders/`]) {
      const c = contextFor(g, "main", area);
      expect(c.area, area).toBe("src/orders");
      expect(c.defines.map((h) => h.symbol), area).toEqual(["render"]);
      expect(c.note, area).toBeUndefined();
    }
  });

  test("context_for refuses an area outside the checkout, naming the checkout", () => {
    const { dir, g } = setup();
    for (const area of ["/elsewhere/src", "../other", join(dir, "..")]) {
      const err = thrown(() => contextFor(g, "main", area));
      expect(err.code, area).toBe("BAD_EVIDENCE");
      expect(err.message, area).toContain(dir);
    }
  });

  test("context_for on an area with nothing in the map says so", () => {
    const { g } = setup();
    const c = contextFor(g, "main", "src/nothing/");
    expect(c.defines).toEqual([]);
    expect(c.note).toBe("nothing in the map under src/nothing; check the path, or use find_existing");
  });

  test("an area outside the checkout is logged as a failed query", () => {
    const { dir } = setup();
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("enabled: false", "enabled: true"));
    const e = openEngine(dir);
    expect(thrown(() => runCodeQuery(e, { tool: "context_for", arg: "/elsewhere", actor: { session_id: "s" }, cwd: dir })).code).toBe("BAD_EVIDENCE");
    expect(e.db.prepare("SELECT ok FROM code_queries").all()).toEqual([{ ok: 0 }]);
  });

  test("who_uses path::name takes an absolute or ./-prefixed path, and refuses one outside the checkout", () => {
    const { dir, g } = setup([fn("fmt2", "formatInvoiceDate", "src/other.ts", 5)]);
    for (const path of [join(dir, "src/utils.ts"), "./src/utils.ts"]) {
      const r = whoUses(g, "main", `${path}::formatInvoiceDate`);
      expect(r.defined_at, path).toEqual([{ symbol: "formatInvoiceDate", file: "src/utils.ts", line: 1 }]);
      expect(r.callers.length, path).toBeGreaterThan(0);
    }
    const err = thrown(() => whoUses(g, "main", "/elsewhere/utils.ts::formatInvoiceDate"));
    expect(err.code).toBe("BAD_EVIDENCE");
    expect(err.message).toContain(dir);
  });

  test("who_uses lists callers with file and line", () => {
    const { g } = setup();
    const r = whoUses(g, "main", "formatInvoiceDate");
    expect(r.callers).toContainEqual({ symbol: "render", file: "src/orders/invoice.ts", line: 3, relation: "calls", confidence: "EXTRACTED" });
    expect(r.ambiguous).toBeUndefined();
  });

  test("who_uses with a name in two files asks which", () => {
    const { g } = setup([fn("fmt2", "formatInvoiceDate", "src/other.ts", 5)]);
    const r = whoUses(g, "main", "formatInvoiceDate");
    expect(r.ambiguous).toHaveLength(2);
    expect(r.callers).toEqual([]);
  });

  test("who_uses path::name picks one", () => {
    const { g } = setup([fn("fmt2", "formatInvoiceDate", "src/other.ts", 5)]);
    const r = whoUses(g, "main", "src/utils.ts::formatInvoiceDate");
    expect(r.ambiguous).toBeUndefined();
    expect(r.defined_at).toHaveLength(1);
    expect(r.callers.length).toBeGreaterThan(0);
  });

  test("descriptionWords drops filler", () => {
    expect(descriptionWords("run a command with a timeout")).toEqual(["run", "command", "timeout"]);
  });

  test("find_existing finds by code text what names miss", () => {
    const { e, g } = setup();
    const r = findExisting(e, g, "main", "run a command with a timeout");
    expect(r.matches[0].symbol).toBe("runBounded");
    expect(r.matches[0].why).toContain("text");
  });

  test("find_existing finds by name", () => {
    const { e, g } = setup();
    const r = findExisting(e, g, "main", "format invoice date");
    expect(r.matches[0].symbol).toBe("formatInvoiceDate");
    expect(r.matches[0].why).toContain("name");
  });

  test("a function's own name outranks a line that calls it", () => {
    const { e, g } = setup();
    const syms = findExisting(e, g, "main", "format invoice date").matches.map((h) => h.symbol);
    expect(syms.indexOf("formatInvoiceDate")).toBeGreaterThanOrEqual(0);
    expect(syms.indexOf("formatInvoiceDate")).toBeLessThan(syms.indexOf("render"));
  });

  test("on a tie, more description words in the function's own name rank higher", () => {
    const { dir, e, g } = setup([fileNode("bi", "src/billing/invoice.ts"), fn("inv2", "invoice", "src/billing/invoice.ts", 2)]);
    put(dir, "src/billing/invoice.ts", 'import { formatInvoiceDate } from "../utils";\nexport function invoice(d: Date) {\n  return "Invoice " + formatInvoiceDate(d);\n}\n');
    const syms = findExisting(e, g, "main", "format invoice date").matches.map((h) => h.symbol);
    expect(syms.indexOf("invoice")).toBeGreaterThanOrEqual(0);
    expect(syms[0]).toBe("formatInvoiceDate");
  });

  test("who_uses callers are capped with a count of the rest", () => {
    const nodes: object[] = [];
    const links: object[] = [];
    for (let i = 0; i < 45; i++) {
      nodes.push(fn(`c${i}`, `caller${i}`, `other/f${i}.ts`, 1));
      links.push(link(`c${i}`, "fmt", "calls", `other/f${i}.ts`, 2));
    }
    const { g } = setup(nodes, links);
    const r = whoUses(g, "main", "formatInvoiceDate");
    expect(r.callers).toHaveLength(MAX_LIST);
    expect(r.more).toEqual({ callers: 46 - MAX_LIST });
    expect(whoUses(setup().g, "main", "formatInvoiceDate").more).toBeUndefined();
  });

  test("lists are capped with a count of the rest", () => {
    const nodes: object[] = [];
    const links: object[] = [];
    for (let i = 0; i < 45; i++) {
      nodes.push(fn(`c${i}`, `caller${i}`, `other/f${i}.ts`, 1));
      links.push(link(`c${i}`, "fmt", "calls", `other/f${i}.ts`, 2));
    }
    const { g } = setup(nodes, links);
    const c = contextFor(g, "main", "src/utils.ts");
    expect(c.used_by).toHaveLength(MAX_LIST);
    expect(c.more.used_by).toBe(46 - MAX_LIST);
  });
});

describe("code map across worktrees", () => {
  const SA = { session_id: "sa" };
  const SB = { session_id: "sb" };
  function two() {
    const dir = makeRepo();
    initRepo(dir);
    const p = join(dir, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("enabled: false", "enabled: true"));
    put(dir, "src/utils.ts", "export function formatInvoiceDate(d: Date) { return d; }\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
    const e = openEngine(dir);
    const mk = (title: string, actor: { session_id: string }) =>
      startTask(e, { title, type: "feature", goal: "g", done_check: "d", actor, cwd: dir, worktree: true }).task;
    const a = mk("Alpha", SA);
    const b = mk("Beta", SB);
    const base = [fileNode("u", "src/utils.ts"), fn("fmt", "formatInvoiceDate", "src/utils.ts", 1)];
    writeFakeGraph(a.cwd, base, [link("u", "fmt", "contains", "src/utils.ts", 1)]);
    // Beta adds a helper in its own worktree.
    put(b.cwd, "src/totals.ts", "export function computeInvoiceTotal(items: number[]) {\n  return items.length;\n}\n");
    execFileSync("git", ["add", "-A"], { cwd: b.cwd });
    execFileSync("git", ["commit", "-m", "beta helper"], { cwd: b.cwd, stdio: "ignore" });
    writeFakeGraph(b.cwd, [...base, fileNode("t", "src/totals.ts"), fn("tot", "computeInvoiceTotal", "src/totals.ts", 1)],
      [link("u", "fmt", "contains", "src/utils.ts", 1), link("t", "tot", "contains", "src/totals.ts", 1)]);
    return { dir, e, a, b };
  }

  test("find_existing shows a helper another task is adding, labelled with the task", () => {
    const { e, a, b } = two();
    const r = runCodeQuery(e, { tool: "find_existing", arg: "compute the invoice total", actor: SA, cwd: a.cwd }) as FindResult;
    expect(r.matches).toContainEqual({ symbol: "computeInvoiceTotal", file: `task #${b.id}: src/totals.ts`, line: 1, why: ["name"], task_id: b.id });
  });

  test("who_uses reports another task's new function as defined there", () => {
    const { e, a, b } = two();
    const r = runCodeQuery(e, { tool: "who_uses", arg: "computeInvoiceTotal", actor: SA, cwd: a.cwd }) as WhoUsesResult;
    expect(r.defined_at).toEqual([{ symbol: "computeInvoiceTotal", file: `task #${b.id}: src/totals.ts`, line: 1, task_id: b.id }]);
  });

  test("a task's parent and children are not shown as other tasks", () => {
    const { e, a, b } = two();
    const w = startTask(e, { title: "Gamma", type: "feature", goal: "g", done_check: "d", actor: SA, cwd: a.cwd, worktree: true, parent_task_id: a.id }).task;
    put(w.cwd, "src/gamma.ts", "export function computeGammaThing(x: number) {\n  return x;\n}\n");
    execFileSync("git", ["add", "-A"], { cwd: w.cwd });
    execFileSync("git", ["commit", "-m", "gamma"], { cwd: w.cwd, stdio: "ignore" });
    writeFakeGraph(w.cwd, [fileNode("g", "src/gamma.ts"), fn("gt", "computeGammaThing", "src/gamma.ts", 1)], [link("g", "gt", "contains", "src/gamma.ts", 1)]);
    const fromA = runCodeQuery(e, { tool: "find_existing", arg: "gamma", actor: SA, cwd: a.cwd }) as FindResult;
    expect(fromA.matches.filter((m) => m.task_id !== undefined)).toEqual([]);
    const fromB = runCodeQuery(e, { tool: "find_existing", arg: "gamma", actor: SB, cwd: b.cwd }) as FindResult;
    expect(fromB.matches.map((m) => m.task_id)).toEqual([w.id]);
    const fromW = runCodeQuery(e, { tool: "find_existing", arg: "compute invoice total", actor: SA, cwd: w.cwd }) as FindResult;
    expect(fromW.matches.filter((m) => m.task_id !== undefined).map((m) => m.task_id)).toEqual([b.id]);
  });

  test("a task whose graph is missing is skipped", () => {
    const { e, a, b } = two();
    rmSync(join(b.cwd, "graphify-out"), { recursive: true });
    expect(inProgressFunctions(e, a.id)).toEqual([]);
    expect(inProgressFunctions(e, null).map((x) => x.task_id)).toEqual([]);
  });

  test("context_for lists active claims in the area", () => {
    const { e, a, b } = two();
    const at = e.now().toISOString();
    const ins = e.db.prepare("INSERT INTO claims (task_id, kind, target, status, at) VALUES (?, ?, ?, ?, ?)");
    ins.run(b.id, "file", "src/totals.ts", "active", at);
    ins.run(b.id, "file", "src/other/x.ts", "active", at);
    ins.run(b.id, "file", "src/utils.ts", "released", at);
    const r = runCodeQuery(e, { tool: "context_for", arg: "src/", actor: SA, cwd: a.cwd }) as ContextResult;
    expect(r.claims).toEqual([{ path: "src/other/x.ts", task_id: b.id }, { path: "src/totals.ts", task_id: b.id }]);
    const narrow = runCodeQuery(e, { tool: "context_for", arg: "src/totals.ts", actor: SA, cwd: a.cwd }) as ContextResult;
    expect(narrow.claims).toEqual([{ path: "src/totals.ts", task_id: b.id }]);
  });
});
