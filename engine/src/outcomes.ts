import { existsSync } from "node:fs";
import type { Engine } from "./engine";
import { mergedIntoMain } from "./plan";
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

/** A merge is in progress with the path unmerged in the feature's checkout, or a pull request is CONFLICTING with the path in both features' changes. */
function conflicted(e: Engine, g: Grant, holder: Task, grantee: Task): boolean {
  const features = [...new Map([featureOf(e, grantee), featureOf(e, holder)].map((f) => [f.id, f])).values()];
  for (const f of features) {
    if (!f.cwd || !existsSync(f.cwd)) continue;
    const r = e.exec.run("git", ["-C", f.cwd, "diff", "--name-only", "--diff-filter=U"], { cwd: e.cwd, timeoutMs: HOOK_GIT_TIMEOUT_MS });
    if (r.code === 0 && r.stdout.split("\n").includes(g.path)) return true;
  }
  if (features.length < 2) return false;
  for (const f of features) {
    if (!f.branch) continue;
    const pr = e.exec.run("gh", ["pr", "view", f.branch, "--json", "mergeable"], { cwd: e.cwd, timeoutMs: EVIDENCE_TIMEOUT_MS });
    if (pr.code !== 0) continue;
    let mergeable: unknown;
    try { mergeable = (JSON.parse(pr.stdout) as { mergeable?: unknown }).mergeable; } catch { continue; }
    if (mergeable !== "CONFLICTING") continue;
    const both = features.map((x) => changedFiles(e, x));
    if (both.every((s) => s?.has(g.path))) return true;
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

/** A worker is finished when merged into its feature, a feature when merged into main. */
function finished(e: Engine, t: Task): boolean {
  if (t.parent_id === null) return mergedIntoMain(e, t);
  return e.db.prepare("SELECT 1 FROM evidence WHERE task_id = ? AND kind = 'merged' AND ok = 1 LIMIT 1").get(t.id) !== undefined
    || mergedIntoMain(e, t);
}

function judge(e: Engine, g: Grant): Outcome | null {
  const grantee = getTask(e, g.task_id);
  const holderId = holderAtGrant(e, g);
  const holder = holderId === undefined ? undefined : getTask(e, holderId);
  if (!grantee || !holder) return null;
  if (conflicted(e, g, holder, grantee)) return "conflict";
  if (holderFailed(e, g, holder)) return "holder_failed";
  return finished(e, grantee) && finished(e, holder) ? "clean" : null;
}

/**
 * Record what became of each shared-edit grant: a merge conflict in the file, the holder's failing test or verify on a
 * change including it, or both tasks merged cleanly. Recorded once; never throws; a grant that cannot be judged now is
 * tried again next time. Runs git/gh, so only status, complete_step and run_check call it.
 */
export function recordOutcomes(e: Engine): void {
  let grants: Grant[];
  try {
    grants = e.db.prepare("SELECT id, claim_id, task_id, path, at FROM claim_grants WHERE outcome IS NULL ORDER BY id").all() as unknown as Grant[];
  } catch { return; }
  for (const g of grants) {
    try {
      const outcome = judge(e, g);
      if (!outcome) continue;
      tx(e, () => {
        const r = e.db.prepare("UPDATE claim_grants SET outcome = ?, outcome_at = ? WHERE id = ? AND outcome IS NULL")
          .run(outcome, e.now().toISOString(), g.id);
        if (r.changes === 1) logEvent(e, ENGINE, "grant_outcome", g.task_id, { grant_id: g.id, outcome });
      });
    } catch { /* tried again next time */ }
  }
}
