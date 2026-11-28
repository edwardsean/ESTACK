import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { Engine } from "./engine";
import { isExempt, pathMatches } from "./match";
import { normaliseName, topLevelFunctions } from "./duplicates";
import { loadGraph } from "./graph";
import { OutOfBudget, areaPath, mergeCheck, mergedIntoMain, prState, type MergeCheck } from "./plan";
import { HOOK_GIT_TIMEOUT_MS, logEvent, ownsTask, runBounded, tx } from "./tasks";
import { EngineError, actorId, type Actor, type Task } from "./types";
import { WORKTREES_DIR, removeWorktree } from "./worktree";

export type EditVerdict = { ok: true } | { ok: false; holder: Task; claim_id: number };

const ENGINE: Actor = { session_id: "engine" };
const iso = (e: Engine) => e.now().toISOString();

/** Files no task ever holds: `exempt_paths` (edited with no task) and `claims.exempt` (lockfiles and the like). */
export function isClaimExempt(e: Engine, path: string): boolean {
  return isExempt(path, e.policy) || e.policy.claims.exempt.some((p) => pathMatches(path, p));
}

/** The task holding a file, if any. */
export function holderOf(e: Engine, path: string): { claim_id: number; task: Task } | null {
  const row = e.db.prepare(
    `SELECT c.id AS claim_id, t.* FROM claims c JOIN tasks t ON t.id = c.task_id
     WHERE c.kind = 'file' AND c.target = ? AND c.status = 'active'`,
  ).get(path) as unknown as (Task & { claim_id: number }) | undefined;
  if (!row) return null;
  const { claim_id, ...task } = row;
  return { claim_id, task: task as Task };
}

/** The refusal an agent sees for a held file. */
export function heldMessage(path: string, holder: Task): string {
  return `${path} is held by task #${holder.id} (goal: ${holder.goal}); report to your CTO, which can check it with claim_status and allow it with allow_edit.`;
}

/** True when the task has been granted an edit on the path. */
export function hasGrant(e: Engine, task_id: number, path: string): boolean {
  return e.db.prepare("SELECT 1 FROM claim_grants WHERE task_id = ? AND path = ? LIMIT 1").get(task_id, path) !== undefined;
}

/** The holder never blocks itself, a task in the same checkout (one working copy cannot clash), its parent or child, a task in its group under the same feature, or a task with a grant. */
function mayEdit(e: Engine, task: Task, holder: Task, path: string): boolean {
  return holder.id === task.id || holder.cwd === task.cwd || holder.id === task.parent_id || holder.parent_id === task.id
    || (task.task_group !== null && holder.task_group === task.task_group && holder.parent_id === task.parent_id)
    || hasGrant(e, task.id, path);
}

/** Take a free file for the task (unless `take` is false), or say who holds it. A lost insert race (UNIQUE) re-reads the holder. */
export function checkEdit(e: Engine, task: Task, path: string, actor: Actor = ENGINE, take = true): EditVerdict {
  if (isClaimExempt(e, path)) return { ok: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = holderOf(e, path);
    if (held) {
      if (mayEdit(e, task, held.task, path)) return { ok: true };
      logEvent(e, actor, "claim_denied", task.id, { path, holder: held.task.id, claim_id: held.claim_id });
      return { ok: false, holder: held.task, claim_id: held.claim_id };
    }
    if (!take) return { ok: true };
    try {
      tx(e, () => {
        const r = e.db.prepare("INSERT INTO claims (task_id, kind, target, status, at) VALUES (?, 'file', ?, 'active', ?)")
          .run(task.id, path, iso(e));
        logEvent(e, actor, "claim_taken", task.id, { path, claim_id: Number(r.lastInsertRowid) });
      });
      return { ok: true };
    } catch (x) {
      if (!(x instanceof Error) || !/UNIQUE constraint failed/.test(x.message)) throw x;
      // Another task took it just now: read the holder again.
    }
  }
  // Three lost races in a row: the holder keeps changing, so report whoever holds it now.
  const held = holderOf(e, path);
  if (held && !mayEdit(e, task, held.task, path)) return { ok: false, holder: held.task, claim_id: held.claim_id };
  return { ok: true };
}

