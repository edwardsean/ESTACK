import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "./engine";
import { openEngine } from "./engine";
import { runHook, type HookEvent } from "./hooks";
import { runCheck } from "./checks";
import { serveStdio } from "./mcp";
import { assertOwner, cancelTask, recordOverride, skipStep } from "./owner";
import { preCommit, prePush, installGitHooks } from "./githooks";
import { afterCommit } from "./duplicates";
import { initRepo, loadPolicy } from "./policy";
import { realExec, type Exec } from "./exec";
import { findRepo } from "./repo";
import { pendingHandovers, type SessionHandoverBody } from "./handover";
import { BUILD_TIMEOUT_MS, INSTALL_HINT, buildGraph, checkoutLabel, checkoutOf, folderShares, graphifyVersion, loadGraph, suggestExcludes, versionSupported } from "./graph";
import { listOpen } from "./tasks";
import { EngineError } from "./types";

export interface Io { cwd: string; env: NodeJS.ProcessEnv; out: (s: string) => void; err: (s: string) => void; stdin?: string; exec?: Exec }

const USAGE = `usage: estack <command>
  init [--engine <path>] [--code-map <on|off>] [--exclude <globs>]   (first setup only)
  git-hook <pre-commit|pre-push>                     (called by the installed git hooks)
  map-hook <post-commit|post-checkout|post-merge|post-rewrite>   (called by the installed git hooks)
  status [--json]
  handovers [--json]                                 (pending handovers)
  run --task <id> --step <test|verify> [--timeout <sec>]
  skip --task <id> --step <name> --reason <text>     (owner only)
  cancel --task <id> --reason <text>                 (owner only)
  override <action> --reason <text> [--task <id>]    (owner only)
  map <update|status|suggest> [--json]                     (the Graphify code map)
  hook <pre-tool-use|post-tool-use|session-start|user-prompt-submit|stop|subagent-stop>   (event JSON on stdin)
`;

class Usage extends Error {}

const runHookDeny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `estack: ${reason}` },
});

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

