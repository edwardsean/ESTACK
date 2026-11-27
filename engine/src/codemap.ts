import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Engine } from "./engine";
import { START_TASK_BUILD_TIMEOUT_MS, buildGraph, checkoutLabel, checkoutOf, loadGraph, type Graph, type GraphEdge, type GraphNode } from "./graph";
import { HOOK_GIT_TIMEOUT_MS, runBounded, type TaskView } from "./tasks";
import { EngineError, actorId, type Actor } from "./types";

export const MAX_LIST = 40;
export const MAX_MATCHES = 15;

export interface Hit { symbol: string; file: string; line: number; relation?: string; confidence?: string; why?: ("name" | "text")[] }
export interface ContextResult { graph: string; area: string; defines: Hit[]; uses: Hit[]; used_by: Hit[]; more: Record<string, number>; note?: string }
export interface FindResult { graph: string; description: string; words: string[]; matches: Hit[] }
export interface WhoUsesResult { graph: string; symbol: string; defined_at: Hit[]; callers: Hit[]; ambiguous?: Hit[]; more?: Record<string, number> }

const USES = new Set(["calls", "indirect_call", "imports", "imports_from", "inherits", "references"]);
const USED_BY = new Set(["calls", "indirect_call", "imports", "inherits", "references"]);
const CALLERS = new Set(["calls", "indirect_call", "imports", "references", "inherits"]);
const FILLER = new Set("the and for with from into this that some any are its function helper method code thing way something".split(" "));

const hitOf = (n: GraphNode): Hit => ({ symbol: n.name, file: n.file, line: n.line });

function capped(hits: Hit[], key: string, more: Record<string, number>): Hit[] {
  if (hits.length > MAX_LIST) more[key] = hits.length - MAX_LIST;
  return hits.slice(0, MAX_LIST);
}

const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);

/** A path given absolute, `./`-prefixed or relative to the map's checkout, as the map writes it: relative to the checkout. */
export function mapPath(g: Graph, path: string): string {
  const root = real(g.checkout);
  const rel = relative(root, real(resolve(root, path))).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new EngineError("BAD_EVIDENCE", `${path} is outside the checkout ${g.checkout} that this map is for; give a path inside it`);
  }
  return rel;
}

export function contextFor(g: Graph, label: string, area: string): ContextResult {
  const a = mapPath(g, area);
  const inArea = (n: GraphNode) => a === "" || n.file === a || n.file.startsWith(a + "/");
  const defines = [...g.nodes.values()].filter((n) => inArea(n) && n.kind !== "file").map(hitOf);
  const uses = new Map<string, Hit>();
  const usedBy = new Map<string, Hit>();
  for (const ed of g.edges) {
    const s = g.nodes.get(ed.source);
    const t = g.nodes.get(ed.target);
    if (!s || !t) continue;
    if (inArea(s) && !inArea(t) && USES.has(ed.relation)) {
      uses.set(`${t.name}\0${t.file}`, { ...hitOf(t), relation: ed.relation, confidence: ed.confidence });
    } else if (!inArea(s) && inArea(t) && USED_BY.has(ed.relation)) {
      usedBy.set(`${s.name}\0${s.file}`, { symbol: s.name, file: ed.file, line: ed.line, relation: ed.relation, confidence: ed.confidence });
    }
  }
  const more: Record<string, number> = {};
  const seen = new Set<string>();
  const uniqueDefines = defines.filter((h) => !seen.has(`${h.symbol}\0${h.file}`) && seen.add(`${h.symbol}\0${h.file}`));
  const result: ContextResult = {
    graph: label, area: a || ".",
    defines: capped(uniqueDefines, "defines", more),
    uses: capped([...uses.values()], "uses", more),
    used_by: capped([...usedBy.values()], "used_by", more),
    more,
  };
  if (![...g.nodes.values()].some(inArea)) result.note = `nothing in the map under ${a || "."}; check the path, or use find_existing`;
  return result;
}

export function whoUses(g: Graph, label: string, symbol: string): WhoUsesResult {
  const at = symbol.lastIndexOf("::");
  const path = at >= 0 ? mapPath(g, symbol.slice(0, at)) : null;
  const name = at >= 0 ? symbol.slice(at + 2) : symbol;
  const found = [...g.nodes.values()].filter((n) => n.name === name && (path === null || n.file === path));
  const defined_at = found.map(hitOf);
  const result: WhoUsesResult = { graph: label, symbol, defined_at, callers: [] };
  if (path === null && new Set(found.map((n) => n.file)).size > 1) {
    result.ambiguous = defined_at;
    return result;
  }
  const ids = new Set(found.map((n) => n.id));
  const callers = g.edges
    .filter((ed: GraphEdge) => ids.has(ed.target) && CALLERS.has(ed.relation) && g.nodes.has(ed.source))
    .map((ed) => ({ symbol: g.nodes.get(ed.source)!.name, file: ed.file, line: ed.line, relation: ed.relation, confidence: ed.confidence }));
  result.callers = callers.slice(0, MAX_LIST);
  if (callers.length > MAX_LIST) result.more = { callers: callers.length - MAX_LIST };
  return result;
}

