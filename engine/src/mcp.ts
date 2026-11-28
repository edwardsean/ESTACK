import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recordOutcomes } from "./outcomes";
import { activeClaims, allowEdit, claimStatus, claimSymbol, keptWorktrees, strayWorktrees, syncMerged } from "./claims";
import { runCheck } from "./checks";
import { openEngine, type Engine } from "./engine";
import type { Exec } from "./exec";
import { consumeHandover, saveSessionHandover, saveTaskHandover, type SessionHandoverBody } from "./handover";
import { dismissDuplicate } from "./duplicates";
import { runCodeQuery, taskContext, type CodeTool } from "./codemap";
import { bindWorker, completeStep, ownsTask, getTask, listOpen, startTask } from "./tasks";
import { acceptOverlap, planTasks, withdrawTask, type PlanTaskInput } from "./plan";
import { EngineError, actorId, type Actor } from "./types";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const actorSchema = z.object({ session_id: z.string(), agent_id: z.string().optional() }).optional()
  .describe("who is calling; defaults to {session_id: \"unknown\"}");
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), text: z.string() }),
  z.object({ kind: z.literal("commit"), sha: z.string() }),
  z.object({ kind: z.literal("pr"), url: z.string() }),
  z.object({ kind: z.literal("review"), verdict: z.enum(["approve", "changes"]), findings: z.string() }),
  z.object({ kind: z.literal("merged") }),
]);

