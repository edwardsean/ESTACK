import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkEdit, heldMessage } from "./claims";
import { contextRatio } from "./context";
import { checkoutOf } from "./graph";
import type { Engine } from "./engine";
import {
  activityAfter, buildTaskBody, latestSessionHandover, pendingHandovers, saveSessionHandover, sessionTasks,
  type Handover, type SessionHandoverBody, type TaskHandoverBody,
} from "./handover";
import { openEngine } from "./engine";
import type { Exec } from "./exec";
import { READ_TOOLS, preRead } from "./mapfirst";
import { classifyCommand, isExempt, isProtected } from "./match";
import { HOOK_GIT_TIMEOUT_MS, bindWorker, listOpen, pushReadiness, runBounded, logEvent, tx, type TaskView } from "./tasks";
import { EngineError, type Actor, type Task } from "./types";

export interface HookEvent {
  hook_event_name: string; session_id: string; cwd: string; agent_id?: string; agent_type?: string;
  tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string;
  stop_hook_active?: boolean; prompt?: string; source?: string; transcript_path?: string; trigger?: string;
}
export type HookOutput = Record<string, unknown> | null;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MCP_PREFIX = "mcp__plugin_estack_estack__";
const OVERRIDE_WINDOW_MS = 30 * 60 * 1000;

function pre(decision: "allow" | "ask" | "deny", reason: string, updatedInput?: Record<string, unknown>): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason,
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}
export const deny = (reason: string) => pre("deny", reason);

export const actorOf = (ev: HookEvent): Actor => ({ session_id: ev.session_id, ...(ev.agent_id ? { agent_id: ev.agent_id } : {}) });

const OVERRIDE_SQL = `SELECT id FROM approvals WHERE decision = 'override' AND action = ? AND at >= ?
  AND id NOT IN (SELECT json_extract(payload_json, '$.approval_id') FROM events
                 WHERE kind = 'override_used' AND json_extract(payload_json, '$.approval_id') IS NOT NULL)
  ORDER BY id DESC LIMIT 1`;

/** The newest unused owner override for `action` from the last 30 minutes, without using it up. */
export function findOverride(e: Engine, action: string): number | null {
  const cutoff = new Date(e.now().getTime() - OVERRIDE_WINDOW_MS).toISOString();
  const row = e.db.prepare(OVERRIDE_SQL).get(action, cutoff) as { id: number } | undefined;
  return row ? row.id : null;
}

/**
 * Use up the newest owner override for `action` from the last 30 minutes that no override_used event
 * references. Logs override_used {approval_id, ref} and returns the approval id, or null.
 */
export function consumeOverride(e: Engine, action: string, ref: string): number | null {
  return tx(e, () => {
    const id = findOverride(e, action);
    if (id === null) return null;
    logEvent(e, { session_id: "hook" }, "override_used", null, { approval_id: id, ref });
    return id;
  });
}

/** Resolve a path against cwd, following symlinks through the nearest existing parent. */
export function resolveReal(cwd: string, p: string): string {
  const abs = resolve(cwd, p);
  let d = abs;
  const rest: string[] = [];
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) return abs;
    rest.unshift(d.slice(up.length + 1));
    d = up;
  }
  return join(realpathSync(d), ...rest);
}

