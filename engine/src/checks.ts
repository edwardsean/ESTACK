import { ensureDuplicateCheck, openDuplicates } from "./duplicates";
import type { Engine } from "./engine";
import { recordOutcomes } from "./outcomes";
import { finishStep, getTask, insertEvidence, logEvent, runBounded, tx } from "./tasks";
import { EngineError, STEP_EVIDENCE, type Actor } from "./types";

export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;
export interface CheckResult { ok: boolean; exit_code: number | null; timed_out: boolean; duration_ms: number; output_tail: string }

/** Run the policy command for a test/verify step ourselves, record the result, and mark the step done only on success. */
export function runCheck(e: Engine, input: { task_id: number; step: string; actor: Actor; timeout_ms?: number }): CheckResult {
  const v = getTask(e, input.task_id);
  if (v.task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${v.task.id} is ${v.task.status}`);
  if (!v.next || v.next.name !== input.step) {
    throw new EngineError("OUT_OF_ORDER", `step "${input.step}" is not next; the next step is "${v.next?.name}"`);
  }
  if (STEP_EVIDENCE[input.step] !== "command") {
    throw new EngineError("BAD_EVIDENCE", `step "${input.step}" does not take a command check`);
  }
  const command = (e.policy.commands as Record<string, string | undefined>)[input.step];
  if (!command) throw new EngineError("POLICY_INVALID", `policy.yaml has no commands.${input.step}`);

  // The check must test the task's branch: refuse if its worktree has moved to another branch.
  const on = runBounded(e, v.task.cwd, "git", ["branch", "--show-current"]).stdout.trim();
  if (on !== v.task.branch) {
    throw new EngineError("BAD_EVIDENCE", `worktree ${v.task.cwd} is on ${on || "no branch"}, task is on ${v.task.branch}`);
  }
  if (input.step === "verify") {
    ensureDuplicateCheck(e, v.task.id);
    const open = openDuplicates(e, v.task.id);
    if (open.length > 0) {
      const list = open.map((d) =>
        `${d.new_symbol} (${d.new_file}:${d.new_line}) matches ${d.existing_symbol} (${d.existing_file}:${d.existing_line}) [#${d.id}]`).join(", ");
      throw new EngineError("BAD_EVIDENCE",
        `task #${v.task.id} has possible duplicates: ${list}; remove the copy and commit, or have an agent other than the author call dismiss_duplicate with a reason`);
    }
  }
  const head = runBounded(e, v.task.cwd, "git", ["rev-parse", "HEAD"]);
  const head_sha = head.code === 0 ? head.stdout.trim() : null;

  const r = e.exec.shell(command, { cwd: v.task.cwd, timeoutMs: input.timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS });
  const result: CheckResult = {
    ok: r.code === 0 && !r.timedOut,
    exit_code: r.code,
    timed_out: r.timedOut,
    duration_ms: r.durationMs,
    output_tail: (r.stdout + r.stderr).slice(-4000),
  };
  tx(e, () => {
    // Re-check under the write lock: the task may have moved while the command ran.
    const cur = getTask(e, input.task_id);
    if (cur.task.status !== "open") throw new EngineError("TASK_CLOSED", `task ${cur.task.id} is ${cur.task.status}`);
    if (cur.next?.name !== input.step) {
      throw new EngineError("OUT_OF_ORDER", `step "${input.step}" is not next; the next step is "${cur.next?.name}"`);
    }
    insertEvidence(e, input.task_id, input.step, "command", result.ok, { command, ...result, head_sha }, input.actor);
    logEvent(e, input.actor, "evidence", input.task_id, { step: input.step, kind: "command", ok: result.ok });
    if (result.ok) {
      const closed = finishStep(e, input.task_id, input.step, input.actor);
      logEvent(e, input.actor, "step_done", input.task_id, { step: input.step, closed });
    }
  });
  recordOutcomes(e, { remote: false });
  return result;
}