/** A merged worker's claims become its feature's. */
export function passClaims(e: Engine, from: Task, to: Task, actor: Actor = ENGINE): void {
  const rows = e.db.prepare("SELECT id, kind, target FROM claims WHERE task_id = ? AND status = 'active' ORDER BY id")
    .all(from.id) as { id: number; kind: string; target: string }[];
  for (const c of rows) {
    e.db.prepare("UPDATE claims SET task_id = ? WHERE id = ?").run(to.id, c.id);
    logEvent(e, actor, "claim_passed", to.id, { claim_id: c.id, kind: c.kind, path: c.target, from: from.id, to: to.id });
  }
}

/**
 * Release every active claim of a task (its feature merged into main, or it was cancelled). A file with a grant for
 * another still-open task goes to the newest such grant's task. Not transactional itself: call it inside `tx`.
 */
export function releaseClaims(e: Engine, task: Task, actor: Actor, reason?: string): void {
  const rows = e.db.prepare("SELECT id, kind, target FROM claims WHERE task_id = ? AND status = 'active' ORDER BY id")
    .all(task.id) as { id: number; kind: string; target: string }[];
  for (const c of rows) releaseOne(e, c, task.id, actor, reason);
}

/**
 * A task that closed with neither a `pr` nor a `merge` step (a spike, say) never reaches main: its claims go as it
 * closes. Call inside the transaction that closes it.
 */
export function releaseOnClose(e: Engine, task_id: number, actor: Actor): void {
  if (hasPrOrMergeStep(e, task_id)) return;
  const task = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as unknown as Task | undefined;
  if (task) releaseClaims(e, task, actor, "closed with no pr or merge step");
}

/**
 * A worker that closed with neither a `pr` nor a `merge` step (a worker spike) is never merged, so nothing else removes
 * its worktree: remove it now, after the closing transaction. Dirty and nested worktrees are kept and reported, never forced.
 */
export function removeOnClose(e: Engine, task_id: number): void {
  const task = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as unknown as Task | undefined;
  if (!task || task.parent_id === null || task.status !== "done") return;
  if (hasPrOrMergeStep(e, task_id)) return;
  removeWorktreeLogged(e, task);
}

/** True when the task has a `pr` or `merge` step, so its work reaches main and is released with it. */
function hasPrOrMergeStep(e: Engine, task_id: number): boolean {
  return e.db.prepare("SELECT 1 FROM steps WHERE task_id = ? AND name IN ('pr', 'merge') LIMIT 1").get(task_id) !== undefined;
}

/** removeWorktree, where a failure is logged as a kept worktree instead of thrown (the step it follows is already recorded). */
export function removeWorktreeLogged(e: Engine, task: Task): void {
  try { removeWorktree(e, task); } catch (x) {
    logEvent(e, ENGINE, "worktree_kept", task.id, { path: task.cwd, reason: x instanceof Error ? x.message : String(x) });
  }
}

/** Release one active claim and hand a file to the newest open grant. Not transactional itself. */
function releaseOne(e: Engine, c: { id: number; kind: string; target: string }, task_id: number, actor: Actor, reason?: string): void {
  e.db.prepare("UPDATE claims SET status = 'released', released_at = ? WHERE id = ?").run(iso(e), c.id);
  logEvent(e, actor, "claim_released", task_id, { claim_id: c.id, kind: c.kind, path: c.target, ...(reason ? { reason } : {}) });
  if (c.kind !== "file") return;
  const grant = e.db.prepare(
    `SELECT g.id, g.task_id FROM claim_grants g JOIN tasks t ON t.id = g.task_id
     WHERE g.path = ? AND g.task_id != ? AND t.status = 'open' ORDER BY g.id DESC LIMIT 1`,
  ).get(c.target, task_id) as { id: number; task_id: number } | undefined;
  if (!grant) return;
  const r = e.db.prepare("INSERT INTO claims (task_id, kind, target, status, at) VALUES (?, 'file', ?, 'active', ?)")
    .run(grant.task_id, c.target, iso(e));
  logEvent(e, actor, "claim_taken", grant.task_id, { path: c.target, claim_id: Number(r.lastInsertRowid), from_grant: grant.id });
}

/** syncMerged's time budget: no new task or gh call is started once it is spent; the rest wait for the next call. */
export const SYNC_BUDGET_MS = 10_000;

