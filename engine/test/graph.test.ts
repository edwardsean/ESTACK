import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openEngine, type Engine } from "../src/engine";
import { buildGraph, checkoutLabel, folderShares, INSTALL_HINT, loadGraph, mappedFiles, suggestExcludes, versionSupported, writeIgnore } from "../src/graph";
import { initRepo } from "../src/policy";
import { startTask } from "../src/tasks";
import { fakeExec, HAS_GRAPHIFY, makeRepo, writeFakeGraph } from "./helpers";

function engineFor(exclude: string[] = [], exec?: ReturnType<typeof fakeExec>): { dir: string; e: Engine } {
  const dir = makeRepo();
  initRepo(dir, { codeMap: true, exclude });
  return { dir, e: openEngine(dir, { exec }) };
}

describe("graph adapter", () => {
  test("versionSupported pins 0.9.121 up to 0.10", () => {
    for (const v of ["0.9.121", "0.9.200"]) expect(versionSupported(v)).toBe(true);
    for (const v of ["0.9.120", "0.10.0", "1.0.0"]) expect(versionSupported(v)).toBe(false);
  });

  test("writeIgnore writes the exclude list and local git excludes", () => {
    const { dir, e } = engineFor(["dist/**", "upstream/**"]);
    writeIgnore(e, dir);
    writeIgnore(e, dir);
    expect(readFileSync(join(dir, ".graphifyignore"), "utf8")).toBe(".estack/\ndist/**\nupstream/**\n");
    const lines = readFileSync(join(dir, ".git", "info", "exclude"), "utf8").split("\n");
    expect(lines.filter((l) => l === "graphify-out/")).toHaveLength(1);
    expect(lines.filter((l) => l === ".graphifyignore")).toHaveLength(1);
  });

  test("build refuses without Graphify and names the install command", () => {
    const { dir, e } = engineFor([], fakeExec({ graphify: { code: 127 } }));
    const r = buildGraph(e, dir);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(INSTALL_HINT);
  });

  test("loadGraph reads nodes, kinds and edges", () => {
    const dir = makeRepo();
    writeFakeGraph(dir, [
      { id: "a", label: "util.ts", source_file: "src/util.ts", source_location: "L1" },
      { id: "b", label: "formatDate()", source_file: "src/util.ts", source_location: "L3" },
      { id: "x", label: "Date", source_file: "", source_location: "" },
    ], [{ source: "a", target: "b", relation: "calls", confidence: "EXTRACTED", source_file: "src/util.ts", source_location: "L4" }]);
    const g = loadGraph(dir)!;
    expect(g.nodes.size).toBe(2);
    expect(g.nodes.get("a")!.kind).toBe("file");
    const f = g.nodes.get("b")!;
    expect([f.kind, f.name, f.line]).toEqual(["function", "formatDate", 3]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ relation: "calls", confidence: "EXTRACTED", line: 4 });
    expect(mappedFiles(dir)).toEqual(new Set(["src/util.ts"]));
    expect(loadGraph(makeRepo())).toBeNull();
  });

  test("folderShares groups by top-level folder and lists the largest folders' biggest subfolders", () => {
    const dir = makeRepo();
    const counts: [string, number][] = [
      ["src/a.ts", 2], ["src/orders/x.ts", 3], ["src/orders/deep/y.ts", 1], ["src/billing/z.ts", 2], ["src/ui/w.ts", 1], ["src/misc/m.ts", 1],
      ["lib/p/q.ts", 3], ["lib/r.ts", 2], ["index.ts", 3], ["tools/a/t.ts", 2],
    ];
    writeFakeGraph(dir, counts.flatMap(([f, n]) => Array.from({ length: n }, (_, i) => ({ id: `${f}#${i}`, label: `f${i}()`, source_file: f, source_location: `L${i + 2}` }))), []);
    expect(folderShares(loadGraph(dir)!)).toEqual([
      { folder: "src", nodes: 10, percent: 50, sub: [
        { folder: "src/orders", nodes: 4, percent: 20 }, { folder: "src/billing", nodes: 2, percent: 10 }, { folder: "src/misc", nodes: 1, percent: 5 },
      ] },
      { folder: "lib", nodes: 5, percent: 25, sub: [{ folder: "lib/p", nodes: 3, percent: 15 }] },
      { folder: "(root)", nodes: 3, percent: 15, sub: [] },
      { folder: "tools", nodes: 2, percent: 10, sub: [] },
    ]);
  });

  test("checkoutLabel names main and task worktrees", () => {
    const { dir, e } = engineFor();
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "estack-wt-"))), "wt");
    execFileSync("git", ["worktree", "add", "-b", "t1", wt], { cwd: dir, stdio: "ignore" });
    startTask(e, { title: "t", type: "feature", goal: "g", done_check: "d", actor: { session_id: "s" }, cwd: wt });
    expect(checkoutLabel(e, dir)).toBe("main");
    expect(checkoutLabel(e, wt)).toMatch(/^task \d+'s worktree$/);
    expect(checkoutLabel(e, "/elsewhere")).toBe("/elsewhere");
  });
});

