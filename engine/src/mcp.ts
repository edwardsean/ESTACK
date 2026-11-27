import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck } from "./checks";
import { openEngine, type Engine } from "./engine";
import type { Exec } from "./exec";
import { consumeHandover, saveSessionHandover, saveTaskHandover, type SessionHandoverBody } from "./handover";
import { dismissDuplicate } from "./duplicates";
import { runCodeQuery, taskContext, type CodeTool } from "./codemap";
import { completeStep, getTask, listOpen, startTask } from "./tasks";
import { EngineError, type Actor } from "./types";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const actorSchema = z.object({ session_id: z.string(), agent_id: z.string().optional() }).optional()
  .describe("who is calling; defaults to {session_id: \"unknown\"}");
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), text: z.string() }),
  z.object({ kind: z.literal("commit"), sha: z.string() }),
  z.object({ kind: z.literal("pr"), url: z.string() }),
  z.object({ kind: z.literal("review"), verdict: z.enum(["approve", "changes"]), findings: z.string() }),
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
        return text(JSON.stringify(fn(e, args, args.actor ?? { session_id: "unknown" }), null, 2));
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
      title: z.string(), type: z.string(), goal: z.string(), done_check: z.string(),
      branch: z.string().optional(),
      area: z.string().optional().describe("the folder or file you will change; with the code map on, its context is returned"),
      cwd: z.string().optional().describe("the caller's working directory; its worktree becomes the task's (stamped by the hook)"),
      actor: actorSchema,
    },
  }, tool((e, a: { title: string; type: string; goal: string; done_check: string; branch?: string; area?: string; cwd?: string; actor?: Actor }, actor) => {
    const v = startTask(e, { title: a.title, type: a.type, goal: a.goal, done_check: a.done_check, branch: a.branch, cwd: a.cwd, actor });
    return { ...v, ...taskContext(e, v, a.area, actor) };
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
  codeTool("context_for", "area", "Code map: what an area (folder or file) defines, what it uses and what uses it. Call it before writing code.", "folder or file path relative to the repository root");
  codeTool("find_existing", "description", "Code map: find existing functions that already do what you describe, before you write a new one.", "what you are about to write, in plain words");
  codeTool("who_uses", "symbol", "Code map: who calls or imports a symbol (name, or path::name).", "symbol name, or path::name");

  server.registerTool("dismiss_duplicate", {
    description: "Dismiss a possible duplicate the post-commit check found, with a reason. Not callable by the task's author.",
    inputSchema: { duplicate_id: z.number().int(), reason: z.string(), actor: actorSchema },
  }, tool((e, a: { duplicate_id: number; reason: string; actor?: Actor }, actor) =>
    dismissDuplicate(e, { id: a.duplicate_id, reason: a.reason, actor })));

  server.registerTool("status", {
    description: "Show one task (with task_id) or all open tasks.",
    inputSchema: { task_id: z.number().int().optional(), actor: actorSchema },
  }, tool((e, a: { task_id?: number; actor?: Actor }) => (a.task_id !== undefined ? getTask(e, a.task_id) : listOpen(e))));

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
      actor: actorSchema,
    },
  }, tool((e, a: { task_id?: number; goal?: string; plan?: string[]; decisions?: { what: string; why: string }[]; open_questions?: string[]; files?: string[]; workers_done?: boolean; actor?: Actor }, actor) => {
    const { task_id, actor: _actor, ...input } = a;
    const h = task_id !== undefined ? saveTaskHandover(e, task_id, input, actor) : saveSessionHandover(e, input, actor);
    return { ...h, next: "Handover saved. Tell the owner: run /clear; the new session will load this automatically." };
  }));

  server.registerTool("resume", {
    description: "Pick up a saved handover (the newest session one, a task's with task_id, or exactly one with handover_id) and bind its open tasks to this session.",
    inputSchema: {
      task_id: z.number().int().optional(),
      handover_id: z.number().int().optional().describe("the handover the owner chose, from the start-of-session list"),
      actor: actorSchema,
    },
  }, tool((e, a: { task_id?: number; handover_id?: number; actor?: Actor }, actor) => {
    const { handover, views } = consumeHandover(e, actor, { task_id: a.task_id, handover_id: a.handover_id });
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
