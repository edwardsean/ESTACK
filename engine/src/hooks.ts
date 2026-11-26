import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Engine } from "./engine";
import { openEngine } from "./engine";
import type { Exec } from "./exec";
import { classifyCommand, isExempt, isProtected } from "./match";
import { listOpen, runBounded, logEvent, tx, type TaskView } from "./tasks";
import { EngineError, type Actor, type Task } from "./types";

export interface HookEvent {
  hook_event_name: string; session_id: string; cwd: string; agent_id?: string; agent_type?: string;
  tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string;
  stop_hook_active?: boolean; prompt?: string; source?: string;
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
const deny = (reason: string) => pre("deny", reason);

const actorOf = (ev: HookEvent): Actor => ({ session_id: ev.session_id, ...(ev.agent_id ? { agent_id: ev.agent_id } : {}) });

/**
 * Use up the newest owner override for `action` from the last 30 minutes that no override_used event
 * references. Logs override_used {approval_id, ref} and returns the approval id, or null.
 */
export function consumeOverride(e: Engine, action: string, ref: string): number | null {
  const cutoff = new Date(e.now().getTime() - OVERRIDE_WINDOW_MS).toISOString();
  return tx(e, () => {
    const row = e.db.prepare(
      `SELECT id FROM approvals WHERE decision = 'override' AND action = ? AND at >= ?
       AND id NOT IN (SELECT json_extract(payload_json, '$.approval_id') FROM events
                      WHERE kind = 'override_used' AND json_extract(payload_json, '$.approval_id') IS NOT NULL)
       ORDER BY id DESC LIMIT 1`,
    ).get(action, cutoff) as { id: number } | undefined;
    if (!row) return null;
    logEvent(e, { session_id: "hook" }, "override_used", null, { approval_id: row.id, ref });
    return row.id;
  });
}

/** Resolve a path against cwd, following symlinks through the nearest existing parent. */
function resolveReal(cwd: string, p: string): string {
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

function nearestDir(p: string): string {
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
  const common = runBounded(e, dir, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) {
    if (common.code === 128 && /not a git repository/i.test(common.stderr)) return null;
    throw new EngineError("NOT_A_REPO", `git failed while checking ${raw}: ${common.stderr.trim() || `exit ${common.code}`}`);
  }
  const commonDir = common.stdout.trim();
  let commonReal: string;
  try { commonReal = realpathSync(commonDir); } catch { return null; }
  if (realpathSync(dirname(commonReal)) !== e.repo.root) return null;
  const top = runBounded(e, dir, "git", ["rev-parse", "--show-toplevel"]);
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
  if (bound) return null;
  return deny(`No open estack task for this session in ${worktree}. Start one with the start_task tool (title, type, goal, done_check) before editing ${rel}.`);
}

function recordAsk(e: Engine, ev: HookEvent, taskId: number | null, action: string, command: string): void {
  logEvent(e, actorOf(ev), "ask", taskId, { tool_use_id: ev.tool_use_id ?? null, action, command });
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
  const branch = runBounded(e, ev.cwd, "git", ["branch", "--show-current"]).stdout.trim();
  const t = e.db.prepare("SELECT * FROM tasks WHERE branch = ? AND status IN ('open','done') ORDER BY id DESC LIMIT 1")
    .get(branch) as unknown as Task | undefined;
  const verify = t
    ? (e.db.prepare("SELECT status FROM steps WHERE task_id = ? AND name = 'verify'").get(t.id) as { status: string } | undefined)
    : undefined;
  const refusal = !t
    ? `no estack task for branch ${branch}; start one, or the owner can run \`estack override git_push --reason …\` in a terminal`
    : verify?.status !== "done"
      ? `task #${t.id} has no verify evidence; run run_check with step verify first`
      : null;
  if (refusal !== null) {
    const used = consumeOverride(e, "git_push", ev.tool_use_id ?? "");
    if (used === null) return deny(refusal);
    recordAsk(e, ev, t?.id ?? null, v.action, command);
    return pre("ask", `${v.action} (pattern ${v.pattern}) allowed once by an owner override (approval #${used}); the owner must confirm`);
  }
  recordAsk(e, ev, t!.id, v.action, command);
  return pre("ask", `${v.action} (pattern ${v.pattern}) for task #${t!.id} "${t!.title}": verify is done, the owner must confirm`);
}

export function preToolUse(e: Engine, ev: HookEvent): HookOutput {
  const tool = ev.tool_name ?? "";
  if (EDIT_TOOLS.has(tool)) return preEdit(e, ev);
  if (tool === "Bash") return preBash(e, ev);
  if (tool.startsWith(MCP_PREFIX)) {
    return pre("allow", "estack tool call", { ...(ev.tool_input ?? {}), actor: actorOf(ev) });
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

export function sessionStart(e: Engine, _ev: HookEvent): HookOutput {
  const head = "estack: this repository is opted in; code edits need an open task (start_task), pushes need verify evidence.";
  const open = listOpen(e).slice(0, MAX_CONTEXT_TASKS);
  const lines = open.length
    ? open.map((v) => `#${v.task.id} [${v.task.type}] ${v.task.title} (${v.task.branch}) next: ${v.next?.name ?? "none"}`)
    : ["no open tasks"];
  return ctxOut("SessionStart", [head, ...lines].join("\n"));
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
  return v ? ctxOut("UserPromptSubmit", `estack: task #${v.task.id} next step: ${v.next!.name}`) : null;
}

export function stop(e: Engine, ev: HookEvent): HookOutput {
  if (ev.stop_hook_active) return null;
  const sub = ev.hook_event_name === "SubagentStop";
  const reasons: string[] = [];
  for (const v of boundTasks(e, ev, sub)) {
    const t = v.task;
    const work = v.steps.find((s) => s.name === "implement" || s.name === "fix");
    if (!work) continue;
    const settled = (n: string) => ["done", "skipped"].includes(v.steps.find((s) => s.name === n)?.status ?? "");
    if (!settled(work.name)) {
      let n = 0;
      try {
        const r = runBounded(e, t.cwd, "git", ["rev-list", "--count", `${t.base_sha}..refs/heads/${t.branch}`]);
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
  const gate = name === "pre-tool-use";
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