describe.skipIf(!HAS_GRAPHIFY)("real graphify", () => {
  function fixture() {
    const { dir, e } = engineFor(["dist/**"]);
    mkdirSync(join(dir, "src")); mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "src/a.ts"), "export function hello(n: string) { return n; }\nexport function bye() { return hello('x'); }\n");
    writeFileSync(join(dir, "dist/a.js"), "function gen() { return 1; }\n");
    writeFileSync(join(dir, "README.md"), "# readme\n");
    return { dir, e };
  }

  test("build maps code only and skips excluded folders", () => {
    const { dir, e } = fixture();
    const r = buildGraph(e, dir);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(mappedFiles(dir)).toEqual(new Set(["src/a.ts"]));
    expect(existsSync(join(dir, "graphify-out", ".estack-build.lock"))).toBe(false);
  });

  test("a second build waits for the lock", () => {
    const { dir, e } = fixture();
    mkdirSync(join(dir, "graphify-out"), { recursive: true });
    const lock = join(dir, "graphify-out", ".estack-build.lock");
    writeFileSync(lock, "other");
    spawn(process.execPath, ["-e", `setTimeout(()=>require("fs").rmSync(${JSON.stringify(lock)}),500)`], { detached: true, stdio: "ignore" }).unref();
    const r = buildGraph(e, dir);
    expect(r.ok).toBe(true);
    expect(r.duration_ms).toBeGreaterThanOrEqual(400);
    expect(loadGraph(dir)).not.toBeNull();
  });
});

describe("suggestExcludes", () => {
  test("finds dist, gitattributes and generated headers", () => {
    const { dir, e } = engineFor();
    const put = (f: string, body: string) => {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), body);
    };
    put("packages/app/dist/a.js", "x\n");
    put("src/real.ts", "export const a = 1;\n");
    put("gen/a.ts", "// Code generated by tool. DO NOT EDIT.\nexport const a = 1;\n");
    put("gen/b.ts", "/* @generated */\nexport const b = 1;\n");
    put("mixed/a.ts", "// @generated\n");
    put("mixed/b.ts", "export const b = 2;\n");
    put(".gitattributes", "*.pb.ts linguist-generated\nlib/** linguist-vendored=true\n*.txt text\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    expect(suggestExcludes(e, dir)).toEqual([
      { glob: "*.pb.ts", reason: "marked linguist-generated" },
      { glob: "gen/**", reason: "header says generated" },
      { glob: "lib/**", reason: "marked linguist-vendored" },
      { glob: "mixed/a.ts", reason: "header says generated" },
      { glob: "packages/app/dist/**", reason: "named dist" },
    ]);
  });
});
