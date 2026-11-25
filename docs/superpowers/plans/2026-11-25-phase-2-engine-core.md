# Phase 2: Engine core (tasks, steps, evidence, MCP server, CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local engine that holds each task's required steps and the evidence for each step. Agents drive it through MCP tools, the owner through a CLI, and it ships inside the estack plugin.

**Architecture:** The engine is a TypeScript library in `engine/src/`. It has two entry points: an MCP server (`estack mcp`) that agents call, and a CLI (`estack <command>`) for the owner and, from phase 3, for hooks. State lives in SQLite (Node's built-in `node:sqlite`) at the main checkout's `.estack/state.db`. Rules come from `.estack/policy.yaml`. The generator bundles the engine into one file, `adapters/claude-code/engine/estack.mjs`. The plugin's `.mcp.json` starts it, so a repository needs no MCP setup of its own.

**Tech Stack:** Node 22.5+ (24 installed), TypeScript, `node:sqlite`, `@modelcontextprotocol/sdk` 1.x, `zod`, `yaml`, `esbuild` (bundling), `vitest`.

**Spec:** `docs/superpowers/specs/2026-11-25-estack-engine-design.md`. Sections 5, 6, 7 (Policy file, Evidence, Overrides, Threat model, Roles), 8 and 13 (phase 2).

## Global Constraints

- Node `>=22.5`, because `node:sqlite` needs it. Silence its ExperimentalWarning: run with `--no-warnings`, and bundle with `#!/usr/bin/env -S node --no-warnings`.
- State lives at `<main checkout>/.estack/state.db`. Find the main checkout with `git rev-parse --path-format=absolute --git-common-dir`, then take the parent directory. A repository is **opted in** only if `.estack/policy.yaml` exists.
- SQLite settings: `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, `PRAGMA foreign_keys=ON`. Every mutation runs in one transaction.
- Owner-only commands (`skip`, `override`, `cancel`) refuse to run when `CLAUDECODE=1` is in the environment. The error says to run them from a normal terminal.
- The engine never trusts evidence the agent describes in words for `test` and `verify`. It runs the command fixed in `policy.yaml` under `commands` itself.
- Step order is strict: only the first step that is not `done` or `skipped` can be worked on.
- Each step's evidence kind is fixed by the engine (table in Task 2). Policy can't change it in this phase.
- Every mutation appends a row to `events`.
- `reuse_check` takes a `note` as evidence until phase 5 adds the code map and its query log; the spec's stronger rule applies from then.
- Approval gates still use `.claude/enterprise/gates.json` (phase 3 changes this). `/estack:setup` keeps writing it, and now also runs `estack init`.
- Edit `core/`, never `adapters/claude-code/`. Regenerate with `npm run build:claude`.

## Review Focus

1. **Two workers writing at once.** Concurrent `complete_step` calls from two processes must not crash with `SQLITE_BUSY`; the second waits and succeeds. Owner: Task 1.
2. **A repo that isn't opted in, or isn't a git repo.** Every MCP tool and CLI command returns a one-line message ("not an estack repository: run /estack:setup"), never a stack trace. Owner: Tasks 1 and 4.
3. **A test command that hangs.** `run_check` times out and records a failed run, and the step stays open. Owner: Task 3.
4. **Out-of-order steps, or a closed task.** Completing step 3 before step 2, or touching a `done` or `cancelled` task, is refused with the reason. Owner: Task 2.
5. **Commit evidence from somewhere else.** A sha that doesn't exist, or isn't on the task's branch, is refused. Owner: Task 2.

---

## File structure

| Path | Responsibility |
|---|---|
| `engine/src/types.ts` | Shared types and `EngineError` |
| `engine/src/repo.ts` | Find the main checkout and `.estack/` |
| `engine/src/db.ts` | Open the database, apply pragmas, migrations |
| `engine/src/policy.ts` | Policy schema, load and validate, default `policy.yaml` and `brief.md` text |
| `engine/src/exec.ts` | Running processes (`Exec` interface, real implementation) |
| `engine/src/engine.ts` | `openEngine()`: bundles db, policy, repo and exec into an `Engine` |
| `engine/src/tasks.ts` | The task and step state machine, evidence rules, events |
| `engine/src/checks.ts` | `runCheck`: the engine runs `test` and `verify` itself |
| `engine/src/owner.ts` | Owner-only actions: skip, cancel, override |
| `engine/src/mcp.ts` | MCP server and tool definitions |
| `engine/src/cli.ts` | CLI commands, the bundle's entry point |
| `engine/test/helpers.ts` | Temp git repo fixture, fake `Exec` |
| `engine/test/*.test.ts` | Tests per module plus an end-to-end MCP test |
| `adapters/build-claude-code.ts` | Modified: bundles the engine into the generated tree |
| `core/.mcp.json` | Plugin MCP server registration |
| `core/skills/setup/SKILL.md` | Modified: runs `estack init` |

---

### Task 1: Foundation (repo discovery, database, policy, `estack init`)

**Files:**
- Create: `engine/src/types.ts`, `engine/src/repo.ts`, `engine/src/db.ts`, `engine/src/policy.ts`, `engine/test/helpers.ts`, `engine/test/foundation.test.ts`
- Modify: `package.json` (dependencies `@modelcontextprotocol/sdk`, `zod`, `yaml`; devDependency `esbuild`; `"engines": {"node": ">=22.5"}`), `tsconfig.json` (include `engine/**/*.ts`), `vitest.config.ts` (include `engine/test/*.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type ErrorCode = "NOT_OPTED_IN" | "NOT_A_REPO" | "NO_TASK" | "OUT_OF_ORDER" | "BAD_EVIDENCE"
    | "TASK_CLOSED" | "OWNER_ONLY" | "POLICY_INVALID";
  export class EngineError extends Error { constructor(public code: ErrorCode, message: string) }
  export type TaskStatus = "open" | "done" | "cancelled";
  export type StepStatus = "pending" | "in_progress" | "done" | "skipped";
  export type EvidenceKind = "command" | "commit" | "pr" | "review" | "note";
  export interface Actor { session_id: string; agent_id?: string }
  export const actorId = (a: Actor): string => `${a.session_id}/${a.agent_id ?? "main"}`;
  export interface Task { id: number; title: string; type: string; goal: string; done_check: string;
    status: TaskStatus; branch: string; cwd: string; created_by: string; created_at: string }
  export interface Step { task_id: number; name: string; ordinal: number; status: StepStatus; done_at: string | null }
  export interface Evidence { id: number; task_id: number; step: string; kind: EvidenceKind; ok: boolean;
    payload: Record<string, unknown>; recorded_by: string; recorded_at: string }
  // repo.ts
  export interface Repo { root: string; estackDir: string; optedIn: boolean }
  export function findRepo(cwd: string): Repo;              // throws NOT_A_REPO outside git
  // db.ts
  export const SCHEMA_VERSION = 1;
  export function openDb(path: string): DatabaseSync;       // pragmas + migrations, idempotent
  // policy.ts
  export interface Policy { actions: { auto: string[]; ask: string[]; deny: string[] };
    patterns: Record<string, string[]>; task_types: Record<string, string[]>;
    protected_paths: string[]; exempt_paths: string[]; commands: { test?: string; verify?: string } }
  export function parsePolicy(yamlText: string): Policy;    // throws POLICY_INVALID naming the field
  export function loadPolicy(repo: Repo): Policy;           // throws NOT_OPTED_IN when absent
  export const DEFAULT_POLICY_YAML: string;                 // the spec section 7 example, verbatim
  export const DEFAULT_BRIEF_MD: string;                    // headings: Goals, Architecture, Conventions, Out of scope
  export function initRepo(cwd: string): { created: string[] }; // writes policy.yaml, brief.md, .estack/.gitignore ("state.db*"), creates state.db; never overwrites
  ```
  Tables, created by migration 1 (spec section 8, phase 2 subset):
  - `meta(key PRIMARY KEY, value)`
  - `tasks(id INTEGER PRIMARY KEY, title, type, goal, done_check, status, branch, cwd, created_by, created_at)`
  - `task_bindings(task_id, actor, role, bound_at)`
  - `steps(task_id, name, ordinal, status, done_at, PRIMARY KEY(task_id, name))`
  - `evidence(id INTEGER PRIMARY KEY, task_id, step, kind, ok, payload_json, recorded_by, recorded_at)`
  - `approvals(id INTEGER PRIMARY KEY, task_id, action, command, decision, by, at)`
  - `events(id INTEGER PRIMARY KEY, at, actor, kind, task_id, payload_json)`

- [ ] **Step 1: Add dependencies and config.**
  ```bash
  npm install @modelcontextprotocol/sdk zod yaml
  npm install -D esbuild
  ```
  Then update `tsconfig.json` `include` and `vitest.config.ts` `include` as listed above, and add `engines`.

- [ ] **Step 2: Write the failing tests** in `engine/test/foundation.test.ts`. `helpers.ts` provides:
  - `makeRepo(): string`, which runs `git init`, sets user name and email, makes an empty commit on branch `main`, and returns the path;
  - `fakeExec(responses)` (see Task 2).

  ```ts
  test("findRepo outside git throws NOT_A_REPO", ...)              // mkdtemp dir -> code "NOT_A_REPO"
  test("findRepo from a linked worktree resolves the main checkout", ...)
      // git worktree add <tmp>/wt -> findRepo(wt).root === realpath(main repo)
  test("a repo without policy.yaml is not opted in", ...)            // optedIn === false; loadPolicy throws NOT_OPTED_IN
  test("initRepo writes the three files and never overwrites", ...)
      // created = [".estack/policy.yaml", ".estack/brief.md", ".estack/.gitignore"]; after editing brief.md, a second initRepo returns created: [] and keeps the edit
  test("default policy parses and has the spec's task types", ...)
      // Object.keys(task_types) deep-equals ["feature","bugfix","refactor","spike"]; task_types.feature deep-equals ["plan","reuse_check","implement","test","verify","review","pr"]
  test("a task type naming an unknown step is POLICY_INVALID", ...)  // task_types: {x: ["plan","dance"]} -> message contains "dance"
  test("openDb twice is idempotent and sets WAL", ...)               // journal_mode === "wal"; meta schema_version === "1"
  test("two connections writing at once both succeed", ...)
      // open two DatabaseSync on the same file; connection A holds BEGIN IMMEDIATE while a worker_thread
      // with connection B inserts an event; release A after 200 ms; B's insert lands (busy_timeout), no SQLITE_BUSY
  ```

- [ ] **Step 3: Run the tests and make sure they fail.** Run `npx vitest run engine/test/foundation.test.ts`. Expected: FAIL, the modules don't exist.

- [ ] **Step 4: Implement `types.ts`, `repo.ts`, `db.ts`, `policy.ts`.**
  - `parsePolicy` uses a zod schema. Every step name in `task_types` must be a key of `STEP_EVIDENCE`, defined in `types.ts` with the exact table shown in Task 2's Interfaces.
  - `DEFAULT_POLICY_YAML` is the spec section 7 policy block, copied exactly.

- [ ] **Step 5: Run the tests and make sure they pass.** Run `npx vitest run engine/test/foundation.test.ts`. Expected: 8 passed.

- [ ] **Step 6: Commit.**
  ```bash
  git add package.json package-lock.json tsconfig.json vitest.config.ts engine
  git commit -m "engine: repo discovery, database, policy, init"
  ```

---

### Task 2: Task and step state machine with evidence rules

**Files:**
- Create: `engine/src/exec.ts`, `engine/src/engine.ts`, `engine/src/tasks.ts`, `engine/test/tasks.test.ts`
- Modify: `engine/src/types.ts` (move `STEP_EVIDENCE` here if not already)

**Interfaces:**
- Consumes: Task 1's `openDb`, `loadPolicy`, `findRepo`, types.
- Produces:
  ```ts
  // types.ts
  export const STEP_EVIDENCE: Record<string, EvidenceKind> = {
    plan: "note", explore: "note", report: "note", reproduce: "note", reuse_check: "note",
    implement: "commit", fix: "commit", test: "command", verify: "command", review: "review", pr: "pr" };
  // exec.ts
  export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }
  export interface Exec {
    run(file: string, args: string[], opts: { cwd: string; timeoutMs?: number }): ExecResult;
    shell(command: string, opts: { cwd: string; timeoutMs: number }): ExecResult; }
  export const realExec: Exec;                               // child_process.spawnSync
  // engine.ts
  export interface Engine { db: DatabaseSync; policy: Policy; repo: Repo; exec: Exec; now: () => Date }
  export function openEngine(cwd: string, deps?: { exec?: Exec; now?: () => Date }): Engine;
  // tasks.ts
  export type EvidenceInput =
    | { kind: "note"; text: string } | { kind: "commit"; sha: string } | { kind: "pr"; url: string }
    | { kind: "review"; verdict: "approve" | "changes"; findings: string };
  export interface TaskView { task: Task; steps: Step[]; next: Step | null; evidence: Evidence[] }
  export function startTask(e: Engine, input: { title: string; type: string; goal: string; done_check: string;
    actor: Actor; cwd?: string; branch?: string }): TaskView;     // branch defaults to `git branch --show-current` in cwd
  export function getTask(e: Engine, id: number): TaskView;       // throws NO_TASK
  export function listOpen(e: Engine): TaskView[];
  export function completeStep(e: Engine, input: { task_id: number; step: string; evidence: EvidenceInput; actor: Actor }): TaskView;
  export function recordEvidence(e: Engine, input: { task_id: number; step: string; kind: EvidenceKind; ok: boolean;
    payload: Record<string, unknown>; actor: Actor }): void;      // used by checks.ts; also logs an event
  export function markStepDone(e: Engine, task_id: number, step: string, actor: Actor): TaskView; // closes the task after its last step
  ```
  Rules enforced by `completeStep`:
  1. The task exists (`NO_TASK`) and is `open` (`TASK_CLOSED`).
  2. `step` is the task's next step (`OUT_OF_ORDER`, with the message naming the expected step).
  3. `evidence.kind === STEP_EVIDENCE[step]`. `command` steps are refused here, and the message says to use `run_check` (`BAD_EVIDENCE`).
  4. `note`: the text is not blank.
  5. `commit`: `git cat-file -e <sha>^{commit}` exits 0, and `git merge-base --is-ancestor <sha> <task.branch>` exits 0, both run in `task.cwd`.
  6. `pr`: `gh pr view <url> --json url` exits 0.
  7. `review`: `verdict === "approve"`, and the actor differs from the `recorded_by` of the task's `commit` evidence. Otherwise `BAD_EVIDENCE`: "a review must come from a different agent than the author", or "changes requested".

  `startTask` also inserts a `task_bindings` row for the actor, with `role` set to `"worker"` when `agent_id` is present and `"cto"` otherwise.

  When the rules pass, the evidence is stored with `ok = true`, the step becomes `done`, and an event is logged. A failed rule stores nothing and throws.

- [ ] **Step 1: Write the failing tests** in `engine/test/tasks.test.ts`. Use `makeRepo()`, `initRepo()`, and `openEngine(repo, { exec: fake })` with a fake whose `gh` responses are scripted. `git` calls go to `realExec`, against the temp repo.

  ```ts
  test("startTask creates the policy's steps in order and binds the actor", ...)  // feature -> names deep-equal policy order; next.name === "plan"; branch === "main"; one task_bindings row, role "cto"
  test("an unknown task type is POLICY_INVALID", ...)
  test("completing the wrong step is OUT_OF_ORDER and names the expected step", ...)  // complete "implement" first -> message contains "plan"
  test("a note completes a note step", ...)                        // plan done; next.name === "reuse_check"
  test("a blank note is BAD_EVIDENCE", ...)
  test("a command step cannot be completed by hand", ...)          // step "test" -> BAD_EVIDENCE, message contains "run_check"
  test("a commit on the task branch is accepted", ...)             // real commit in the temp repo
  test("a nonexistent sha is BAD_EVIDENCE", ...)
  test("a commit not on the task branch is BAD_EVIDENCE", ...)     // commit made on another branch
  test("a pr is accepted only when gh pr view succeeds", ...)      // fake gh exit 0 vs 1
  test("the author cannot review their own work", ...)             // same actor as the commit -> BAD_EVIDENCE
  test("a different agent's approval completes review", ...)
  test("finishing the last step closes the task, and a closed task is TASK_CLOSED", ...)
  test("every successful mutation logs one event", ...)            // events count grows by 1 per startTask/completeStep
  ```

- [ ] **Step 2: Run the tests and make sure they fail.** Run `npx vitest run engine/test/tasks.test.ts`. Expected: FAIL, the modules don't exist.

- [ ] **Step 3: Implement `exec.ts`, `engine.ts`, `tasks.ts`.** `realExec.shell` uses `spawnSync("/bin/sh", ["-c", command], { cwd, timeout, maxBuffer: 64 MB })`. A timeout sets `timedOut` (from `error.code === "ETIMEDOUT"`) and leaves `code` as `null`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run `npx vitest run engine/test/tasks.test.ts`. Expected: 14 passed.

- [ ] **Step 5: Commit.**
  ```bash
  git add engine
  git commit -m "engine: task and step state machine with evidence rules"
  ```

---

### Task 3: Engine-run checks, owner-only actions, and the CLI

**Files:**
- Create: `engine/src/checks.ts`, `engine/src/owner.ts`, `engine/src/cli.ts`, `engine/test/checks.test.ts`, `engine/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 2's `recordEvidence`, `markStepDone`, `getTask`, `Engine`.
- Produces:
  ```ts
  // checks.ts
  export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;
  export interface CheckResult { ok: boolean; exit_code: number | null; timed_out: boolean; duration_ms: number; output_tail: string }
  export function runCheck(e: Engine, input: { task_id: number; step: string; actor: Actor; timeout_ms?: number }): CheckResult;
  // owner.ts
  export function assertOwner(env: NodeJS.ProcessEnv): void;       // throws OWNER_ONLY when env.CLAUDECODE === "1"
  export function skipStep(e: Engine, input: { task_id: number; step: string; reason: string }, env: NodeJS.ProcessEnv): TaskView;
  export function cancelTask(e: Engine, input: { task_id: number; reason: string }, env: NodeJS.ProcessEnv): TaskView;
  export function recordOverride(e: Engine, input: { action: string; reason: string; task_id?: number }, env: NodeJS.ProcessEnv): void; // row in approvals, decision "override"
  // cli.ts
  export function main(argv: string[], io: { cwd: string; env: NodeJS.ProcessEnv; out: (s: string) => void; err: (s: string) => void }): number;
  ```
  `runCheck` rules:
  - The step must be the next step and its kind must be `command`.
  - The command is `policy.commands[step]`. If it is missing, throw `POLICY_INVALID`: "policy.yaml has no commands.<step>".
  - Run it with `exec.shell` in `task.cwd`.
  - Record evidence with payload `{command, exit_code, timed_out, duration_ms, output_tail}`, where `output_tail` is the last 4000 characters of stdout plus stderr, and `ok = exit_code === 0`.
  - Call `markStepDone` only when `ok` is true.

  CLI commands. Exit 0 on success, 1 on `EngineError` (message on stderr as `estack: <message>`), 2 on bad usage:

  | Command | Does |
  |---|---|
  | `estack init` | `initRepo(cwd)`, prints the created files |
  | `estack status [--json]` | open tasks with each step's status, and the next step |
  | `estack run --task <id> --step <test\|verify> [--timeout <sec>]` | `runCheck` as actor `{session_id: "cli"}`, prints ok/exit code/tail |
  | `estack skip --task <id> --step <name> --reason <text>` | owner only |
  | `estack cancel --task <id> --reason <text>` | owner only |
  | `estack override <action> --reason <text> [--task <id>]` | owner only |
  | `estack mcp` | starts the MCP server (Task 4) |

- [ ] **Step 1: Write the failing tests.**

  `checks.test.ts`, with a real temp repo and a real shell:
  ```ts
  test("a passing test command completes the test step", ...)     // commands.test "true" -> ok true, step done, evidence.ok 1
  test("a failing command records evidence and leaves the step open", ...)  // "exit 3" -> exit_code 3, step status not done
  test("a hanging command times out and is recorded as failed", ...)        // "sleep 5", timeout_ms 300 -> timed_out true, ok false
  test("the command comes from policy, not the caller", ...)       // payload.command === policy.commands.test
  test("missing commands.verify is POLICY_INVALID", ...)
  test("run_check on a non-command step is BAD_EVIDENCE", ...)
  ```

  `cli.test.ts`, calling `main()` with captured io:
  ```ts
  test("outside an opted-in repo every command prints one line and exits 1", ...)  // status in a plain git repo -> err === "estack: not an estack repository: run /estack:setup\n"
  test("init then status shows no open tasks", ...)
  test("skip under CLAUDECODE=1 is refused as owner-only", ...)    // exit 1, err contains "normal terminal"
  test("skip from a normal terminal marks the step skipped and logs an event", ...)
  test("cancel closes the task", ...)
  test("override writes an approvals row with decision override", ...)
  test("unknown command exits 2 with usage", ...)
  ```

- [ ] **Step 2: Run the tests and make sure they fail.** Run `npx vitest run engine/test/checks.test.ts engine/test/cli.test.ts`. Expected: FAIL, the modules don't exist.

- [ ] **Step 3: Implement `checks.ts`, `owner.ts`, `cli.ts`.** `skipStep` only accepts the next step, so skipping still follows step order. A skipped step's event payload carries the reason.

- [ ] **Step 4: Run the tests and make sure they pass.** Run `npx vitest run engine/test/checks.test.ts engine/test/cli.test.ts`. Expected: 13 passed.

- [ ] **Step 5: Commit.**
  ```bash
  git add engine
  git commit -m "engine: engine-run checks, owner-only actions, CLI"
  ```

---

### Task 4: MCP server and an end-to-end test

**Files:**
- Create: `engine/src/mcp.ts`, `engine/test/mcp.test.ts`
- Modify: `engine/src/cli.ts` (`mcp` command calls `serveStdio()`)

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces:
  ```ts
  export function createServer(cwd: string, deps?: { exec?: Exec; now?: () => Date }): McpServer; // tools registered
  export async function serveStdio(cwd: string): Promise<void>;
  ```
  Tools. All take an optional `actor: {session_id, agent_id?}`, defaulting to `{session_id: "unknown"}`. Phase 3 makes a hook stamp it.

  | Tool | Input | Returns (as JSON text content) |
  |---|---|---|
  | `start_task` | `title, type, goal, done_check, branch?` | `TaskView` |
  | `status` | `task_id?` | one `TaskView`, or all open ones |
  | `complete_step` | `task_id, step, evidence` (the `EvidenceInput` union) | `TaskView` |
  | `run_check` | `task_id, step, timeout_sec?` | `CheckResult` and the `TaskView` |

  The engine opens per call, so the server holds no state. On `EngineError` the tool returns `isError: true` with text `<code>: <message>`. Any other error returns `isError: true` with `internal error: <message>` and never crashes the server.

- [ ] **Step 1: Write the failing tests** in `engine/test/mcp.test.ts`. Use the SDK's `InMemoryTransport.createLinkedPair()` and a `Client`:
  ```ts
  test("lists exactly the four tools", ...)                          // names sorted deep-equal ["complete_step","run_check","start_task","status"]
  test("not opted in returns isError with NOT_OPTED_IN text, server keeps working", ...)
  test("drives a feature task end to end", ...)
      // in an init'ed temp repo whose policy has commands.test "true", commands.verify "true", fake gh exit 0:
      // start_task(feature) -> plan(note) -> reuse_check(note) -> implement(commit of a real commit, actor A)
      // -> run_check test -> run_check verify -> review(approve, actor B) -> pr(url)
      // final status: task.status === "done", every step "done", 7 evidence rows ok
  test("an engine error comes back as isError, not a thrown exception", ...)  // complete_step out of order -> isError, text starts "OUT_OF_ORDER"
  ```

- [ ] **Step 2: Run the tests and make sure they fail.** Run `npx vitest run engine/test/mcp.test.ts`. Expected: FAIL, `./mcp` doesn't exist.

- [ ] **Step 3: Implement `engine/src/mcp.ts`.** Use `McpServer.registerTool` with zod input schemas. Then wire `estack mcp` into `cli.ts`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run `npx vitest run engine/test/mcp.test.ts`, then `npm test`. Expected: 4 passed, then the whole suite passes (13 generator + 39 engine).

- [ ] **Step 5: Commit.**
  ```bash
  git add engine
  git commit -m "engine: MCP server with start_task, status, complete_step, run_check"
  ```

---

### Task 5: Ship the engine inside the plugin, and run it live

**Files:**
- Modify: `adapters/build-claude-code.ts`, `adapters/generate.test.ts` (or a new `adapters/build-claude-code.test.ts`), `package.json` (`"bin": {"estack": "adapters/claude-code/engine/estack.mjs"}`), `core/skills/setup/SKILL.md`, `README.md`
- Create: `core/.mcp.json`
- Regenerate: `adapters/claude-code/`

**Interfaces:**
- Consumes: `engine/src/cli.ts` `main()` as the bundle entry.
- Produces:
  ```ts
  // build-claude-code.ts
  export function bundleEngine(root: string): Buffer;   // esbuild, write:false, deterministic
  ```
  The engine bundle is `adapters/claude-code/engine/estack.mjs`, mode 0o755.

  `core/.mcp.json`:
  ```json
  { "mcpServers": { "estack": { "command": "node",
      "args": ["--no-warnings", "${CLAUDE_PLUGIN_ROOT}/engine/estack.mjs", "mcp"] } } }
  ```

- [ ] **Step 1: Write the failing test.** `adapters/build-claude-code.test.ts`:
  - `test("the bundle is deterministic", ...)`: two `bundleEngine` calls produce equal Buffers.
  - `test("the bundled CLI runs", ...)`: write the bundle to a temp file, run `node --no-warnings <tmp> status` in a plain temp git repo, and expect exit 1 with stderr `estack: not an estack repository: run /estack:setup`.

  Export `bundleEngine` from `build-claude-code.ts`. Guard its `main()` so importing it doesn't build, with `if (import.meta.url === pathToFileURL(process.argv[1]).href)`.

- [ ] **Step 2: Run it and make sure it fails.** Run `npx vitest run adapters/build-claude-code.test.ts`. Expected: FAIL, `bundleEngine` isn't exported. Add `adapters/*.test.ts` to the vitest include if it isn't already.

- [ ] **Step 3: Implement `bundleEngine`.** Use esbuild with:
  - `entryPoints: ["engine/src/cli.ts"]`, `bundle: true`, `platform: "node"`, `format: "esm"`, `target: "node22"`, `write: false`
  - `banner: { js: "#!/usr/bin/env -S node --no-warnings\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }`
  - `external: ["node:*"]`

  `cli.ts` calls `main(process.argv.slice(2), {...})` when run directly. `build-claude-code.ts` adds the bundle to the tree as `engine/estack.mjs` with mode `0o755` before `writeTree`/`diffTree`.

- [ ] **Step 4: Run it and make sure it passes.** Run `npx vitest run adapters/build-claude-code.test.ts`. Expected: 2 passed.

- [ ] **Step 5: Wire the plugin.**
  - Add `core/.mcp.json` as above.
  - In `core/skills/setup/SKILL.md`, add a step after writing `gates.json`: run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/engine/estack.mjs" init` in the project root and report the created files. Explain that `.estack/brief.md` is for the owner to fill in.
  - Add `"bin"` to root `package.json`.
  - In `README.md`, add an "Engine" section:
    - what it stores and where;
    - the four MCP tools;
    - the CLI, with `npm link` once in the estack clone to get `estack` on PATH;
    - that `skip`/`cancel`/`override` are owner-only, run from a normal terminal.

  Then regenerate and run every check:
  ```bash
  npm run build:claude && npm test && npx tsc -p . && (cd adapters/claude-code && bash scripts/selftest.sh)
  ```
  Expected: all pass, and selftest reports `passed 6, failed 0`.

- [ ] **Step 6: Live check.** In a scratch git repo:
  1. `claude plugin marketplace add <worktree root>`, then `claude plugin install estack@estack`.
  2. `node --no-warnings <worktree>/adapters/claude-code/engine/estack.mjs init`.
  3. Run headless: `claude -p "Using the estack MCP tools only: start a spike task titled 'live check' with goal 'prove the engine runs' and done_check 'status shows it', then call status and print the result."`

  Expected:
  - The reply shows a task with steps `explore`, `report`.
  - `estack status` from the CLI shows the same task.
  - If Claude Code starts plugin MCP servers with a working directory other than the project, the reply shows `NOT_OPTED_IN`. In that case, change `.mcp.json` to pass `--cwd ${CLAUDE_PROJECT_DIR}` (and add that flag to `estack mcp`), then re-run.

  Afterwards, run `claude plugin marketplace remove estack`. Record the outcome in the commit message.

- [ ] **Step 7: Commit.**
  ```bash
  git add -A
  git commit -m "Ship the engine in the plugin: bundled CLI, MCP server registration, setup runs init"
  ```