/**
 * Done features known merged into main give up their claims and, when the engine made it, their worktree; a done feature
 * whose pull request was closed unmerged gives up its claims too. Open tasks are left alone until their `pr` step is
 * recorded. Checks merge state with gh/git, so only status and start_task call it, never a per-edit hook. gh is asked
 * once per branch and origin fetched at most once per call, within SYNC_BUDGET_MS. A failing check leaves the feature
 * alone until the next call.
 */
export function syncMerged(e: Engine, opts: { budget_ms?: number; check?: MergeCheck } = {}): void {
  const rows = e.db.prepare(
    `SELECT * FROM tasks WHERE parent_id IS NULL AND status = 'done' AND (
       id IN (SELECT task_id FROM claims WHERE status = 'active') OR cwd LIKE '%/' || ? || '/%') ORDER BY id`,
  ).all(WORKTREES_DIR) as unknown as Task[];
  const todo = rows.map((task) => ({
    task,
    hasClaims: e.db.prepare("SELECT 1 FROM claims WHERE task_id = ? AND status = 'active'").get(task.id) !== undefined,
    hasTree: task.cwd.includes(`/${WORKTREES_DIR}/`) && existsSync(task.cwd),
  })).filter((x) => x.hasClaims || x.hasTree);
  const check = opts.check ?? mergeCheck(opts.budget_ms ?? SYNC_BUDGET_MS);
  for (const { task, hasClaims, hasTree } of todo) {
    if (Date.now() >= check.deadline) return;
    try {
      if (mergedIntoMain(e, task, check)) {
        if (hasClaims) tx(e, () => releaseClaims(e, task, ENGINE));
        if (hasTree) removeWorktree(e, task);
      } else if (hasClaims && task.branch && prState(e, check, task.branch) === "CLOSED") {
        tx(e, () => releaseClaims(e, task, ENGINE, "pr closed"));
      }
    } catch (x) {
      if (x instanceof OutOfBudget) return;
      // A timed-out or failed gh/git check is tried again next time; anything else is a bug and surfaces.
      if (!(x instanceof EngineError)) throw x;
    }
  }
}

export interface ClaimStatus {
  path: string;
  holder: { task_id: number; title: string; goal: string; cwd: string } | null;
  diff: string;
  note?: string;
  grants: { task_id: number; reason: string; by: string; at: string }[];
}
export const MAX_CLAIM_DIFF = 8000;

/** Who holds a file, what the holder changed in it (committed or not, from its base), and who has been allowed in. */
export function claimStatus(e: Engine, rawPath: string): ClaimStatus {
  const path = claimPath(e, rawPath);
  const held = holderOf(e, path);
  if (!held) return { path, holder: null, diff: "", grants: [] };
  const { task } = held;
  const grants = e.db.prepare(
    "SELECT task_id, reason, by, at FROM claim_grants WHERE claim_id = ? AND path = ? ORDER BY id",
  ).all(held.claim_id, path) as unknown as ClaimStatus["grants"];
  const out: ClaimStatus = { path, holder: { task_id: task.id, title: task.title, goal: task.goal, cwd: task.cwd }, diff: "", grants };
  if (!existsSync(task.cwd)) return { ...out, note: `the holder's worktree is gone (${task.cwd}), so its changes cannot be shown` };
  const tracked = runBounded(e, task.cwd, "git", ["ls-files", "--error-unmatch", "--", path], HOOK_GIT_TIMEOUT_MS).code === 0;
  // A file the holder created and has not added yet is all new: git diff --no-index exits 1 when it differs.
  const fresh = !tracked && existsSync(join(task.cwd, path));
  const r = fresh
    ? runBounded(e, task.cwd, "git", ["diff", "--no-index", "--no-color", "--", "/dev/null", path], HOOK_GIT_TIMEOUT_MS)
    : runBounded(e, task.cwd, "git", ["diff", "--no-color", task.base_sha, "--", path], HOOK_GIT_TIMEOUT_MS);
  if (r.code !== 0 && !(fresh && r.code === 1)) return { ...out, note: `could not read the holder's changes: ${r.stderr.trim()}` };
  out.diff = r.stdout.length > MAX_CLAIM_DIFF ? `${r.stdout.slice(0, MAX_CLAIM_DIFF)}\n(truncated)` : r.stdout;
  return out;
}

