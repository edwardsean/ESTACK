import { existsSync } from "node:fs";
import type { Engine } from "./engine";
import { OutOfBudget, mergeCheck, mergedIntoMain, type MergeCheck } from "./plan";
import { EVIDENCE_TIMEOUT_MS, HOOK_GIT_TIMEOUT_MS, logEvent, tx } from "./tasks";
import type { Actor, Task } from "./types";

const ENGINE: Actor = { session_id: "engine" };
type Outcome = "conflict" | "holder_failed" | "clean";
interface Grant { id: number; claim_id: number; task_id: number; path: string; at: string }

const getTask = (e: Engine, id: number): Task | undefined =>
  e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task | undefined;
const featureOf = (e: Engine, t: Task): Task => (t.parent_id === null ? t : getTask(e, t.parent_id) ?? t);

/** The holder when the grant was made (from the `claim_granted` event, since claims later pass to a feature), else the claim's task now. */
function holderAtGrant(e: Engine, g: Grant): number | undefined {
  const rows = e.db.prepare("SELECT payload_json p FROM events WHERE kind = 'claim_granted' AND task_id = ? ORDER BY id").all(g.task_id) as { p: string }[];
  for (const r of rows) {
    const p = JSON.parse(r.p) as { path?: unknown; holder?: unknown };
    if (p.path === g.path && typeof p.holder === "number") return p.holder;
  }
  return (e.db.prepare("SELECT task_id FROM claims WHERE id = ?").get(g.claim_id) as { task_id: number } | undefined)?.task_id;
}

/** Files a task changed from its base: committed, staged, modified or untracked. null when its checkout cannot be read. */
function changedFiles(e: Engine, t: Task): Set<string> | null {
  if (!t.cwd || !existsSync(t.cwd)) return null;
  const run = (args: string[]) => e.exec.run("git", args, { cwd: t.cwd, timeoutMs: HOOK_GIT_TIMEOUT_MS });
  const diff = run(["diff", "--name-only", t.base_sha]);
  if (diff.code !== 0) return null;
  const fresh = run(["ls-files", "--others", "--exclude-standard"]);
  return new Set([...diff.stdout.split("\n"), ...(fresh.code === 0 ? fresh.stdout.split("\n") : [])].filter(Boolean));
}

export const OUTCOME_BUDGET_MS = 10_000;

/** One recordOutcomes call: what it may run, its time budget and what it has already asked per feature. */
interface Ctx {
  remote: boolean;
  deadline: number;
  check: MergeCheck;
  mergeable: Map<number, boolean>;
  merged: Map<number, boolean>;
}
const checkBudget = (c: Ctx): void => { if (Date.now() >= c.deadline) throw new OutOfBudget(); };

/** True when the feature's pull request is CONFLICTING (asked once per feature per call). */
function prConflicting(e: Engine, c: Ctx, f: Task): boolean {
  const known = c.mergeable.get(f.id);
  if (known !== undefined) return known;
  checkBudget(c);
  let bad = false;
  if (f.branch) {
    const pr = e.exec.run("gh", ["pr", "view", f.branch, "--json", "mergeable"], { cwd: e.cwd, timeoutMs: EVIDENCE_TIMEOUT_MS });
    if (pr.code === 0) {
      try { bad = (JSON.parse(pr.stdout) as { mergeable?: unknown }).mergeable === "CONFLICTING"; } catch { /* not conflicting as far as we know */ }
    }
  }
  c.mergeable.set(f.id, bad);
  return bad;
}

/** True when the feature is merged into main (asked once per feature per call; the shared check fetches at most once). */
function featureMerged(e: Engine, c: Ctx, f: Task): boolean {
  const known = c.merged.get(f.id);
  if (known !== undefined) return known;
  checkBudget(c);
  const r = mergedIntoMain(e, f, c.check);
  c.merged.set(f.id, r);
  return r;
}

/** A merge is in progress with the path unmerged in a feature's checkout, or (remote) a pull request is CONFLICTING with the path in both features' changes. */
function conflicted(e: Engine, c: Ctx, g: Grant, holder: Task, grantee: Task): boolean {
  const features = [...new Map([featureOf(e, grantee), featureOf(e, holder)].map((f) => [f.id, f])).values()];
  for (const f of features) {
    if (!f.cwd || !existsSync(f.cwd)) continue;
    const r = e.exec.run("git", ["-C", f.cwd, "diff", "--name-only", "--diff-filter=U"], { cwd: e.cwd, timeoutMs: HOOK_GIT_TIMEOUT_MS });
    if (r.code === 0 && r.stdout.split("\n").includes(g.path)) return true;
  }
  if (!c.remote || features.length < 2) return false;
  for (const f of features) {
    if (prConflicting(e, c, f) && features.every((x) => changedFiles(e, x)?.has(g.path))) return true;
  }
  return false;
}

/** The holder's test or verify failed after the grant, on a change that includes the path. */
function holderFailed(e: Engine, g: Grant, holder: Task): boolean {
  const failed = e.db.prepare(
    "SELECT 1 FROM evidence WHERE task_id = ? AND kind = 'command' AND ok = 0 AND step IN ('test', 'verify') AND recorded_at >= ? LIMIT 1",
  ).get(holder.id, g.at);
  return failed !== undefined && (changedFiles(e, holder)?.has(g.path) ?? false);
}

const workerMerged = (e: Engine, t: Task): boolean =>
  t.parent_id !== null && e.db.prepare("SELECT 1 FROM evidence WHERE task_id = ? AND kind = 'merged' AND ok = 1 LIMIT 1").get(t.id) !== undefined;