export function nearestDir(p: string): string {
  let d = dirname(p);
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

function preEdit(e: Engine, ev: HookEvent): HookOutput {
  const input = ev.tool_input ?? {};
  const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (!raw) return null;
  const abs = resolveReal(ev.cwd, raw);
  const dir = nearestDir(abs);
  const common = runBounded(e, dir, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], HOOK_GIT_TIMEOUT_MS);
  if (common.code !== 0) {
    if (common.code === 128 && /not a git repository/i.test(common.stderr)) return null;
    throw new EngineError("NOT_A_REPO", `git failed while checking ${raw}: ${common.stderr.trim() || `exit ${common.code}`}`);
  }
  const commonDir = common.stdout.trim();
  let commonReal: string;
  try { commonReal = realpathSync(commonDir); } catch { return null; }
  if (realpathSync(dirname(commonReal)) !== e.repo.root) return null;
  const top = runBounded(e, dir, "git", ["rev-parse", "--show-toplevel"], HOOK_GIT_TIMEOUT_MS);
  if (top.code !== 0) {
    // Inside a git directory (.git, .git/hooks, .git/worktrees/<n>/...): hooks and config live here.
    if (top.code === 128 && /work ?tree/i.test(top.stderr)) {
      const inGit = abs === commonReal || abs.startsWith(commonReal + sep);
      return inGit ? deny(`${relative(e.repo.root, abs).split(sep).join("/")} is protected (git directory)`) : null;
    }
    throw new EngineError("NOT_A_REPO", `git failed while checking ${raw}: ${top.stderr.trim() || `exit ${top.code}`}`);
  }
  const worktree = top.stdout.trim();
  const rel = relative(worktree, abs).split(sep).join("/");
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (rel === ".git" || rel.startsWith(".git/")) return deny(`${rel} is protected (git directory)`);
  if (isProtected(rel, e.policy)) return deny(`${rel} is protected by .estack/policy.yaml`);
  if (isExempt(rel, e.policy)) return null;
  const bound = e.db.prepare(
    `SELECT t.id FROM tasks t JOIN task_bindings b ON b.task_id = t.id
     WHERE t.status = 'open' AND t.cwd = ? AND b.session_id = ? LIMIT 1`,
  ).get(worktree, ev.session_id);
  if (bound) {
    bindWorker(e, Number(bound.id), actorOf(ev));
    const task = e.db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(bound.id)) as unknown as Task;
    const verdict = checkEdit(e, task, rel, actorOf(ev));
    return verdict.ok ? null : deny(heldMessage(rel, verdict.holder));
  }
  return deny(`No open estack task for this session in ${worktree}. Start one with the start_task tool (title, type, goal, done_check) before editing ${rel}.`);
}

function recordAsk(e: Engine, ev: HookEvent, taskId: number | null, action: string, command: string): void {
  logEvent(e, actorOf(ev), "ask", taskId, { tool_use_id: ev.tool_use_id ?? null, action, command });
}

/**
 * The branch a `git push` or `gh pr create` command is for: the ref `git push` names or the `--head`/`-H` `gh pr create`
 * names, else the current branch of the checkout it runs in. A leading `cd <dir>` moves that checkout for the later
 * segments, as `git -C <dir>` does for its own. `pr` says which command it was.
 */
