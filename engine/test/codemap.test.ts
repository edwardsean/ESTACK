import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openEngine } from "../src/engine";
import { initRepo } from "../src/policy";
import { loadGraph } from "../src/graph";
import { MAX_LIST, contextFor, descriptionWords, findExisting, whoUses } from "../src/codemap";
import { makeRepo, writeFakeGraph } from "./helpers";

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
  put(dir, "src/orders/invoice.ts", "import { formatInvoiceDate as fmt } from \"../utils\";\n\n\n\n\nexport function render() {\n  return fmt(new Date());\n}\n");
  put(dir, "dist/utils.js", "function formatInvoiceDate() {}\nfunction runBounded() { /* timeout */ }\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "fixtures"], { cwd: dir, stdio: "ignore" });
  writeFakeGraph(dir, [
    fileNode("u", "src/utils.ts"), fn("fmt", "formatInvoiceDate", "src/utils.ts", 1), fn("rb", "runBounded", "src/utils.ts", 3),
    fileNode("inv", "src/orders/invoice.ts"), fn("render", "render", "src/orders/invoice.ts", 6),
    ...extraNodes,
  ], [
    link("inv", "fmt", "imports_from", "src/orders/invoice.ts", 1),
    link("render", "fmt", "calls", "src/orders/invoice.ts", 7),
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

  test("who_uses lists callers with file and line", () => {
    const { g } = setup();
    const r = whoUses(g, "main", "formatInvoiceDate");
    expect(r.callers).toContainEqual({ symbol: "render", file: "src/orders/invoice.ts", line: 7, relation: "calls", confidence: "EXTRACTED" });
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
