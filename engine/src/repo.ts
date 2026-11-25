import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { EngineError } from "./types";

export interface Repo { root: string; estackDir: string; optedIn: boolean }

/** Resolve the main checkout (even from a linked worktree) and whether it opted in. */
export function findRepo(cwd: string): Repo {
  let common: string;
  try {
    common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new EngineError("NOT_A_REPO", `not a git repository: ${cwd}`);
  }
  const root = realpathSync(dirname(common));
  const estackDir = join(root, ".estack");
  return { root, estackDir, optedIn: existsSync(join(estackDir, "policy.yaml")) };
}