function handovers(e: Engine, json: boolean, out: (s: string) => void): void {
  const all = pendingHandovers(e);
  if (json) return out(JSON.stringify(all, null, 2) + "\n");
  if (all.length === 0) return out("no pending handovers\n");
  for (const h of all) {
    const bodies = h.body.kind === "session" ? (h.body as SessionHandoverBody).tasks : [h.body];
    const next = bodies.map((t) => `#${t.task.id} ${t.next_step ?? "done"}`).join(", ");
    out(`#${h.id} ${h.kind === "session" ? "session" : `task #${h.task_id}`} ${h.created_at} from ${h.from_session} ${h.auto ? "auto" : "manual"} next: ${next}\n`);
  }
}

const MAP_OFF = "the code map is off (code_map.enabled is false in .estack/policy.yaml)\n";
const NOT_FOUND = `code map off: Graphify not found. Install it with ${INSTALL_HINT}, then add a code_map block to .estack/policy.yaml yourself (see /estack:setup) and run "estack map update".\n`;
const NOT_APPLIED = "policy.yaml already exists, so --code-map and --exclude were not applied; to change the code map, edit the code_map block in .estack/policy.yaml yourself.\n";

/** Whether the policy on disk turns the map on; false when it can't be read. */
function mapEnabled(cwd: string): boolean {
  try {
    return loadPolicy(findRepo(cwd)).code_map.enabled;
  } catch {
    return false;
  }
}

function mapStatus(e: Engine, json: boolean, out: (s: string) => void): void {
  const version = graphifyVersion(e);
  const supported = version !== null && versionSupported(version);
  const cwds = [e.repo.root, ...listOpen(e).map((t) => t.task.cwd)].filter((c, i, a) => a.indexOf(c) === i);
  const checkouts = cwds.map((cwd) => {
    const g = loadGraph(cwd);
    return {
      checkout: cwd, label: checkoutLabel(e, cwd), built_at_commit: g?.built_at_commit ?? null,
      entries: g?.nodes.size ?? 0, files: g?.files.size ?? 0, built: g !== null,
      folders: g ? folderShares(g).slice(0, 10) : [],
    };
  });
  const events = e.db.prepare("SELECT at, payload_json FROM events WHERE kind = 'map_built' ORDER BY id DESC").all() as { at: string; payload_json: string }[];
  let last_failure: { at: string; checkout: string; error: string } | null = null;
  for (const ev of events) {
    const p = JSON.parse(ev.payload_json) as { checkout: string; ok: boolean; error?: string };
    if (p.ok) break;
    last_failure ??= { at: ev.at, checkout: p.checkout, error: p.error ?? "unknown error" };
  }
  if (json) return out(JSON.stringify({ enabled: e.policy.code_map.enabled, graphify_version: version, supported, checkouts, last_failure }, null, 2) + "\n");
  out(`code map: ${e.policy.code_map.enabled ? "on" : "off"}\n`);
  out(`graphify: ${version === null ? "not installed" : `${version} (${supported ? "supported" : "not supported"})`}\n`);
  for (const c of checkouts) {
    if (!c.built) { out(`${c.label}: not built\n`); continue; }
    out(`${c.label}: built at ${c.built_at_commit ?? "unknown commit"}, ${c.entries} entries, ${c.files} files\n`);
    out("  " + c.folders.map((f) => `${f.folder} ${f.percent}%`).join(", ") + "\n");
  }
  if (last_failure) out(`last build failure (${last_failure.at}): ${last_failure.error}\n`);
}

function dispatch(cmd: string, rest: string[], io: Io): number {
  switch (cmd) {
    case "init": {
      const { opt } = parse(rest, ["engine", "code-map", "exclude"]);
      if (opt["code-map"] !== undefined && opt["code-map"] !== "on" && opt["code-map"] !== "off") throw new Usage("--code-map needs on or off");
      const exec = io.exec ?? realExec;
      const v = opt["code-map"] === "off" ? null : graphifyVersion({ exec, cwd: io.cwd });
      const supported = v !== null && versionSupported(v);
      const mapOn = opt["code-map"] === "on" || (opt["code-map"] === undefined && supported);
      const exclude = (opt.exclude ?? "").split(",").map((g) => g.trim()).filter(Boolean);
      const { created } = initRepo(io.cwd, { codeMap: mapOn, exclude });
      // Init never rewrites an existing policy: it is protected, so changing it is the owner's edit.
      const fresh = created.includes(".estack/policy.yaml");
      io.out(created.length ? created.map((f) => `created ${f}`).join("\n") + "\n" : "already initialised\n");
      if (!fresh && (opt["code-map"] !== undefined || opt.exclude !== undefined)) io.out(NOT_APPLIED);
      const entry = process.argv[1];
      const enginePath = opt.engine !== undefined ? resolve(io.cwd, opt.engine)
        : entry && /estack\.mjs$/.test(entry) ? realpathSync(entry) : null;
      if (enginePath === null) io.out("git hooks not installed: engine path unknown\n");
      else {
        const h = installGitHooks(findRepo(io.cwd).root, enginePath);
        if (h.skipped) io.out(`git hooks not installed: ${h.skipped}\n`);
        else io.out(`installed git hooks: ${h.installed.join(", ")}\n`);
        if (h.chained.length) io.out(`chained existing hooks: ${h.chained.join(", ")}\n`);
      }
      if (opt["code-map"] === undefined && !supported && (fresh || !mapEnabled(io.cwd))) io.out(NOT_FOUND);
      if (mapOn) {
        const e = openEngine(io.cwd, { exec });
        try {
          if (e.policy.code_map.enabled) {
            const checkout = e.repo.root;
            const r = buildGraph(e, checkout, BUILD_TIMEOUT_MS);
            io.out(r.ok ? `map built for ${checkoutLabel(e, checkout)}: ${r.nodes} entries, ${r.files} files, ${r.duration_ms}ms\n` : `map build failed: ${r.error}\n`);
            const g = r.ok ? loadGraph(checkout) : null;
            if (g) io.out("folder shares: " + folderShares(g).slice(0, 10).map((f) => `${f.folder} ${f.percent}%`).join(", ") + "\n");
          }
        } finally {
          e.db.close();
        }
      }
      return 0;
    }
    case "git-hook": {
      const name = rest[0] ?? "";
      if (name !== "pre-commit" && name !== "pre-push") throw new Usage("git-hook needs pre-commit or pre-push");
      let e: Engine;
      try {
        e = openEngine(io.cwd);
      } catch (x) {
        if (x instanceof EngineError && (x.code === "NOT_OPTED_IN" || x.code === "NOT_A_REPO")) return 0;
        throw x;
      }
      try {
        const msg = name === "pre-commit" ? preCommit(e, io.cwd) : prePush(e, io.cwd, io.stdin ?? readFileSync(0, "utf8"));
        if (msg === null) return 0;
        io.err(`estack: ${msg}\n`);
        return 1;
      } finally {
        e.db.close();
      }
    }
    case "map-hook": {
      const name = rest[0] ?? "";
      // Runs detached for every git command the owner types: it must never fail, so every error is swallowed.
      try {
        const e = openEngine(io.cwd);
        try {
          if (!e.policy.code_map.enabled) return 0;
          const checkout = checkoutOf(e, io.cwd);
          if (buildGraph(e, checkout).ok && (name === "post-commit" || name === "post-rewrite")) afterCommit(e, checkout);
        } finally {
          e.db.close();
        }
      } catch { /* the map_built event records build failures */ }
      return 0;
    }
    case "status": {
      const { bool } = parse(rest, [], ["json"]);
      status(openEngine(io.cwd), bool.has("json"), io.out);
      return 0;
    }
    case "handovers": {
      const { bool } = parse(rest, [], ["json"]);
      const e = openEngine(io.cwd);
      try { handovers(e, bool.has("json"), io.out); } finally { e.db.close(); }
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
    case "map": {
      const sub = rest[0] ?? "";
      if (sub !== "update" && sub !== "status" && sub !== "suggest") throw new Usage("map needs update, status or suggest");
      const { bool } = parse(rest.slice(1), [], ["json"]);
      const e = openEngine(io.cwd, { exec: io.exec });
      try {
        if (sub === "suggest") {
          const s = suggestExcludes(e, e.repo.root);
          io.out(s.length ? s.map((x) => `${x.glob}  (${x.reason})\n`).join("") : "no exclude suggestions\n");
          return 0;
        }
        if (sub === "status") { mapStatus(e, bool.has("json"), io.out); return 0; }
        if (!e.policy.code_map.enabled) {
          io.out(bool.has("json") ? JSON.stringify({ enabled: false }) + "\n" : MAP_OFF);
          return 0;
        }
        const checkout = checkoutOf(e, io.cwd);
        const r = buildGraph(e, checkout, BUILD_TIMEOUT_MS);
        if (bool.has("json")) io.out(JSON.stringify(r) + "\n");
        else io.out(r.ok ? `map built for ${checkoutLabel(e, checkout)}: ${r.nodes} entries, ${r.files} files, ${r.duration_ms}ms\n` : `map build failed: ${r.error}\n`);
        return r.ok ? 0 : 1;
      } finally {
        e.db.close();
      }
    }
    case "hook": {
      const name = rest[0] ?? "";
      const gate = name === "pre-tool-use";
      let ev: HookEvent;
      try {
        ev = JSON.parse(io.stdin ?? readFileSync(0, "utf8")) as HookEvent;
        if (ev === null || typeof ev !== "object") throw new Error("not an object");
      } catch {
        if (gate) io.out(JSON.stringify(runHookDeny("invalid hook event on stdin")));
        return 0;
      }
      const output = runHook(name, ev);
      if (output !== null) io.out(JSON.stringify(output));
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