/**
 * Both tasks finished. Within one feature a worker is finished once merged into it (local), the feature itself once
 * merged into main. Across features, both features must be merged into main (remote only), so a later conflict between
 * the two is not missed.
 */
function finished(e: Engine, c: Ctx, a: Task, b: Task): boolean {
  const fa = featureOf(e, a);
  const fb = featureOf(e, b);
  if (fa.id === fb.id) {
    const done = (t: Task) => (t.parent_id === null ? c.remote && featureMerged(e, c, t) : workerMerged(e, t) || (c.remote && featureMerged(e, c, fa)));
    return done(a) && done(b);
  }
  return c.remote && featureMerged(e, c, fa) && featureMerged(e, c, fb);
}

function judge(e: Engine, c: Ctx, g: Grant): Outcome | null {
  const grantee = getTask(e, g.task_id);
  const holderId = holderAtGrant(e, g);
  const holder = holderId === undefined ? undefined : getTask(e, holderId);
  if (!grantee || !holder) return null;
  if (conflicted(e, c, g, holder, grantee)) return "conflict";
  if (holderFailed(e, g, holder)) return "holder_failed";
  return finished(e, c, grantee, holder) ? "clean" : null;
}

/** Record one grant's outcome, once. */
function setOutcome(e: Engine, g: Grant, outcome: Outcome): void {
  tx(e, () => {
    const r = e.db.prepare("UPDATE claim_grants SET outcome = ?, outcome_at = ? WHERE id = ? AND outcome IS NULL")
      .run(outcome, e.now().toISOString(), g.id);
    if (r.changes === 1) logEvent(e, ENGINE, "grant_outcome", g.task_id, { grant_id: g.id, outcome });
  });
}

/**
 * The paths that conflicted when `head` was merged into `branch`: git merge-tree replays the merge commit (its first
 * parent with `head`) and lists them; a git without `merge-tree --write-tree` falls back to the "Conflicts:" block git
 * writes into the merge commit's message. No merge commit (a fast-forward) means no conflict.
 */
export function mergeConflicts(e: Engine, cwd: string, branch: string, head: string): string[] {
  const run = (args: string[]) => e.exec.run("git", args, { cwd, timeoutMs: EVIDENCE_TIMEOUT_MS });
  const merges = run(["rev-list", "--merges", "--parents", `${head}..refs/heads/${branch}`]);
  if (merges.code !== 0) return [];
  // The oldest merge commit with `head` as a merged (not first) parent.
  const merge = merges.stdout.split("\n").map((l) => l.trim().split(" ")).filter((p) => p.slice(2).includes(head)).at(-1);
  if (!merge) return [];
  const [sha, first] = merge;
  const tree = run(["merge-tree", "--write-tree", "--name-only", "--no-messages", first, head]);
  if (tree.code === 0) return [];
  if (tree.code === 1) return tree.stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  const msg = run(["log", "-1", "--format=%B", sha]);
  if (msg.code !== 0) return [];
  const lines = msg.stdout.split("\n");
  const at = lines.findIndex((l) => /^#?\s*Conflicts:\s*$/.test(l));
  const out: string[] = [];
  for (const l of at < 0 ? [] : lines.slice(at + 1)) {
    const m = /^#?\t(.+)$/.exec(l);
    if (!m) break;
    out.push(m[1].trim());
  }
  return out;
}

/**
 * A worker's merge into its feature just completed: every open grant on a path that conflicted in that merge, held by or
 * granted to the worker or the feature, is a conflict, even though the CTO resolved and committed it before the step.
 * Runs before any clean check; never throws.
 */
export function recordMergeConflicts(e: Engine, worker: Task, feature: Task, head: string): void {
  try {
    const paths = new Set(mergeConflicts(e, feature.cwd && existsSync(feature.cwd) ? feature.cwd : e.repo.root, feature.branch, head));
    if (paths.size === 0) return;
    const involved = new Set([worker.id, feature.id]);
    const grants = (e.db.prepare("SELECT id, claim_id, task_id, path, at FROM claim_grants WHERE outcome IS NULL ORDER BY id").all() as unknown as Grant[])
      .filter((g) => paths.has(g.path));
    for (const g of grants) {
      const holder = holderAtGrant(e, g);
      if (involved.has(g.task_id) || (holder !== undefined && involved.has(holder))) setOutcome(e, g, "conflict");
    }
  } catch { /* left for recordOutcomes */ }
}

/**
 * Record what became of each shared-edit grant: a merge conflict in the file, the holder's failing test or verify on a
 * change including it, or both tasks merged cleanly. Recorded once; never throws; a grant that cannot be judged now is
 * tried again next time. With `remote: false` (complete_step, run_check) it reads only local state and makes no gh call
 * or fetch; `remote: true` (status) adds the pull request and merged-into-main checks, asked once per feature. The call
 * stops when its time budget is spent, leaving the remaining grants for next time.
 */
export function recordOutcomes(e: Engine, opts: { remote?: boolean; budget_ms?: number } = {}): void {
  const budget = opts.budget_ms ?? OUTCOME_BUDGET_MS;
  const c: Ctx = { remote: opts.remote ?? true, deadline: Date.now() + budget, check: mergeCheck(budget), mergeable: new Map(), merged: new Map() };
  let grants: Grant[];
  try {
    grants = e.db.prepare("SELECT id, claim_id, task_id, path, at FROM claim_grants WHERE outcome IS NULL ORDER BY id").all() as unknown as Grant[];
  } catch { return; }
  for (const g of grants) {
    if (Date.now() >= c.deadline) return;
    try {
      const outcome = judge(e, c, g);
      if (outcome) setOutcome(e, g, outcome);
    } catch { /* tried again next time */ }
  }
}
