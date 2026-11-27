import { relative, sep } from "node:path";
import type { Engine } from "./engine";
import { mappedFiles } from "./graph";
import { actorOf, deny, nearestDir, resolveReal, type HookEvent, type HookOutput } from "./hooks";
import { HOOK_GIT_TIMEOUT_MS, logEvent, runBounded } from "./tasks";
import { actorId } from "./types";

export const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep"]);

/**
 * The "look at the map first" rule: an agent on a task whose reuse_check is not done is denied once on its
 * first read of mapped code, until it has made its own code-map search. Fails open: any error allows the read.
 */
export function preRead(e: Engine, ev: HookEvent): HookOutput {
  try {
    if (!e.policy.code_map.enabled) return null;
    const input = ev.tool_input ?? {};
    const isRead = ev.tool_name === "Read";
    const raw = isRead ? input.file_path : (input.path ?? ev.cwd);
    if (typeof raw !== "string" || raw === "") return null;
    const abs = resolveReal(ev.cwd, raw);
    const top = runBounded(e, nearestDir(abs), "git", ["rev-parse", "--show-toplevel"], HOOK_GIT_TIMEOUT_MS);
    if (top.code !== 0) return null;
    const checkout = top.stdout.trim();
    const task = e.db.prepare(
      `SELECT t.id FROM tasks t JOIN task_bindings b ON b.task_id = t.id
       WHERE t.status = 'open' AND t.cwd = ? AND b.session_id = ?
         AND EXISTS (SELECT 1 FROM steps s WHERE s.task_id = t.id AND s.name = 'reuse_check' AND s.status IN ('pending', 'in_progress'))
       ORDER BY t.id DESC LIMIT 1`,
    ).get(checkout, ev.session_id) as { id: number } | undefined;
    if (!task) return null;
    const mapped = mappedFiles(checkout);
    if (!mapped) return null;
    const rel = relative(checkout, abs).split(sep).join("/");
    if (isRead && !mapped.has(rel)) return null;
    const by = actorId(actorOf(ev));
    const searched = e.db.prepare(
      "SELECT 1 FROM code_queries WHERE task_id = ? AND recorded_by = ? AND ok = 1 AND auto = 0 LIMIT 1",
    ).get(task.id, by);
    if (searched) return null;
    const told = e.db.prepare("SELECT 1 FROM events WHERE kind = 'map_first_denied' AND task_id = ? AND actor = ? LIMIT 1").get(task.id, by);
    if (told) return null;
    logEvent(e, actorOf(ev), "map_first_denied", task.id, { tool: ev.tool_name, path: rel });
    return deny(`estack: look at the code map before reading code for task #${task.id}. Call context_for with the area you are working in, or find_existing with what you need, then read ${rel}. This happens once per task; the next read goes through either way.`);
  } catch {
    return null;
  }
}
