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