/** The CTO of both the holder and the task (or the owner) lets the task edit a held file. */
export function allowEdit(e: Engine, input: { task_id: number; path: string; reason: string; actor?: Actor; owner: boolean }): void {
  if (!input.owner && input.actor?.agent_id) throw new EngineError("OWNER_ONLY", "a worker cannot allow edits; report to your CTO");
  const reason = input.reason?.trim();
  if (!reason) throw new EngineError("BAD_EVIDENCE", "a reason is required");
  const task = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.task_id) as unknown as Task | undefined;
  if (!task) throw new EngineError("NO_TASK", `no task with id ${input.task_id}`);
  if (task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${task.id} is ${task.status}`);
  const path = claimPath(e, input.path, task);
  input = { ...input, path };
  const held = holderOf(e, path);
  if (!held) throw new EngineError("BAD_EVIDENCE", `${path} is not held by any task`);
  const by = input.owner ? "owner" : actorId(input.actor ?? { session_id: "unknown" });
  if (!input.owner) {
    const s = input.actor?.session_id;
    if (!s || !ownsTask(e, s, task.id) || !ownsTask(e, s, held.task.id)) {
      throw new EngineError("OWNER_ONLY",
        `only the CTO of both task #${task.id} and the holder, task #${held.task.id}, can allow this; the owner runs: estack allow --task ${task.id} --path ${input.path} --reason <text>`);
    }
  }
  tx(e, () => {
    if (e.db.prepare("SELECT 1 FROM claim_grants WHERE claim_id = ? AND task_id = ? AND path = ?").get(held.claim_id, task.id, path)) return;
    e.db.prepare("INSERT INTO claim_grants (claim_id, task_id, path, reason, by, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(held.claim_id, task.id, input.path, reason, by, iso(e));
    logEvent(e, input.actor ?? { session_id: "owner" }, "claim_granted", task.id, { path: input.path, holder: held.task.id, by });
  });
}

/** Owner only (the caller checks): free a held file, for a hold nobody is working on any more. */
export function releaseClaim(e: Engine, rawPath: string, reason: string): void {
  if (!reason || !reason.trim()) throw new EngineError("BAD_EVIDENCE", "a reason is required");
  const path = claimPath(e, rawPath);
  tx(e, () => {
    const held = holderOf(e, path);
    if (!held) throw new EngineError("BAD_EVIDENCE", `${path} is not held by any task`);
    releaseOne(e, { id: held.claim_id, kind: "file", target: path }, held.task.id, { session_id: "owner" }, reason);
  });
}

/** Owner only (the caller checks): free every claim of a task nobody will finish, each through the same release as above. Returns how many. */
export function releaseTaskClaims(e: Engine, task_id: number, reason: string): number {
  if (!reason || !reason.trim()) throw new EngineError("BAD_EVIDENCE", "a reason is required");
  return tx(e, () => {
    const task = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as unknown as Task | undefined;
    if (!task) throw new EngineError("NO_TASK", `no task with id ${task_id}`);
    const { n } = e.db.prepare("SELECT COUNT(*) n FROM claims WHERE task_id = ? AND status = 'active'").get(task_id) as { n: number };
    if (n === 0) throw new EngineError("BAD_EVIDENCE", `task #${task_id} holds nothing`);
    releaseClaims(e, task, { session_id: "owner" }, reason);
    return n;
  });
}

/** A path as claims hold it: relative to the checkout, "/" separators. An absolute path is read against the task's worktree (or the one that contains it). */
function claimPath(e: Engine, path: string, task?: Task): string {
  let base = task?.cwd ?? e.repo.root;
  if (isAbsolute(path)) {
    const cwds = (e.db.prepare("SELECT cwd FROM tasks WHERE cwd != ''").all() as { cwd: string }[]).map((r) => r.cwd)
      .filter((c) => path === c || path.startsWith(c + "/")).sort((x, y) => y.length - x.length);
    if (cwds.length > 0) base = cwds[0];
  }
  return areaPath(base, path);
}