export function descriptionWords(description: string): string[] {
  const out: string[] = [];
  for (const w of description.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !FILLER.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

function textHits(e: Engine, g: Graph, words: string[]): { file: string; line: number; text: string }[] {
  let stdout = "";
  try {
    const r = runBounded(e, g.checkout, "git", ["grep", "--untracked", "-n", "-i", "-F", ...words.flatMap((w) => ["-e", w])], HOOK_GIT_TIMEOUT_MS);
    if (r.code !== 0) return [];
    stdout = r.stdout;
  } catch {
    return [];
  }
  const hits: { file: string; line: number; text: string }[] = [];
  for (const raw of stdout.split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(raw);
    if (m && g.files.has(m[1])) hits.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  return hits;
}

export function findExisting(e: Engine, g: Graph, label: string, description: string): FindResult {
  const words = descriptionWords(description);
  const result: FindResult = { graph: label, description, words, matches: [] };
  if (words.length === 0) return result;

  const byFile = new Map<string, GraphNode[]>();
  const candidates = [...g.nodes.values()].filter((n) => n.kind !== "file");
  for (const n of candidates) {
    if (n.kind === "function") byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
  }
  const score = new Map<string, { node: GraphNode; name: Set<string>; text: Set<string> }>();
  const entry = (n: GraphNode) => {
    let s = score.get(n.id);
    if (!s) score.set(n.id, (s = { node: n, name: new Set(), text: new Set() }));
    return s;
  };
  for (const n of candidates) {
    const lower = n.name.toLowerCase();
    for (const w of words) if (lower.includes(w)) entry(n).name.add(w);
  }
  for (const h of textHits(e, g, words)) {
    const fns = byFile.get(h.file) ?? [];
    let best: GraphNode | undefined;
    for (const f of fns) if (f.line <= h.line && (!best || f.line > best.line)) best = f;
    if (!best) for (const f of fns) if (f.line > h.line && f.line - h.line <= 3 && (!best || f.line < best.line)) best = f;
    if (!best) continue;
    const lower = h.text.toLowerCase();
    const s = entry(best);
    for (const w of words) if (lower.includes(w)) s.text.add(w);
  }
  const ranked = [...score.values()]
    .map((s) => ({ s, total: new Set([...s.name, ...s.text]).size }))
    .filter((r) => r.total > 0)
    .sort((x, y) => y.total - x.total || Number(y.s.name.size > 0) - Number(x.s.name.size > 0) || x.s.node.file.localeCompare(y.s.node.file) || x.s.node.line - y.s.node.line);
  result.matches = ranked.slice(0, MAX_MATCHES).map(({ s }) => ({
    ...hitOf(s.node),
    why: [...(s.name.size ? ["name" as const] : []), ...(s.text.size ? ["text" as const] : [])],
  }));
  return result;
}

export type CodeTool = "context_for" | "find_existing" | "who_uses";
const RESULT_CAP = 20000;

/** Run one code-map query for an actor and log it in code_queries (success or failure) before returning or throwing. */
export function runCodeQuery(e: Engine, input: { tool: CodeTool; arg: string; actor: Actor; cwd?: string; task_id?: number; auto?: boolean }): unknown {
  if (!e.policy.code_map.enabled) {
    throw new EngineError("MAP_OFF", "the code map is off for this repository (code_map.enabled is false in .estack/policy.yaml); search with Read and Grep instead");
  }
  const checkout = checkoutOf(e, input.cwd ?? e.cwd);
  const by = actorId(input.actor);
  let taskId: number | null = null;
  let version: string | null = null;
  const log = (ok: boolean, result: string) => {
    e.db.prepare(
      "INSERT INTO code_queries (task_id, tool, input, result_json, ok, auto, graph_version, checkout, recorded_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(taskId, input.tool, input.arg, result.slice(0, RESULT_CAP), ok ? 1 : 0, input.auto ? 1 : 0, version, checkout, by, e.now().toISOString());
  };
  try {
    if (input.task_id !== undefined) {
      const t = e.db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(input.task_id) as { id: number; status: string } | undefined;
      if (!t) throw new EngineError("NO_TASK", `no task with id ${input.task_id}`);
      if (t.status !== "open") throw new EngineError("TASK_CLOSED", `task ${t.id} is ${t.status}`);
      taskId = t.id;
    } else {
      const t = e.db.prepare(
        `SELECT t.id FROM tasks t JOIN task_bindings b ON b.task_id = t.id
         WHERE t.status = 'open' AND t.cwd = ? AND b.session_id = ? ORDER BY t.id DESC LIMIT 1`,
      ).get(checkout, input.actor.session_id) as { id: number } | undefined;
      taskId = t?.id ?? null;
    }
    const label = checkoutLabel(e, checkout);
    const g = loadGraph(checkout);
    if (!g) throw new EngineError("MAP_BROKEN", `no code map for ${label} yet: run "estack map update" there, or start a task in it`);
    version = `${g.graphify_version}@${g.built_at_commit}`;
    const result = input.tool === "context_for" ? contextFor(g, label, input.arg)
      : input.tool === "who_uses" ? whoUses(g, label, input.arg)
      : findExisting(e, g, label, input.arg);
    log(true, JSON.stringify(result));
    return result;
  } catch (x) {
    log(false, x instanceof EngineError ? `${x.code}: ${x.message}` : String(x instanceof Error ? x.message : x));
    throw x;
  }
}

/** The map context start_task adds: builds the task's checkout map if missing, then runs context_for for the area. */
export function taskContext(e: Engine, v: TaskView, area: string | undefined, actor: Actor): { context?: ContextResult; map_note?: string } {
  if (!e.policy.code_map.enabled) return {};
  const cwd = v.task.cwd;
  if (!loadGraph(cwd)) {
    const b = buildGraph(e, cwd, START_TASK_BUILD_TIMEOUT_MS);
    if (!b.ok) return { map_note: `code map unavailable: ${b.error}` };
  }
  if (area === undefined) return { map_note: "call context_for with the area you will change before writing code" };
  try {
    return { context: runCodeQuery(e, { tool: "context_for", arg: area, actor, cwd, task_id: v.task.id, auto: true }) as ContextResult };
  } catch (x) {
    return { map_note: `code map unavailable: ${x instanceof Error ? x.message : String(x)}` };
  }
}