function pushedBranch(e: Engine, cwd: string, command: string): { branch: string; pr: boolean } {
  const current = (dir: string) =>
    runBounded(e, dir, "git", ["branch", "--show-current"], HOOK_GIT_TIMEOUT_MS).stdout.trim();
  let here = cwd;
  let previous = cwd;   // what `cd -` returns to: the directory before the last cd, the event's cwd when there was none
  for (const segment of command.split(/[;&|\n]+/)) {
    const words = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
    if (words[0] === "cd" && words[1] !== undefined) {
      const next = words[1] === "-" ? previous : resolve(here, words[1]);
      previous = here;
      here = next;
      continue;
    }
    const gh = words.findIndex((w) => /(^|\/)gh$/.test(w));
    const pr = words.indexOf("pr", gh);
    if (gh >= 0 && pr > gh && words[pr + 1] === "create") {
      const args = words.slice(pr + 2);
      for (const [i, w] of args.entries()) {
        const head = w === "--head" || w === "-H" ? args[i + 1] : /^--head=(.+)$/.exec(w)?.[1] ?? /^-H(.+)$/.exec(w)?.[1];
        // A fork head is owner:branch; the branch is the part after the colon.
        if (head) return { branch: head.split(":").at(-1)!, pr: true };
      }
      return { branch: current(here), pr: true };
    }
    const git = words.findIndex((w) => /(^|\/)git$/.test(w));
    const at = words.indexOf("push");
    if (git < 0 || at < git) continue;
    const c = words.indexOf("-C");
    const dir = c >= 0 && c < at && words[c + 1] ? resolve(here, words[c + 1]) : here;
    const args: string[] = [];
    let skip = false;
    for (const w of words.slice(at + 1)) {
      if (skip) { skip = false; continue; }
      if (/^\d*[<>]+$/.test(w)) { skip = true; continue; }   // a bare redirection operator takes the next word
      if (/^\d*[<>]/.test(w) || w.startsWith("-")) continue;
      args.push(w);
    }
    const ref = args[1];
    if (ref !== undefined && ref !== "HEAD") {
      // pre-push checks the local branch being pushed, so the source side of `src:dst`; an empty source (a delete) names none.
      const src = ref.replace(/^\+/, "").split(":")[0].replace(/^refs\/heads\//, "");
      if (src !== "" && src !== "HEAD") return { branch: src, pr: false };
    }
    return { branch: current(dir), pr: false };
  }
  return { branch: current(here), pr: false };
}

function preBash(e: Engine, ev: HookEvent): HookOutput {
  const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : "";
  const v = classifyCommand(command, e.policy);
  if (v.kind === "none") return null;
  if (v.kind === "deny") {
    return deny(`${v.action}: blocked by ${v.hardcoded ? "estack" : ".estack/policy.yaml"} (pattern ${v.pattern})`);
  }
  if (ev.agent_id) return deny(`${v.action} runs only from the main session, with the owner's approval; report back to the orchestrator instead`);
  if (v.action !== "git_push") {
    recordAsk(e, ev, null, v.action, command);
    return pre("ask", `${v.action} needs the owner's approval (pattern ${v.pattern})`);
  }
  const { branch, pr } = pushedBranch(e, ev.cwd, command);
  const { task: t, verifySettled } = pushReadiness(e, branch);
  const where = pr
    ? "open the feature PR from its worktree (cd <feature cwd> && gh pr create) or pass --head <feature branch>"
    : "push the feature branch from its worktree (git -C <feature cwd> push) or name it (git push origin <feature branch>)";
  const refusal = !t
    ? `no estack task for branch ${branch}; ${where}; or the owner can run \`estack override git_push --reason …\` in a terminal`
    : !verifySettled
      ? `task #${t.id} has no verify evidence; run run_check with step verify first`
      : null;
  if (refusal !== null) {
    // Only peek: the git pre-push hook uses the override up, so a declined ask does not spend it.
    const found = findOverride(e, "git_push");
    if (found === null) return deny(refusal);
    recordAsk(e, ev, t?.id ?? null, v.action, command);
    return pre("ask", `${v.action} (pattern ${v.pattern}) allowed once by an owner override (approval #${found}); the owner must confirm`);
  }
  recordAsk(e, ev, t!.id, v.action, command);
  return pre("ask", `${v.action} (pattern ${v.pattern}) for task #${t!.id} "${t!.title}": verify is settled, the owner must confirm`);
}

const STAMP_CWD = new Set(["start_task", "context_for", "find_existing", "who_uses", "handover", "resume"]);

export function preToolUse(e: Engine, ev: HookEvent): HookOutput {
  const tool = ev.tool_name ?? "";
  if (EDIT_TOOLS.has(tool)) return preEdit(e, ev);
  if (tool === "Bash") return preBash(e, ev);
  if (READ_TOOLS.has(tool)) return preRead(e, ev);
  if (tool.startsWith(MCP_PREFIX)) {
    // start_task records the caller's worktree, so stamp the real cwd too (the MCP server's own cwd may differ).
    const cwd = STAMP_CWD.has(tool.slice(MCP_PREFIX.length)) ? { cwd: ev.cwd } : {};
    return pre("allow", "estack tool call", { ...(ev.tool_input ?? {}), ...cwd, actor: actorOf(ev) });
  }
  return null;
}

export function postToolUse(e: Engine, ev: HookEvent): HookOutput {
  if (ev.tool_name !== "Bash" || !ev.tool_use_id) return null;
  const row = e.db.prepare(
    "SELECT task_id, payload_json FROM events WHERE kind = 'ask' AND json_extract(payload_json, '$.tool_use_id') = ? ORDER BY id DESC LIMIT 1",
  ).get(ev.tool_use_id) as { task_id: number | null; payload_json: string } | undefined;
  if (!row) return null;
  const p = JSON.parse(row.payload_json) as { action: string; command: string };
  const actor = actorOf(ev);
  const by = `${actor.session_id}/${actor.agent_id ?? "main"}`;
  tx(e, () => {
    e.db.prepare("INSERT INTO approvals (task_id, action, command, decision, by, at) VALUES (?, ?, ?, 'approved', ?, ?)")
      .run(row.task_id, p.action, p.command, by, e.now().toISOString());
    logEvent(e, actor, "approved", row.task_id, { tool_use_id: ev.tool_use_id, action: p.action });
  });
  return null;
}

const MAX_CONTEXT_TASKS = 20;

function ctxOut(eventName: string, additionalContext: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext } };
}