/** Claim the name of a shared helper a task is about to write, unless it already exists or another task claimed it. */
export function claimSymbol(e: Engine, input: { task_id: number; name: string; file: string; actor: Actor }):
  { status: "claimed" } | { status: "exists"; file: string; line: number } | { status: "claimed_by"; task_id: number } {
  const task = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.task_id) as unknown as Task | undefined;
  if (!task) throw new EngineError("NO_TASK", `no task with id ${input.task_id}`);
  if (task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${task.id} is ${task.status}`);
  if (!input.name.trim()) throw new EngineError("BAD_EVIDENCE", "a name is required");
  const want = normaliseName(input.name);
  const parent = task.parent_id === null ? undefined
    : e.db.prepare("SELECT cwd FROM tasks WHERE id = ?").get(task.parent_id) as { cwd: string } | undefined;
  const g = loadGraph(task.cwd) ?? (parent ? loadGraph(parent.cwd) : null);
  const hit = g ? topLevelFunctions(g).find((n) => normaliseName(n.name) === want) : undefined;
  if (hit) return { status: "exists", file: hit.file, line: hit.line };
  // Read and insert in one transaction, so two tasks claiming the same name cannot both win.
  return tx(e, () => {
    const rows = e.db.prepare("SELECT task_id, target FROM claims WHERE kind = 'new_symbol' AND status = 'active'")
      .all() as { task_id: number; target: string }[];
    const mine = rows.find((r) => normaliseName(r.target) === want);
    if (mine) return mine.task_id === task.id ? { status: "claimed" as const } : { status: "claimed_by" as const, task_id: mine.task_id };
    const r = e.db.prepare("INSERT INTO claims (task_id, kind, target, status, at) VALUES (?, 'new_symbol', ?, 'active', ?)")
      .run(task.id, input.name, iso(e));
    logEvent(e, input.actor, "symbol_claimed", task.id, { name: input.name, file: input.file, claim_id: Number(r.lastInsertRowid) });
    return { status: "claimed" as const };
  });
}

export interface ActiveClaim { kind: string; target: string; task_id: number; title: string }
export interface KeptWorktree { task_id: number; title: string; path: string; reason: string }

/** Every active claim, files then helper names, with the holding task. */
export function activeClaims(e: Engine): ActiveClaim[] {
  return e.db.prepare(
    `SELECT c.kind, c.target, c.task_id, t.title FROM claims c JOIN tasks t ON t.id = c.task_id
     WHERE c.status = 'active' ORDER BY c.kind, c.target`,
  ).all() as unknown as ActiveClaim[];
}

/**
 * Engine worktrees (under a `.estack/worktrees/` folder) that git lists and no task accounts for: not the cwd of a
 * planned, starting, open or done task, not being made by a start in progress, and not already listed as kept. A failed
 * start or a crash leaves these. Listed only; never removed.
 */
export function strayWorktrees(e: Engine): string[] {
  const list = e.exec.run("git", ["worktree", "list", "--porcelain"], { cwd: e.repo.root, timeoutMs: HOOK_GIT_TIMEOUT_MS });
  if (list.code !== 0) return [];
  const known = new Set((e.db.prepare("SELECT cwd FROM tasks WHERE status IN ('planned','starting','open','done') AND cwd != ''").all() as
    { cwd: string }[]).map((r) => r.cwd));
  // A start in progress has not recorded its cwd yet; its folder is named <id>-<slug>.
  const starting = (e.db.prepare("SELECT id FROM tasks WHERE status = 'starting'").all() as { id: number }[]).map((r) => `${r.id}-`);
  const kept = new Set(keptWorktrees(e).map((k) => k.path));
  return list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length))
    .filter((p) => p.includes(`/${WORKTREES_DIR}/`) && !known.has(p) && !kept.has(p) && !starting.some((s) => basename(p).startsWith(s)));
}

/** Worktrees the engine tried to remove and kept (still on disk), with the latest reason. */
export function keptWorktrees(e: Engine): KeptWorktree[] {
  const rows = e.db.prepare(
    `SELECT t.id AS task_id, t.title, t.cwd AS path,
       (SELECT payload_json FROM events v WHERE v.kind = 'worktree_kept' AND v.task_id = t.id ORDER BY v.id DESC LIMIT 1) AS p
     FROM tasks t WHERE t.id IN (SELECT task_id FROM events WHERE kind = 'worktree_kept') ORDER BY t.id`,
  ).all() as unknown as { task_id: number; title: string; path: string; p: string }[];
  return rows.map((r) => {
    const kept = JSON.parse(r.p) as { path?: unknown; reason?: unknown };
    return { task_id: r.task_id, title: r.title, path: typeof kept.path === "string" ? kept.path : r.path, reason: String(kept.reason ?? "") };
  }).filter((k) => existsSync(k.path));
}
