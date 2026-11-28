import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Engine } from "./engine";
import { logEvent } from "./tasks";

export const GRAPHIFY_ENV = { GRAPHIFY_BACKEND: "none", GRAPHIFY_QUERY_LOG_DISABLE: "1" };
export const GRAPH_SCHEMA = 1;
export const BUILD_TIMEOUT_MS = 300_000;
export const START_TASK_BUILD_TIMEOUT_MS = 60_000;
export const INSTALL_HINT = 'uv tool install "graphifyy>=0.9.121,<0.10"';

export interface GraphNode { id: string; label: string; name: string; file: string; line: number; kind: "file" | "function" | "symbol" }
export interface GraphEdge { source: string; target: string; relation: string; confidence: string; file: string; line: number }
export interface Graph {
  checkout: string; graphify_version: string; built_at_commit: string | null;
  nodes: Map<string, GraphNode>; edges: GraphEdge[]; files: Set<string>;
}
export interface BuildResult { ok: boolean; checkout: string; duration_ms: number; nodes: number; files: number; error?: string }

const MAP_ACTOR = { session_id: "map" };
const OUT_DIR = "graphify-out";

export function graphifyVersion(e: Pick<Engine, "exec" | "cwd">): string | null {
  try {
    const r = e.exec.run("graphify", ["--version"], { cwd: e.cwd, timeoutMs: 10_000 });
    if (r.code !== 0) return null;
    return /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

export function versionSupported(v: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return maj === 0 && (min === 9 && pat >= 121);
}

export function checkoutOf(e: Engine, cwd: string): string {
  const r = e.exec.run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

export function checkoutLabel(e: Engine, checkout: string): string {
  if (checkout === e.repo.root) return "main";
  const row = e.db.prepare("SELECT id FROM tasks WHERE status = 'open' AND cwd = ? ORDER BY id DESC LIMIT 1").get(checkout) as { id: number } | undefined;
  return row ? `task ${row.id}'s worktree` : checkout;
}

export function writeIgnore(e: Engine, checkout: string): void {
  const lines = [".estack/", ...e.policy.code_map.exclude];
  writeFileSync(join(checkout, ".graphifyignore"), lines.map((l) => l + "\n").join(""));
  appendExclude(e, checkout, [`${OUT_DIR}/`, ".graphifyignore"]);
}

/** Append lines missing from `<git common dir>/info/exclude`, so git ignores them without a tracked change. */
export function appendExclude(e: Engine, checkout: string, wanted: string[]): void {
  const r = e.exec.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkout, timeoutMs: 10_000 });
  if (r.code !== 0) return;
  const info = join(r.stdout.trim(), "info");
  const file = join(info, "exclude");
  mkdirSync(info, { recursive: true });
  const have = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(have.split("\n"));
  const missing = wanted.filter((l) => !present.has(l));
  if (missing.length) appendFileSync(file, (have === "" || have.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive-create the build lock, waiting up to `timeoutMs` for another build to finish; false when the wait runs out.
 * Only a lock older than BUILD_TIMEOUT_MS, longer than any build may run, is stale and replaced, whatever this waiter's timeout.
 */
function takeLock(lock: string, timeoutMs: number): boolean {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch (x) {
      if ((x as NodeJS.ErrnoException).code !== "EEXIST") throw x;
    }
    let age: number;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between the create and the stat
    }
    if (age >= BUILD_TIMEOUT_MS) rmSync(lock, { force: true });
    else if (Date.now() >= until) return false;
    else sleep(200);
  }
}

interface RawGraph {
  graph?: { schema_version?: number; graphify_version?: string };
  built_at_commit?: string | null;
  nodes?: { id: string; label?: string; source_file?: string; source_location?: string }[];
  links?: { source: string; target: string; relation?: string; confidence?: string; source_file?: string; source_location?: string }[];
}

const readRaw = (checkout: string): RawGraph | null => {
  try {
    return JSON.parse(readFileSync(join(checkout, OUT_DIR, "graph.json"), "utf8")) as RawGraph;
  } catch {
    return null;
  }
};
const lineOf = (loc: string | undefined): number => Number(/(\d+)/.exec(loc ?? "")?.[1] ?? 0);

export function loadGraph(checkout: string): Graph | null {
  const raw = readRaw(checkout);
  if (!raw) return null;
  const nodes = new Map<string, GraphNode>();
  for (const n of raw.nodes ?? []) {
    if (!n.source_file) continue;
    const label = n.label ?? n.id;
    const line = lineOf(n.source_location);
    const kind = label.endsWith("()") ? "function" : line === 1 && label.endsWith(basename(n.source_file)) ? "file" : "symbol";
    nodes.set(n.id, { id: n.id, label, name: label.replace(/\(\)$/, "").replace(/^\./, ""), file: n.source_file, line, kind });
  }
  const edges: GraphEdge[] = (raw.links ?? []).map((l) => ({
    source: l.source, target: l.target, relation: l.relation ?? "", confidence: l.confidence ?? "",
    file: l.source_file ?? "", line: lineOf(l.source_location),
  }));
  const files = new Set<string>();
  for (const n of nodes.values()) files.add(n.file);
  return { checkout, graphify_version: raw.graph?.graphify_version ?? "", built_at_commit: raw.built_at_commit ?? null, nodes, edges, files };
}

export function mappedFiles(checkout: string): Set<string> | null {
  try {
    const j = JSON.parse(readFileSync(join(checkout, OUT_DIR, "estack-files.json"), "utf8")) as { files?: string[] };
    return new Set(j.files ?? []);
  } catch {
    return null;
  }
}

export interface FolderShare { folder: string; nodes: number; percent: number }

/**
 * How much of the map each top-level folder takes (files at the root count as "(root)"), largest first, so a folder
 * that is mostly copies stands out. The three largest also list their three largest second-level folders.
 */
export function folderShares(g: Graph): (FolderShare & { sub: FolderShare[] })[] {
  const total = g.nodes.size || 1;
  const ranked = (counts: Map<string, number>): FolderShare[] =>
    [...counts].map(([folder, nodes]) => ({ folder, nodes, percent: Math.round((nodes / total) * 100) }))
      .sort((a, b) => b.nodes - a.nodes || a.folder.localeCompare(b.folder));
  const top = new Map<string, number>();
  const second = new Map<string, Map<string, number>>();
  for (const n of g.nodes.values()) {
    const parts = n.file.split("/");
    const first = parts.length > 1 ? parts[0] : "(root)";
    top.set(first, (top.get(first) ?? 0) + 1);
    if (parts.length > 2) {
      const sub = second.get(first) ?? second.set(first, new Map()).get(first)!;
      const folder = `${parts[0]}/${parts[1]}`;
      sub.set(folder, (sub.get(folder) ?? 0) + 1);
    }
  }
  return ranked(top).map((f, i) => ({ ...f, sub: i < 3 ? ranked(second.get(f.folder) ?? new Map()).slice(0, 3) : [] }));
}

export function buildGraph(e: Engine, checkout: string, timeoutMs: number = BUILD_TIMEOUT_MS): BuildResult {
  const started = Date.now();
  const finish = (r: Omit<BuildResult, "checkout" | "duration_ms">): BuildResult => {
    const res: BuildResult = { checkout, duration_ms: Date.now() - started, ...r };
    logEvent(e, MAP_ACTOR, "map_built", null, {
      checkout, ok: res.ok, duration_ms: res.duration_ms, nodes: res.nodes, ...(res.error ? { error: res.error } : {}),
    });
    return res;
  };
  const fail = (error: string) => finish({ ok: false, nodes: 0, files: 0, error });

  const v = graphifyVersion(e);
  if (v === null || !versionSupported(v)) {
    return fail(`Graphify ${v === null ? "is not installed" : `${v} is not supported`}; install it with: ${INSTALL_HINT}`);
  }
  const lock = join(checkout, OUT_DIR, ".estack-build.lock");
  let locked: boolean;
  try {
    mkdirSync(join(checkout, OUT_DIR), { recursive: true });
    locked = takeLock(lock, timeoutMs);
  } catch (x) {
    return fail(`could not take the map build lock: ${x instanceof Error ? x.message : String(x)}`);
  }
  if (!locked) return fail("another map build is still running");
  try {
    writeIgnore(e, checkout);
    const r = e.exec.run("graphify", ["extract", checkout, "--code-only"], { cwd: checkout, timeoutMs, env: GRAPHIFY_ENV });
    if (r.timedOut) return fail(`graphify timed out after ${timeoutMs}ms`);
    if (r.code !== 0) return fail(`graphify exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    const raw = readRaw(checkout);
    if (!raw) return fail("graphify wrote no readable graph.json");
    const found = raw.graph?.graphify_version ?? "unknown";
    if (raw.graph?.schema_version !== GRAPH_SCHEMA || !versionSupported(found)) {
      return fail(`expected schema ${GRAPH_SCHEMA} and Graphify >=0.9.121,<0.10, found schema ${raw.graph?.schema_version ?? "none"} and Graphify ${found}`);
    }
    const g = loadGraph(checkout)!;
    const files = [...g.files].sort();
    const out = join(checkout, OUT_DIR, "estack-files.json");
    writeFileSync(out + ".tmp", JSON.stringify({ built_at_commit: g.built_at_commit, graphify_version: g.graphify_version, files }));
    renameSync(out + ".tmp", out);
    return finish({ ok: true, nodes: g.nodes.size, files: files.length });
  } finally {
    rmSync(lock, { force: true });
  }
}

const EXCLUDE_DIRS = new Set(["dist", "build", "out", "vendor", "third_party", "generated"]);
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|dart|proto)$/;
const GENERATED_HEADER = /@generated|Code generated|DO NOT EDIT/;

/** Folders and files that look like build output, vendored or generated code, from the tracked files. */
export function suggestExcludes(e: Engine, root: string): { glob: string; reason: string }[] {
  const found = new Map<string, string>();
  const add = (glob: string, reason: string) => { if (!found.has(glob)) found.set(glob, reason); };
  const ls = e.exec.run("git", ["ls-files", "-z"], { cwd: root, timeoutMs: 30_000 });
  const files = ls.code === 0 ? ls.stdout.split("\0").filter(Boolean) : [];

  for (const f of files) {
    const dirs = f.split("/").slice(0, -1);
    for (let i = 0; i < Math.min(dirs.length, 3); i++) {
      if (EXCLUDE_DIRS.has(dirs[i])) add(dirs.slice(0, i + 1).join("/") + "/**", `named ${dirs[i]}`);
    }
  }

  try {
    for (const line of readFileSync(join(root, ".gitattributes"), "utf8").split("\n")) {
      const [pattern, ...attrs] = line.trim().split(/\s+/);
      if (!pattern || pattern.startsWith("#")) continue;
      for (const a of attrs) {
        const m = /^(linguist-generated|linguist-vendored)(?:=(.*))?$/.exec(a);
        if (m && m[2] !== "false") add(pattern, `marked ${m[1]}`);
      }
    }
  } catch { /* no .gitattributes */ }

  const byDir = new Map<string, { file: string; marked: boolean }[]>();
  for (const f of files) {
    if (!CODE_EXT.test(f)) continue;
    let head: string;
    try {
      head = readFileSync(join(root, f), "utf8").slice(0, 4096).split("\n").slice(0, 5).join("\n");
    } catch { continue; }
    const i = f.lastIndexOf("/");
    const dir = i < 0 ? "" : f.slice(0, i);
    byDir.set(dir, [...(byDir.get(dir) ?? []), { file: f, marked: GENERATED_HEADER.test(head) }]);
  }
  for (const [dir, list] of byDir) {
    if (dir !== "" && list.every((x) => x.marked)) add(dir + "/**", "header says generated");
    else for (const x of list) if (x.marked) add(x.file, "header says generated");
  }

  return [...found].map(([glob, reason]) => ({ glob, reason })).sort((a, b) => a.glob.localeCompare(b.glob, "en"));
}