const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export function createServer(cwd: string, deps: { exec?: Exec; now?: () => Date } = {}): McpServer {
  const server = new McpServer({ name: "estack", version: "0.1.0" });

  /** Open the engine for one call, run fn, always close the database, and turn every failure into an isError result. */
  function tool<A extends { actor?: Actor }>(fn: (e: Engine, args: A, actor: Actor) => unknown) {
    return (args: A): Result => {
      let e: Engine | undefined;
      try {
        e = openEngine(cwd, deps);
        const actor = args.actor ?? { session_id: "unknown" };
        const out = fn(e, args, actor);
        // An agent is on a worker task from its first successful task tool call, if its session is already on that task.
        const task_id = (args as { task_id?: unknown }).task_id;
        if (typeof task_id === "number" && actor.agent_id) {
          const related = e.db.prepare("SELECT 1 FROM task_bindings WHERE task_id = ? AND session_id = ?").get(task_id, actor.session_id)
            || ownsTask(e, actor.session_id, task_id);
          if (related) bindWorker(e, task_id, actor);
        }
        return text(JSON.stringify(out, null, 2));
      } catch (x) {
        if (x instanceof EngineError) return text(`${x.code}: ${x.message}`, true);
        return text(`internal error: ${x instanceof Error ? x.message : String(x)}`, true);
      } finally {
        try { e?.db.close(); } catch { /* nothing useful to do */ }
      }
    };
  }

  server.registerTool("start_task", {
    description: "Start a task of a policy-defined type; its steps are created in order.",
    inputSchema: {
      title: z.string().optional(), type: z.string().optional(), goal: z.string().optional(), done_check: z.string().optional(),
      branch: z.string().optional(),
      area: z.union([z.string(), z.array(z.string())]).optional().describe("the folders or files you will change, relative to the checkout root or absolute; with the code map on, the first one's context is returned"),
      worktree: z.boolean().optional().describe("make a feature its own branch and git worktree; a worker (a planned task, or one with parent_task_id) always gets one, so it needs no flag"),
      parent_task_id: z.number().int().optional().describe("the feature this task is a worker of"),
      group: z.string().optional(), task_id: z.number().int().optional().describe("start this planned task instead of making a new one"),
      cwd: z.string().optional().describe("the caller's working directory; its worktree becomes the task's (stamped by the hook)"),
      actor: actorSchema,
    },
  }, tool((e, a: { title?: string; type?: string; goal?: string; done_check?: string; branch?: string; area?: string | string[]; cwd?: string; worktree?: boolean; parent_task_id?: number; group?: string; task_id?: number; actor?: Actor }, actor) => {
    const area = typeof a.area === "string" ? [a.area] : a.area;
    const v = startTask(e, {
      title: a.title, type: a.type, goal: a.goal, done_check: a.done_check, branch: a.branch, cwd: a.cwd, actor,
      worktree: a.worktree, parent_task_id: a.parent_task_id, area, group: a.group, task_id: a.task_id,
    });
    // A planned task started by id alone gets the context of the first area it was planned with.
    const stored = e.db.prepare("SELECT path FROM task_areas WHERE task_id = ? ORDER BY rowid LIMIT 1").get(v.task.id) as { path: string } | undefined;
    const first = area?.[0] ?? (stored ? stored.path || "." : undefined);
    return { ...v, ...taskContext(e, v, first, actor) };
  }));

  const codeTool = (name: CodeTool, argName: string, description: string, argHelp: string) =>
    server.registerTool(name, {
      description,
      inputSchema: {
        [argName]: z.string().describe(argHelp),
        task_id: z.number().int().optional(), cwd: z.string().optional().describe("the caller's working directory (stamped by the hook)"),
        actor: actorSchema,
      },
    }, tool((e, a: { task_id?: number; cwd?: string; actor?: Actor } & Record<string, unknown>, actor) =>
      runCodeQuery(e, { tool: name, arg: String(a[argName]), actor, cwd: a.cwd, task_id: a.task_id })));
  codeTool("context_for", "area", "Code map: what an area (folder or file) defines, what it uses and what uses it. Call it before writing code.", "folder or file path, relative to the checkout root or absolute");
  codeTool("find_existing", "description", "Code map: find existing functions that already do what you describe, before you write a new one.", "what you are about to write, in plain words");
  codeTool("who_uses", "symbol", "Code map: who calls or imports a symbol (name, or path::name).", "symbol name, or path::name");

  server.registerTool("dismiss_duplicate", {
    description: "Dismiss a possible duplicate the post-commit check found, with a reason. Not callable by the task's author.",
    inputSchema: { duplicate_id: z.number().int(), reason: z.string(), actor: actorSchema },
  }, tool((e, a: { duplicate_id: number; reason: string; actor?: Actor }, actor) =>
    dismissDuplicate(e, { id: a.duplicate_id, reason: a.reason, actor })));

  server.registerTool("plan_tasks", {
    description: "Record the worker tasks of a feature you own before starting them: each task's areas, the helpers it will add, and what it depends on. Returns the overlaps between tasks and with existing helpers.",
    inputSchema: {
      parent_task_id: z.number().int().describe("the feature these tasks belong to"),
      tasks: z.array(z.object({
        title: z.string(), type: z.string(), goal: z.string(), done_check: z.string(),
        area: z.array(z.string()).describe("the folders or files the task will change, relative to the checkout root or absolute; \".\" is the whole repository"),
        adds: z.array(z.string()).optional().describe("names of shared helpers the task plans to add"),
        depends_on: z.array(z.union([z.number().int(), z.string()])).optional().describe('task ids, or "#2" for the second task in this batch'),
        group: z.string().optional().describe("tasks in one group are one piece of work and never overlap each other"),
      })),
      actor: actorSchema,
    },
  }, tool((e, a: { parent_task_id: number; tasks: PlanTaskInput[]; actor?: Actor }, actor) =>
    planTasks(e, { parent_task_id: a.parent_task_id, tasks: a.tasks, actor })));

  server.registerTool("accept_overlap", {
    description: "Accept an overlap between two tasks you are the CTO of. Between other CTOs' tasks only the owner can (estack allow).",
    inputSchema: { a: z.number().int(), b: z.number().int(), reason: z.string(), actor: actorSchema },
  }, tool((e, a: { a: number; b: number; reason: string; actor?: Actor }, actor) => {
    acceptOverlap(e, { a: a.a, b: a.b, reason: a.reason, by: actorId(actor), owner: false, actor });
    return { accepted: [Math.min(a.a, a.b), Math.max(a.a, a.b)] };
  }));

  server.registerTool("withdraw_task", {
    description: "Cancel a planned task you own that has not started, or retire an open worker of yours that will not be merged (a bakeoff loser, a worker no longer needed): it is cancelled, its claims are released and its worktree is removed, unless it has uncommitted changes (then it is kept).",
    inputSchema: { task_id: z.number().int(), actor: actorSchema },
  }, tool((e, a: { task_id: number; actor?: Actor }, actor) => {
    const { worktree } = withdrawTask(e, a.task_id, actor);
    return { ...getTask(e, a.task_id), worktree };
  }));

  server.registerTool("status", {
    description: "Show one task (with task_id), or all open tasks with the active claims, kept worktrees and stray worktrees (engine worktrees no task accounts for).",
    inputSchema: { task_id: z.number().int().optional(), actor: actorSchema },
  }, tool((e, a: { task_id?: number; actor?: Actor }) => {
    syncMerged(e);
    recordOutcomes(e, { remote: true });
    return a.task_id !== undefined ? getTask(e, a.task_id) : { tasks: listOpen(e), claims: activeClaims(e), kept_worktrees: keptWorktrees(e), stray_worktrees: strayWorktrees(e) };
  }));

  server.registerTool("claim_status", {
    description: "Who holds a file, the holder's goal, what it changed in the file (committed and not) and who was allowed in. Use it before deciding on allow_edit.",
    inputSchema: { path: z.string().describe("the file, relative to the checkout root"), actor: actorSchema },
  }, tool((e, a: { path: string; actor?: Actor }) => claimStatus(e, a.path)));

  server.registerTool("allow_edit", {
    description: "Let a task edit a file another task holds. Only the CTO of both tasks can; across CTOs the owner runs estack allow.",
    inputSchema: { task_id: z.number().int().describe("the task that may edit"), path: z.string(), reason: z.string(), actor: actorSchema },
  }, tool((e, a: { task_id: number; path: string; reason: string; actor?: Actor }, actor) => {
    allowEdit(e, { task_id: a.task_id, path: a.path, reason: a.reason, actor, owner: false });
    return { allowed: { task_id: a.task_id, path: a.path } };
  }));

  server.registerTool("claim_symbol", {
    description: "Claim the name of a shared helper before you write it. Returns the existing helper to reuse, the task that already claimed the name, or claimed.",
    inputSchema: { task_id: z.number().int(), name: z.string(), file: z.string().describe("where you will put it"), actor: actorSchema },
  }, tool((e, a: { task_id: number; name: string; file: string; actor?: Actor }, actor) =>
    claimSymbol(e, { task_id: a.task_id, name: a.name, file: a.file, actor })));

  server.registerTool("complete_step", {
    description: "Complete the task's next step with evidence of the kind that step requires.",
    inputSchema: { task_id: z.number().int(), step: z.string(), evidence: evidenceSchema, actor: actorSchema },
  }, tool((e, a: { task_id: number; step: string; evidence: z.infer<typeof evidenceSchema>; actor?: Actor }, actor) =>
    completeStep(e, { task_id: a.task_id, step: a.step, evidence: a.evidence, actor })));

  server.registerTool("run_check", {
    description: "Run the policy's fixed test or verify command for the task's next step and record the result.",
    inputSchema: { task_id: z.number().int(), step: z.string(), timeout_sec: z.number().positive().optional(), actor: actorSchema },
  }, tool((e, a: { task_id: number; step: string; timeout_sec?: number; actor?: Actor }, actor) => {
    const check = runCheck(e, {
      task_id: a.task_id, step: a.step, actor,
      timeout_ms: a.timeout_sec !== undefined ? a.timeout_sec * 1000 : undefined,
    });
    return { check, task: getTask(e, a.task_id) };
  }));

  server.registerTool("handover", {
    description: "Save a handover so a fresh session (after /clear) can pick up the work. With task_id it covers that task; without, the whole session.",
    inputSchema: {
      task_id: z.number().int().optional(),
      goal: z.string().optional().describe("the owner's goal for the session"),
      plan: z.array(z.string()).optional().describe("remaining work not yet started as a task"),
      decisions: z.array(z.object({ what: z.string(), why: z.string() })).optional(),
      open_questions: z.array(z.string()).optional(),
      files: z.array(z.string()).optional().describe("files to re-read that git cannot see"),
      workers_done: z.boolean().optional().describe("override the check that no worker is mid-task"),
      cwd: z.string().optional().describe("the caller's working directory; its checkout scopes who is offered the handover (stamped by the hook)"),
      actor: actorSchema,
    },
  }, tool((e, a: { task_id?: number; goal?: string; plan?: string[]; decisions?: { what: string; why: string }[]; open_questions?: string[]; files?: string[]; workers_done?: boolean; cwd?: string; actor?: Actor }, actor) => {
    const { task_id, actor: _actor, cwd, ...input } = a;
    const h = task_id !== undefined ? saveTaskHandover(e, task_id, input, actor) : saveSessionHandover(e, input, actor, false, cwd);
    return { ...h, next: "Handover saved. Tell the owner: run /clear; the new session will load this automatically." };
  }));

  server.registerTool("resume", {
    description: "Pick up a saved handover (the newest session one, a task's with task_id, or exactly one with handover_id) and bind its open tasks to this session.",
    inputSchema: {
      task_id: z.number().int().optional(),
      handover_id: z.number().int().optional().describe("the handover the owner chose, from the start-of-session list"),
      cwd: z.string().optional().describe("the caller's working directory; with no selector only its checkout's handovers count (stamped by the hook)"),
      actor: actorSchema,
    },
  }, tool((e, a: { task_id?: number; handover_id?: number; cwd?: string; actor?: Actor }, actor) => {
    const { handover, views } = consumeHandover(e, actor, { task_id: a.task_id, handover_id: a.handover_id }, a.cwd);
    const body = handover?.body;
    const goal = (body?.kind === "session" ? (body as SessionHandoverBody).goal : "") || (views.length === 1 ? views[0].task.goal : "") || "(none recorded)";
    const next = views.map((v) => (v.next ? `#${v.task.id} ${v.next.name}` : `#${v.task.id} done`)).join(", ");
    const instructions = `Re-read every file listed in the handover before changing anything; do not trust a summary of code. Goal: ${goal}. Next: ${next}.`;
    return { handover, views, instructions };
  }));

  return server;
}

export async function serveStdio(cwd: string): Promise<void> {
  await createServer(cwd).connect(new StdioServerTransport());
}
