import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openDb } from "./db";
import { realExec, type Exec } from "./exec";
import { loadPolicy, type Policy } from "./policy";
import { findRepo, type Repo } from "./repo";

/** cwd is where the engine was opened (the CLI's cwd, or the MCP server's): startTask records its worktree. */
export interface Engine { db: DatabaseSync; policy: Policy; repo: Repo; exec: Exec; now: () => Date; cwd: string }

/** Open the state database and policy for the repo containing cwd. Throws NOT_OPTED_IN if not set up. */
export function openEngine(cwd: string, deps: { exec?: Exec; now?: () => Date } = {}): Engine {
  const repo = findRepo(cwd);
  const policy = loadPolicy(repo);
  const db = openDb(join(repo.estackDir, "state.db"));
  return { db, policy, repo, exec: deps.exec ?? realExec, now: deps.now ?? (() => new Date()), cwd };
}
