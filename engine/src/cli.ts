import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Engine } from "./engine";
import { openEngine } from "./engine";
import { runCheck } from "./checks";
import { serveStdio } from "./mcp";
import { assertOwner, cancelTask, recordOverride, skipStep } from "./owner";
import { initRepo } from "./policy";
import { listOpen } from "./tasks";
import { EngineError } from "./types";

export interface Io { cwd: string; env: NodeJS.ProcessEnv; out: (s: string) => void; err: (s: string) => void }

const USAGE = `usage: estack <command>
  init
  status [--json]
  run --task <id> --step <test|verify> [--timeout <sec>]
  skip --task <id> --step <name> --reason <text>     (owner only)
  cancel --task <id> --reason <text>                 (owner only)
  override <action> --reason <text> [--task <id>]    (owner only)
`;

class Usage extends Error {}

function parse(args: string[], flags: string[], bools: string[] = []): { pos: string[]; opt: Record<string, string>; bool: Set<string> } {
  const pos: string[] = [], opt: Record<string, string> = {}, bool = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (bools.includes(k)) bool.add(k);
      else if (flags.includes(k)) {
        if (i + 1 >= args.length) throw new Usage(`--${k} needs a value`);
        opt[k] = args[++i];
      } else throw new Usage(`unknown option ${a}`);
    } else pos.push(a);
  }
  return { pos, opt, bool };
}
const need = (opt: Record<string, string>, k: string): string => {
  if (opt[k] === undefined) throw new Usage(`missing --${k}`);
  return opt[k];
};
function num(s: string, what: string): number {
  if (!/^\d+$/.test(s)) throw new Usage(`${what} must be a number`);
  return Number(s);
}
const CLI_ACTOR = { session_id: "cli" };

function status(e: Engine, json: boolean, out: (s: string) => void): void {
  const open = listOpen(e);
  if (json) return out(JSON.stringify(open.map((t) => ({ ...t.task, steps: t.steps.map((s) => ({ name: s.name, status: s.status })), next: t.next?.name ?? null })), null, 2) + "\n");
  if (open.length === 0) return out("no open tasks\n");
  for (const t of open) {
    out(`#${t.task.id} [${t.task.type}] ${t.task.title} (${t.task.branch})\n`);
    out("  " + t.steps.map((s) => `${s.name}:${s.status}`).join(" ") + "\n");
    out(`  next: ${t.next?.name ?? "none"}\n`);
  }
}

function dispatch(cmd: string, rest: string[], io: Io): number {
  switch (cmd) {
    case "init": {
      const { created } = initRepo(io.cwd);
      io.out(created.length ? created.map((f) => `created ${f}`).join("\n") + "\n" : "already initialised\n");
      return 0;
    }
    case "status": {
      const { bool } = parse(rest, [], ["json"]);
      status(openEngine(io.cwd), bool.has("json"), io.out);
      return 0;
    }
    case "run": {
      const { opt } = parse(rest, ["task", "step", "timeout"]);
      const task_id = num(need(opt, "task"), "--task");
      const step = need(opt, "step");
      const timeout_ms = opt.timeout !== undefined ? num(opt.timeout, "--timeout") * 1000 : undefined;
      const r = runCheck(openEngine(io.cwd), { task_id, step, actor: CLI_ACTOR, timeout_ms });
      io.out(`${r.ok ? "ok" : "failed"} (exit ${r.exit_code ?? "none"}${r.timed_out ? ", timed out" : ""}, ${r.duration_ms}ms)\n`);
      if (r.output_tail) io.out(r.output_tail.endsWith("\n") ? r.output_tail : r.output_tail + "\n");
      return r.ok ? 0 : 3;
    }
    case "skip": {
      const { opt } = parse(rest, ["task", "step", "reason"]);
      const a = { task_id: num(need(opt, "task"), "--task"), step: need(opt, "step"), reason: need(opt, "reason") };
      assertOwner(io.env);
      skipStep(openEngine(io.cwd), a, io.env);
      io.out(`skipped ${a.step} on task ${a.task_id}\n`);
      return 0;
    }
    case "cancel": {
      const { opt } = parse(rest, ["task", "reason"]);
      const a = { task_id: num(need(opt, "task"), "--task"), reason: need(opt, "reason") };
      assertOwner(io.env);
      cancelTask(openEngine(io.cwd), a, io.env);
      io.out(`cancelled task ${a.task_id}\n`);
      return 0;
    }
    case "override": {
      const { pos, opt } = parse(rest, ["reason", "task"]);
      if (pos.length !== 1) throw new Usage("override needs exactly one <action>");
      const a = { action: pos[0], reason: need(opt, "reason"), task_id: opt.task !== undefined ? num(opt.task, "--task") : undefined };
      assertOwner(io.env);
      recordOverride(openEngine(io.cwd), a, io.env);
      io.out(`recorded override for ${a.action}\n`);
      return 0;
    }
    case "mcp":
      serveStdio(io.cwd).catch((x: unknown) => {
        io.err(`estack: ${x instanceof Error ? x.message : String(x)}\n`);
        process.exitCode = 1;
      });
      return 0;
    default:
      throw new Usage(cmd ? `unknown command ${cmd}` : "no command given");
  }
}

export function main(argv: string[], io: Io): number {
  try {
    return dispatch(argv[0] ?? "", argv.slice(1), io);
  } catch (x) {
    if (x instanceof Usage) {
      io.err(`estack: ${x.message}\n${USAGE}`);
      return 2;
    }
    if (x instanceof EngineError) {
      io.err(`estack: ${x.message}\n`);
      return 1;
    }
    io.err(`estack: internal error: ${x instanceof Error ? x.message : String(x)}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
}
