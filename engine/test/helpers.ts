import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh git repo on branch main with one empty commit. */
export function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "estack-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("commit", "--allow-empty", "-m", "init");
  return dir;
}

import type { Exec, ExecResult } from "../src/exec";
import { realExec } from "../src/exec";

/** Scripted `gh` results keyed by the joined args (e.g. "pr view URL --json url"); everything else runs for real. */
export function fakeExec(responses: Record<string, Partial<ExecResult>>): Exec {
  return {
    run(file, args, opts) {
      if (file === "gh") {
        const r = responses[args.join(" ")];
        return { code: 1, stdout: "", stderr: "no scripted response", timedOut: false, durationMs: 0, ...r };
      }
      return realExec.run(file, args, opts);
    },
    shell: (command, opts) => realExec.shell(command, opts),
  };
}
