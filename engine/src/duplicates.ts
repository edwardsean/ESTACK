import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "./engine";
import { buildGraph, loadGraph, type Graph, type GraphNode } from "./graph";
import { pathMatches } from "./match";
import { HOOK_GIT_TIMEOUT_MS, getTask, logEvent, runBounded, tx } from "./tasks";
import { EngineError, actorId, type Actor, type Task } from "./types";

export interface Duplicate {
  id: number; task_id: number; commit_sha: string; new_symbol: string; new_file: string; new_line: number;
  existing_symbol: string; existing_file: string; existing_line: number;
  status: "open" | "resolved" | "dismissed"; reason: string | null; closed_by: string | null;
}

export const NAME_PREFIXES = ["get", "make", "build", "create", "compute", "calculate", "calc", "do"];
const MAP_ACTOR: Actor = { session_id: "map" };
const TEST_PATTERNS = ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**"];

export function normaliseName(name: string): string {
  const n = name.toLowerCase().replace(/[_-]/g, "");
  const p = NAME_PREFIXES.find((x) => n.startsWith(x) && n.length - x.length >= 3);
  return p ? n.slice(p.length) : n;
}

/** The parameter count of the function starting at `line`, read from its source; null when no parameter list is found. */
export function paramCount(checkout: string, file: string, line: number): number | null {
  let src: string;
  try {
    src = readFileSync(join(checkout, file), "utf8").split("\n").slice(Math.max(0, line - 1), line + 4).join("\n");
  } catch {
    return null;
  }
  const start = src.indexOf("(");
  if (start < 0) return null;
  let depth = 0;
  let commas = 0;
  let body = "";
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || (c === ">" && src[i - 1] !== "=")) depth--;
    if (depth === 0) return body.trim() === "" ? 0 : commas + 1;
    if (i > start) {
      if (c === "," && depth === 1) commas++;
      body += c;
    }
  }
  return null;
}

export function isTestFile(file: string): boolean {
  return TEST_PATTERNS.some((p) => pathMatches(file, p));
}

/**
 * Top-level functions of `g` outside test files: targets of a `contains` edge from a file node. Graphify links a method
 * from its class with a `method` edge and a nested function from its enclosing function, so neither is one.
 */
export function topLevelFunctions(g: Graph): GraphNode[] {
  const out = new Map<string, GraphNode>();
  for (const ed of g.edges) {
    if (ed.relation !== "contains" || g.nodes.get(ed.source)?.kind !== "file") continue;
    const n = g.nodes.get(ed.target);
    if (n?.kind === "function" && !isTestFile(n.file)) out.set(n.id, n);
  }
  return [...out.values()];
}

/** Top-level functions of `g` (outside test files) that start on a line the task's branch added. */
export function newFunctions(e: Engine, g: Graph, task: Task): GraphNode[] {
  const r = runBounded(e, task.cwd, "git", ["diff", "-U0", "--no-color", `${task.base_sha}..refs/heads/${task.branch}`]);
  if (r.code !== 0) return [];
  const added = new Map<string, [number, number][]>();
  let file: string | null = null;
  for (const l of r.stdout.split("\n")) {
    if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") ? l.slice(6) : null;
    else if (file) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) (added.get(file) ?? added.set(file, []).get(file)!).push([start, start + count - 1]);
    }
  }
  return topLevelFunctions(g).filter((n) => (added.get(n.file) ?? []).some(([a, b]) => n.line >= a && n.line <= b));
}

const matches = (checkout: string, f: GraphNode, x: GraphNode): boolean => {
  if (normaliseName(f.name) !== normaliseName(x.name)) return false;
  const a = paramCount(checkout, f.file, f.line);
  const b = paramCount(checkout, x.file, x.line);
  return a === null || b === null || a === b;
};

export function openDuplicates(e: Engine, task_id: number): Duplicate[] {
  return e.db.prepare("SELECT * FROM duplicates WHERE task_id = ? AND status = 'open' ORDER BY id").all(task_id) as unknown as Duplicate[];
}

