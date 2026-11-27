import type { Engine } from "./engine";
import type { Graph, GraphEdge, GraphNode } from "./graph";
import { HOOK_GIT_TIMEOUT_MS, runBounded } from "./tasks";

export const MAX_LIST = 40;
export const MAX_MATCHES = 15;

export interface Hit { symbol: string; file: string; line: number; relation?: string; confidence?: string; why?: ("name" | "text")[] }
export interface ContextResult { graph: string; area: string; defines: Hit[]; uses: Hit[]; used_by: Hit[]; more: Record<string, number> }
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

export function contextFor(g: Graph, label: string, area: string): ContextResult {
  const a = area.replace(/\/+$/, "");
  const inArea = (n: GraphNode) => n.file === a || n.file.startsWith(a + "/");
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
  return {
    graph: label, area: a,
    defines: capped(uniqueDefines, "defines", more),
    uses: capped([...uses.values()], "uses", more),
    used_by: capped([...usedBy.values()], "used_by", more),
    more,
  };
}

export function whoUses(g: Graph, label: string, symbol: string): WhoUsesResult {
  const sep = symbol.lastIndexOf("::");
  const path = sep >= 0 ? symbol.slice(0, sep) : null;
  const name = sep >= 0 ? symbol.slice(sep + 2) : symbol;
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