const MAX_LISTED_HANDOVERS = 10;
/** A handover's session that logged anything within this long may still be running. */
const LIVE_SESSION_MS = 10 * 60 * 1000;
/** A PreCompact handover younger than this was written for the compaction now being restored. */
const FRESH_COMPACT_MS = 10 * 60 * 1000;

function compactState(b: { goal?: string; plan?: string[]; decisions: { what: string; why: string }[]; open_questions: string[]; files?: string[] },
  tasks: TaskHandoverBody[]): string[] {
  const out: string[] = [];
  if (b.goal) out.push(`goal: ${b.goal}`);
  if (b.plan?.length) out.push(`plan: ${b.plan.join("; ")}`);
  for (const t of tasks) out.push(`#${t.task.id} next: ${t.next_step ?? "none"}`);
  if (b.decisions.length) out.push(`decisions: ${b.decisions.map((d) => `${d.what} (${d.why})`).join("; ")}`);
  if (b.open_questions.length) out.push(`open questions: ${b.open_questions.join("; ")}`);
  const files = [...new Set([...(b.files ?? []), ...tasks.flatMap((t) => t.files)])];
  if (files.length) out.push(`files: ${files.join(", ")}`);
  return out;
}

/** Elapsed time as "45s", "12m", "3h" or "2d". */
function dur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const since = (e: Engine, at: string) => dur(e.now().getTime() - Date.parse(at));

const handoverKind = (h: Handover) => h.kind === "session" ? "session" : `task #${h.task_id}`;
const handoverGoal = (h: Handover) =>
  (h.body.kind === "session" ? (h.body as SessionHandoverBody).goal : (h.body as TaskHandoverBody).task.title).slice(0, 60) || "(none)";

/** When the handover's session was active after saving it, and recently enough that it may still be running. */
function stillRunning(e: Engine, h: Handover): string | null {
  const at = activityAfter(e, h);
  return at !== null && e.now().getTime() - Date.parse(at) < LIVE_SESSION_MS ? at : null;
}

function listLine(e: Engine, h: Handover): string {
  const active = stillRunning(e, h);
  return `#${h.id} ${handoverKind(h)} from ${h.from_session.slice(0, 8)} ${since(e, h.created_at)} ago goal: ${handoverGoal(h)}${
    active ? ` (that session was active ${since(e, active)} ago; it may still be running)` : ""}`;
}