const branchHead = (e: Engine, task: Task): string =>
  runBounded(e, task.cwd, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`]).stdout.trim();

/** Compare the task's new functions with the rest of the graph; returns the open duplicates. */
export function checkDuplicates(e: Engine, task_id: number): Duplicate[] {
  const task = getTask(e, task_id).task;
  const g = loadGraph(task.cwd);
  if (!g) return [];
  const top = topLevelFunctions(g);
  // git runs before the transaction, so the write lock is held only while rows and events are written.
  const fresh = newFunctions(e, g, task);
  const head = branchHead(e, task);
  const byKey = (file: string, name: string) => top.find((n) => n.file === file && n.name === name);
  const freshIds = new Set(fresh.map((n) => n.id));

  return tx(e, () => {
    const now = e.now().toISOString();
    for (const d of openDuplicates(e, task_id)) {
      const f = fresh.find((n) => n.file === d.new_file && n.name === d.new_symbol);
      const x = byKey(d.existing_file, d.existing_symbol);
      if (f && x && matches(task.cwd, f, x)) continue;
      e.db.prepare("UPDATE duplicates SET status = 'resolved', closed_at = ? WHERE id = ?").run(now, d.id);
    }
    for (const f of fresh) {
      for (const x of top) {
        if (x.id === f.id) continue;
        if (freshIds.has(x.id) && x.id < f.id) continue; // an unordered pair is recorded once
        if (!matches(task.cwd, f, x)) continue;
        const prior = e.db.prepare(
          "SELECT id, status FROM duplicates WHERE task_id = ? AND new_file = ? AND new_symbol = ? AND existing_file = ? AND existing_symbol = ?",
        ).get(task_id, f.file, f.name, x.file, x.name) as { id: number; status: string } | undefined;
        if (prior?.status === "open" || prior?.status === "dismissed") continue; // a reviewer's dismissal stands
        if (prior) {
          e.db.prepare(
            "UPDATE duplicates SET status = 'open', commit_sha = ?, new_line = ?, existing_line = ?, closed_by = NULL, closed_at = NULL, found_at = ? WHERE id = ?",
          ).run(head, f.line, x.line, now, prior.id);
        } else {
          const r = e.db.prepare(
            `INSERT INTO duplicates (task_id, commit_sha, new_symbol, new_file, new_line, existing_symbol, existing_file, existing_line, status, found_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?) ON CONFLICT DO NOTHING`,
          ).run(task_id, head, f.name, f.file, f.line, x.name, x.file, x.line, now);
          if (Number(r.changes) === 0) continue; // already recorded
        }
        logEvent(e, MAP_ACTOR, "possible_duplicate", task_id, { new: `${f.file}:${f.line}`, existing: `${x.file}:${x.line}`, symbol: f.name });
      }
    }
    logEvent(e, MAP_ACTOR, "duplicate_check_done", task_id, { head });
    return openDuplicates(e, task_id);
  });
}

/** Make sure the duplicate check has run for the branch's current head, building the graph if it has not. */
export function ensureDuplicateCheck(e: Engine, task_id: number): void {
  if (!e.policy.code_map.enabled) return;
  const task = getTask(e, task_id).task;
  const head = branchHead(e, task);
  const last = e.db.prepare("SELECT payload_json FROM events WHERE task_id = ? AND kind = 'duplicate_check_done' ORDER BY id DESC LIMIT 1")
    .get(task_id) as { payload_json: string } | undefined;
  if (last && (JSON.parse(last.payload_json) as { head?: string }).head === head) return;
  const b = buildGraph(e, task.cwd);
  if (!b.ok) throw new EngineError("MAP_BROKEN", `the duplicate check could not run: ${b.error}`);
  checkDuplicates(e, task_id);
}

/** Called after a commit has rebuilt the graph: check the open task whose worktree and branch this is. */
export function afterCommit(e: Engine, checkout: string): void {
  const branch = runBounded(e, checkout, "git", ["branch", "--show-current"], HOOK_GIT_TIMEOUT_MS).stdout.trim();
  if (!branch) return;
  const row = e.db.prepare("SELECT id FROM tasks WHERE status = 'open' AND cwd = ? AND branch = ? ORDER BY id DESC LIMIT 1")
    .get(checkout, branch) as { id: number } | undefined;
  if (row) checkDuplicates(e, row.id);
}

export function dismissDuplicate(e: Engine, input: { id: number; reason: string; actor: Actor }): Duplicate {
  const d = e.db.prepare("SELECT * FROM duplicates WHERE id = ?").get(input.id) as unknown as Duplicate | undefined;
  if (!d) throw new EngineError("NO_TASK", `no possible duplicate with id ${input.id}`);
  if (d.status !== "open") throw new EngineError("BAD_EVIDENCE", `possible duplicate #${d.id} is already ${d.status}`);
  if (!input.reason.trim()) throw new EngineError("BAD_EVIDENCE", "a reason is required to dismiss a possible duplicate");
  if (input.actor.session_id === "unknown" && !input.actor.agent_id) {
    throw new EngineError("BAD_EVIDENCE", "an unidentified caller can't dismiss a possible duplicate; pass your actor");
  }
  const v = getTask(e, d.task_id);
  const commit = [...v.evidence].reverse().find((x) => x.kind === "commit" && x.ok);
  const author = commit ? commit.recorded_by : v.task.created_by;
  const by = actorId(input.actor);
  if (by === author) throw new EngineError("BAD_EVIDENCE", "the task's author can't dismiss its own possible duplicate; ask a reviewer");
  e.db.prepare("UPDATE duplicates SET status = 'dismissed', reason = ?, closed_by = ?, closed_at = ? WHERE id = ?")
    .run(input.reason, by, e.now().toISOString(), d.id);
  logEvent(e, input.actor, "duplicate_dismissed", d.task_id, { id: d.id, reason: input.reason });
  return e.db.prepare("SELECT * FROM duplicates WHERE id = ?").get(d.id) as unknown as Duplicate;
}
