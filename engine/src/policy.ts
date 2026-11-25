import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { openDb } from "./db";
import { findRepo, type Repo } from "./repo";
import { EngineError, STEP_EVIDENCE } from "./types";

export interface Policy {
  actions: { auto: string[]; ask: string[]; deny: string[] };
  patterns: Record<string, string[]>;
  task_types: Record<string, string[]>;
  protected_paths: string[];
  exempt_paths: string[];
  commands: { test?: string; verify?: string };
}

const strings = z.array(z.string());
const PolicySchema = z.object({
  actions: z.object({ auto: strings, ask: strings, deny: strings }),
  patterns: z.record(z.string(), strings).default({}),
  task_types: z.record(z.string(), strings.superRefine((steps, ctx) => {
    for (const s of steps) {
      if (!(s in STEP_EVIDENCE)) ctx.addIssue({ code: "custom", message: `unknown step "${s}"` });
    }
  })),
  protected_paths: strings.default([]),
  exempt_paths: strings.default([]),
  commands: z.object({ test: z.string().optional(), verify: z.string().optional() }).default({}),
});

export function parsePolicy(yamlText: string): Policy {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new EngineError("POLICY_INVALID", `policy.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const r = PolicySchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new EngineError("POLICY_INVALID", `invalid policy.yaml: ${msg}`);
  }
  return r.data as Policy;
}

export function loadPolicy(repo: Repo): Policy {
  if (!repo.optedIn) throw new EngineError("NOT_OPTED_IN", "not an estack repository: run /estack:setup");
  return parsePolicy(readFileSync(join(repo.estackDir, "policy.yaml"), "utf8"));
}

export const DEFAULT_POLICY_YAML = `
# .estack/policy.yaml
actions:
  auto:  [read, edit_in_task_worktree, run_tests, lint, commit, open_draft_pr]
  ask:   [git_push, merge, deploy, db_migration, delete_outside_repo, send_message]
  deny:  [force_push_protected, edit_secrets, disable_hooks]
patterns:                 # how shell commands map to actions; replaces gates.json
  git_push:      ["git push*"]
  deploy:        ["*deploy*", "kubectl apply*", "terraform apply*"]
  db_migration:  ["*migrate*", "prisma migrate*"]
  force_push_protected: ["git push --force* origin main", "git push -f* origin main"]
task_types:
  feature:  [plan, reuse_check, implement, test, verify, review, pr]
  bugfix:   [reproduce, reuse_check, fix, test, verify, pr]
  refactor: [plan, reuse_check, implement, test, verify, pr]
  spike:    [explore, report]          # no code merged
protected_paths: [".env*", "**/secrets/**", ".estack/policy.yaml", ".estack/state.db"]
exempt_paths: ["**/*.md", ".estack/brief.md", "docs/**"]   # editable with no task
commands:                 # the engine runs these itself for test and verify (section 7, Evidence)
  test:   "npm test"
  verify: "npm run build && npm run test:e2e"
`.trimStart();

export const DEFAULT_BRIEF_MD = `# Project brief

## Goals

What this project is for and who it serves.

## Architecture

The main parts and how they fit together.

## Conventions

Naming, testing and review habits agents should follow.

## Out of scope

Things agents must not change or build.
`;

/** Write the default estack files and create the database. Never overwrites existing files. */
export function initRepo(cwd: string): { created: string[] } {
  const repo = findRepo(cwd);
  mkdirSync(repo.estackDir, { recursive: true });
  const created: string[] = [];
  const files: [string, string][] = [
    ["policy.yaml", DEFAULT_POLICY_YAML],
    ["brief.md", DEFAULT_BRIEF_MD],
    [".gitignore", "state.db*\n"],
  ];
  for (const [name, content] of files) {
    const p = join(repo.estackDir, name);
    if (existsSync(p)) continue;
    writeFileSync(p, content);
    created.push(`.estack/${name}`);
  }
  openDb(join(repo.estackDir, "state.db")).close();
  return { created };
}