function handoverLines(e: Engine, ev: HookEvent): string[] {
  try {
    if (ev.source === "compact") {
      const h = latestSessionHandover(e, ev.session_id);
      const reread = "Re-read the listed files before changing anything.";
      if (h && h.auto && e.now().getTime() - Date.parse(h.created_at) < FRESH_COMPACT_MS) {
        const b = h.body as SessionHandoverBody;
        return [...compactState(b, b.tasks), `estack: context was compacted; this is the recorded state of your work. ${reread}`];
      }
      // No handover from this compaction: show the session's tasks as they are now, without a stale goal or plan.
      const actor: Actor = { session_id: ev.session_id };
      const tasks = sessionTasks(e, ev.session_id).map((v) => buildTaskBody(e, v, {}, actor, true));
      if (tasks.length === 0) return [];
      return [...compactState({ decisions: [], open_questions: [] }, tasks),
        `estack: context was compacted; these are your open tasks as they are now. ${reread}`];
    }
    const pending = pendingHandovers(e, checkoutOf(e, ev.cwd));
    const n = pendingHandovers(e).length - pending.length;
    const elsewhere = n > 0
      ? [`estack: ${n} handover${n === 1 ? " is" : "s are"} waiting in ${n === 1 ? "another worktree" : "other worktrees"} of this repository; this session is not told to take ${
        n === 1 ? "it" : "them"}. "estack handovers" lists them; resume one by handover_id only if the owner asks.`]
      : [];
    if (pending.length === 1 && stillRunning(e, pending[0]) === null) {
      const h = pending[0];
      return [...elsewhere, `estack: a handover is waiting (#${h.id}, ${handoverKind(h)}, ${since(e, h.created_at)} ago, goal: ${handoverGoal(h)}). Call the resume tool now${
        h.kind === "task" ? ` with task_id ${h.task_id}` : ""}, then re-read the files it lists and continue.`];
    }
    if (pending.length > 0) {
      const extra = pending.length - MAX_LISTED_HANDOVERS;
      return [...elsewhere, ...pending.slice(0, MAX_LISTED_HANDOVERS).map((h) => listLine(e, h)), ...(extra > 0 ? [`+${extra} more`] : []),
        pending.length === 1
          ? "estack: a handover is waiting but its session may still be running; ask the owner whether to resume it, then call the resume tool with handover_id."
          : "estack: several handovers are waiting; ask the owner which one, then call the resume tool with handover_id."];
    }
    return elsewhere;
  } catch { /* context hooks fail open */ }
  return [];
}

export function sessionStart(e: Engine, ev: HookEvent): HookOutput {
  const head = "estack: this repository is opted in; code edits need an open task (start_task), pushes need verify evidence.";
  const open = listOpen(e).slice(0, MAX_CONTEXT_TASKS);
  const lines = open.length
    ? open.map((v) => `#${v.task.id} [${v.task.type}] ${v.task.title} (${v.task.branch}) next: ${v.next?.name ?? "none"}`)
    : ["no open tasks"];
  return ctxOut("SessionStart", [head, ...lines, ...handoverLines(e, ev)].join("\n"));
}

/** Save an auto session handover before compaction, if the session has open tasks. Never blocks. */
export function preCompact(e: Engine, ev: HookEvent): HookOutput {
  try {
    // Workers do not write session handovers; only the main session's compaction does.
    if (!ev.agent_id && sessionTasks(e, ev.session_id).length > 0) saveSessionHandover(e, {}, { session_id: ev.session_id }, true, ev.cwd);
  } catch { /* fail open */ }
  return null;
}

/** Open tasks bound to this session (and, when `agentOnly`, to this agent). */
function boundTasks(e: Engine, ev: HookEvent, agentOnly: boolean): TaskView[] {
  const ids = new Set((e.db.prepare("SELECT task_id, agent_id FROM task_bindings WHERE session_id = ?").all(ev.session_id) as
    { task_id: number; agent_id: string | null }[])
    .filter((b) => !agentOnly || b.agent_id === (ev.agent_id ?? null)).map((b) => b.task_id));
  return listOpen(e).filter((v) => ids.has(v.task.id));
}

