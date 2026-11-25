import { spawnSync } from "node:child_process";

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }
export interface Exec {
  run(file: string, args: string[], opts: { cwd: string; timeoutMs?: number }): ExecResult;
  shell(command: string, opts: { cwd: string; timeoutMs: number }): ExecResult;
}

function toResult(r: ReturnType<typeof spawnSync>, started: number): ExecResult {
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    code: timedOut ? null : r.status,
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? (r.error && !timedOut ? r.error.message : ""),
    timedOut,
    durationMs: Date.now() - started,
  };
}

const MAX_BUFFER = 64 * 1024 * 1024;

export const realExec: Exec = {
  run(file, args, { cwd, timeoutMs }) {
    const t = Date.now();
    return toResult(spawnSync(file, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER }), t);
  },
  shell(command, { cwd, timeoutMs }) {
    const t = Date.now();
    return toResult(spawnSync("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER }), t);
  },
};