export function userPromptSubmit(e: Engine, ev: HookEvent): HookOutput {
  const v = boundTasks(e, ev, false).find((t) => t.next);
  if (!v) return null;
  const lines = [`estack: task #${v.task.id} next step: ${v.next!.name}`];
  try {
    const { threshold, window_tokens } = e.policy.handover;
    // Cheap check first: once this session was nudged on this step, the transcript need not be read.
    const seen = e.db.prepare(
      `SELECT 1 FROM events WHERE kind = 'handover_suggested' AND json_extract(payload_json, '$.session_id') = ?
       AND json_extract(payload_json, '$.task_id') = ? AND json_extract(payload_json, '$.step') = ? LIMIT 1`,
    ).get(ev.session_id, v.task.id, v.next!.name);
    const ratio = seen ? null : contextRatio(ev.transcript_path, window_tokens);
    if (ratio !== null && ratio >= threshold) {
      logEvent(e, actorOf(ev), "handover_suggested", v.task.id, { session_id: ev.session_id, task_id: v.task.id, step: v.next!.name, ratio });
      lines.push(`estack: context is ${Math.round(ratio * 100)}% full. Finish the current step and collect any running workers, then call the handover tool and tell the owner to run /clear; the new session picks up automatically. Use /compact instead only if the conversation itself must be kept.`);
    }
  } catch { /* fail open */ }
  return ctxOut("UserPromptSubmit", lines.join("\n"));
}

export function stop(e: Engine, ev: HookEvent): HookOutput {
  if (ev.stop_hook_active) return null;
  const sub = ev.hook_event_name === "SubagentStop";
  const reasons: string[] = [];
  // The main session's stop skips tasks a worker agent is bound to: they run in the background and SubagentStop checks them.
  const worked = sub ? new Set<number>() : new Set((e.db.prepare("SELECT DISTINCT task_id FROM task_bindings WHERE agent_id IS NOT NULL").all() as
    { task_id: number }[]).map((r) => r.task_id));
  for (const v of boundTasks(e, ev, sub).filter((t) => !worked.has(t.task.id))) {
    const t = v.task;
    const work = v.steps.find((s) => s.name === "implement" || s.name === "fix");
    if (!work) continue;
    const settled = (n: string) => ["done", "skipped"].includes(v.steps.find((s) => s.name === n)?.status ?? "");
    if (!settled(work.name)) {
      let n = 0;
      try {
        const r = runBounded(e, t.cwd, "git", ["rev-list", "--count", `${t.base_sha}..refs/heads/${t.branch}`], HOOK_GIT_TIMEOUT_MS);
        if (r.code === 0) n = Number(r.stdout.trim()) || 0;
      } catch { continue; } // timeout: fail open for this task
      if (n > 0) {
        reasons.push(`task #${t.id} has ${n} new commit(s) on ${t.branch} but its ${work.name} step has no evidence; record it with complete_step (kind commit) or say why not.`);
      }
    } else if (sub && v.steps.some((s) => s.name === "test") && !settled("test")) {
      reasons.push(`task #${t.id}: run run_check with step test before finishing.`);
    }
  }
  return reasons.length ? { decision: "block", reason: reasons.join("\n") } : null;
}

export function runHook(name: string, ev: HookEvent, deps: { exec?: Exec; now?: () => Date } = {}): HookOutput {
  // Read and Grep fail open; every other PreToolUse path fails closed.
  const gate = name === "pre-tool-use" && !READ_TOOLS.has(ev.tool_name ?? "");
  let e: Engine | undefined;
  try {
    try {
      e = openEngine(ev.cwd, deps);
    } catch (x) {
      if (x instanceof EngineError && (x.code === "NOT_OPTED_IN" || x.code === "NOT_A_REPO")) return null;
      throw x;
    }
    switch (name) {
      case "pre-tool-use": return preToolUse(e, ev);
      case "post-tool-use": return postToolUse(e, ev);
      case "session-start": return sessionStart(e, ev);
      case "pre-compact": return preCompact(e, ev);
      case "user-prompt-submit": return userPromptSubmit(e, ev);
      case "stop": return stop(e, { ...ev, hook_event_name: "Stop" });
      case "subagent-stop": return stop(e, { ...ev, hook_event_name: "SubagentStop" });
      default: return null;
    }
  } catch (x) {
    if (!gate) return null;
    const msg = (x instanceof Error ? x.message : String(x)).replace(/\s*\n\s*/g, " ");
    return deny(`estack: ${msg}`);
  } finally {
    try { e?.db.close(); } catch { /* ignore */ }
  }
}
