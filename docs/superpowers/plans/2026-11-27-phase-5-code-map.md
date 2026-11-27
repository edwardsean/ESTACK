# Phase 5: Code map on Graphify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents see the code that already exists before they write new code, reuse searches count as evidence only when the engine ran them, and a helper written twice is flagged and holds back `verify`.

**Architecture:** Graphify only builds: the engine runs `graphify extract <checkout> --code-only` per checkout (the main checkout and each task's worktree), with generated and copied folders excluded through a `.graphifyignore` the engine writes from `policy.yaml`. The engine reads `graphify-out/graph.json` itself for the three agent tools (`context_for`, `find_existing`, `who_uses`) and logs every call in a new `code_queries` table. Four rules sit on top: `reuse_check` needs the completing agent's own search; a Read/Grep "map first" rule, per agent and task, before `reuse_check`; a post-commit duplicate check that holds back `verify`; and estack-managed post-commit/checkout/merge/rewrite git hooks that keep every checkout's map current in the background.

**Tech Stack:** Existing engine (TypeScript, `node:sqlite`, MCP SDK, zod, vitest). External tool: Graphify (`graphifyy` on PyPI, CLI `graphify`), not a package dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-estack-engine-design.md` amendment 1 as approved 2026-11-27: section 3 (constraint), 7 (policy `code_map`, hook table Read/Grep row, git hooks, `reuse_check` evidence row), 8 (`code_queries`), 9 (all of it), 13 phase 5, 14, 15.

## Global Constraints

- **Dependencies:** no new npm dependencies. Never run `npm install`; use `npm ci`. `package-lock.json` must not change.
- **What to edit:** `core/` and `engine/`, never `adapters/claude-code/`. Regenerate with `npm run build:claude`; `npm run check:claude` must pass.
- **Graphify invocation:** the engine only ever runs `graphify extract <checkout> --code-only` (never `graphify update`, `graphify hook install` or `graphify claude install`), always with env `GRAPHIFY_BACKEND=none` and `GRAPHIFY_QUERY_LOG_DISABLE=1`.
- **Supported Graphify:** version `>=0.9.121,<0.10`, `graph.schema_version` 1. Install command to print: `uv tool install "graphifyy>=0.9.121,<0.10"`. Never install silently.
- **Migration:** add `MIGRATION_3`, set `SCHEMA_VERSION = 3`; version-2 databases upgrade in place.
- **Policy default when `code_map` is absent:** `{ enabled: false, exclude: [] }`, so repos opted in before phase 5 behave exactly as today.
- **Read/Grep fail open:** any error on the Read/Grep path (engine crash, bad policy, git failure, missing node) allows the call silently. Every other PreToolUse path keeps failing closed.
- **Git map hooks never make git wait or fail:** they run the engine detached and always exit 0.
- **Writing style:** no em or en dashes in `core/` and `README.md` (the content gate enforces it).
- **Tests that need real Graphify** use `describe.skipIf(!HAS_GRAPHIFY)` from `engine/test/helpers.ts`; everything else uses a hand-written `graph.json` via `writeFakeGraph`.

## Review Focus

1. **A repo opted in before phase 5.** Its `policy.yaml` has no `code_map`: every task type still completes exactly as in phase 4 (reuse_check takes a plain note), and Read/Grep is never denied. Test owned by Task 1 (`policy without code_map behaves as phase 4`).
2. **A Read when the engine is broken.** Invalid `policy.yaml`, or the engine throws: Read/Grep is allowed with no output, while an Edit in the same state is still denied. Test owned by Task 5 (`read tools fail open when the engine errors`).
3. **A worker in a brand-new worktree.** No `graphify-out/` yet: the code-map tools say there's no map for that checkout and how to build it, and the map-first rule does nothing there. Tests owned by Task 4 (`no graph for checkout`) and Task 5 (`no graph means no map-first denial`).
4. **Test helpers with the same name.** `setup()` in two test files is not a possible duplicate. Test owned by Task 6 (`functions in test files are neither checked nor matched`).
5. **A commit made while a build is running.** Two map builds on one checkout don't corrupt `graph.json`; the second waits. Test owned by Task 2 (`a second build waits for the lock`).

---

### Task 1: Storage, policy and exec env

**Files:**
- Modify: `engine/src/db.ts`, `engine/src/policy.ts`, `engine/src/exec.ts`, `engine/src/types.ts`
- Test: `engine/test/foundation.test.ts`, `engine/test/handover.test.ts` (migration test asserts `SCHEMA_VERSION` 2 today: update it to 3)

**Interfaces:**
- Produces:
  - `MIGRATION_3` creating:
    ```sql
    CREATE TABLE code_queries (
      id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), tool TEXT NOT NULL,
      input TEXT NOT NULL, result_json TEXT NOT NULL, ok INTEGER NOT NULL, auto INTEGER NOT NULL,
      graph_version TEXT, checkout TEXT NOT NULL, recorded_by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE duplicates (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), commit_sha TEXT NOT NULL,
      new_symbol TEXT NOT NULL, new_file TEXT NOT NULL, new_line INTEGER NOT NULL,
      existing_symbol TEXT NOT NULL, existing_file TEXT NOT NULL, existing_line INTEGER NOT NULL,
      status TEXT NOT NULL, reason TEXT, closed_by TEXT, found_at TEXT NOT NULL, closed_at TEXT,
      UNIQUE (task_id, new_file, new_symbol, existing_file, existing_symbol));
    ```
  - `Policy.code_map: { enabled: boolean; exclude: string[] }`
  - `defaultPolicyYaml(opts: { codeMap: boolean; exclude: string[] }): string` (replaces direct use of `DEFAULT_POLICY_YAML`; keep `DEFAULT_POLICY_YAML` exported as `defaultPolicyYaml({ codeMap: false, exclude: [] })`). The YAML gains, after `commands:`:
    ```yaml
    code_map:                 # Graphify code map (section 9 of the design)
      enabled: <true|false>   # false when Graphify is missing or finds no supported language
      exclude: [<globs>]      # generated or copied code, kept out of the map
    ```
  - `initRepo(cwd: string, opts: { codeMap?: boolean; exclude?: string[] } = {})` (defaults `false`, `[]`)
  - `Exec.run` opts gain `env?: Record<string, string>`, merged over `process.env` (after `LC_ALL: "C"`)
  - `ErrorCode` gains `"MAP_OFF" | "MAP_BROKEN"`

- [ ] **Step 1: Write failing tests** in `foundation.test.ts`:
  - `a version-2 database upgrades to 3 and keeps its rows`: build a v2 db from `MIGRATION_1`+`MIGRATION_2` with one task and one handover, open with `openDb`, expect `schema_version` "3", both new tables exist, old rows intact.
  - `policy without code_map behaves as phase 4`: `parsePolicy` of today's default YAML (no `code_map`) gives `code_map` `{ enabled: false, exclude: [] }`.
  - `initRepo writes code_map from its options`: `initRepo(dir, { codeMap: true, exclude: ["dist/**"] })` then `loadPolicy` gives `{ enabled: true, exclude: ["dist/**"] }`.
  - `exec run passes extra env`: `realExec.run("sh", ["-c", "printf %s \"$X\""], { cwd, env: { X: "y" } }).stdout === "y"`.
- [ ] **Step 2: Run** `npx vitest run engine/test/foundation.test.ts`; expect the four to FAIL.
- [ ] **Step 3: Implement** the interfaces above. zod: `code_map: z.object({ enabled: z.boolean().default(false), exclude: strings.default([]) }).default({ enabled: false, exclude: [] })`.
- [ ] **Step 4: Run** `npm test`; expect all PASS (update the handover migration test's `SCHEMA_VERSION` expectation to 3).
- [ ] **Step 5: Commit** `engine: code_queries and duplicates tables, code_map policy, exec env`.

### Task 2: Graphify adapter and `estack map update|status`

**Files:**
- Create: `engine/src/graph.ts`
- Modify: `engine/src/cli.ts`, `engine/test/helpers.ts`
- Test: `engine/test/graph.test.ts`, `engine/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 `Policy.code_map`, `Exec.run` env, `MAP_BROKEN`.
- Produces (all in `graph.ts`):
  ```ts
  export const GRAPHIFY_ENV = { GRAPHIFY_BACKEND: "none", GRAPHIFY_QUERY_LOG_DISABLE: "1" };
  export const GRAPH_SCHEMA = 1;
  export const BUILD_TIMEOUT_MS = 300_000;
  export const START_TASK_BUILD_TIMEOUT_MS = 60_000;
  export const INSTALL_HINT = 'uv tool install "graphifyy>=0.9.121,<0.10"';
  export interface GraphNode { id: string; label: string; name: string; file: string; line: number; kind: "file" | "function" | "symbol" }
  export interface GraphEdge { source: string; target: string; relation: string; confidence: string; file: string; line: number }
  export interface Graph { checkout: string; graphify_version: string; built_at_commit: string | null; nodes: Map<string, GraphNode>; edges: GraphEdge[]; files: Set<string> }
  export interface BuildResult { ok: boolean; checkout: string; duration_ms: number; nodes: number; files: number; error?: string }
  export function graphifyVersion(e: Engine): string | null;      // `graphify --version` -> "0.9.121", null if missing
  export function versionSupported(v: string): boolean;           // >=0.9.121 and <0.10.0
  export function checkoutOf(e: Engine, cwd: string): string;     // git rev-parse --show-toplevel
  export function checkoutLabel(e: Engine, checkout: string): string; // "main" | "task 14's worktree" | checkout path
  export function writeIgnore(e: Engine, checkout: string): void;
  export function buildGraph(e: Engine, checkout: string, timeoutMs?: number): BuildResult;
  export function loadGraph(checkout: string): Graph | null;      // null when graphify-out/graph.json is missing
  export function mappedFiles(checkout: string): Set<string> | null; // from graphify-out/estack-files.json
  export function folderShares(g: Graph): { folder: string; nodes: number; percent: number }[];
  ```
- `helpers.ts` gains `export const HAS_GRAPHIFY: boolean` (`graphify --version` succeeds and is supported) and `export function writeFakeGraph(checkout: string, nodes: object[], links: object[]): void` that writes `graphify-out/graph.json` in Graphify's shape (`{ graph: { schema_version: 1, graphify_version: "0.9.121" }, built_at_commit, nodes, links }`) plus `graphify-out/estack-files.json`. `fakeExec` scripts `graphify` like `gh`: exact key `graphify <args joined>` first, then a catch-all key `graphify`.

Behaviour to pin:
- `writeIgnore` writes `<checkout>/.graphifyignore` with one `policy.code_map.exclude` glob per line (overwriting), and makes sure `<git common dir>/info/exclude` contains the lines `graphify-out/` and `.graphifyignore` (append only if missing).
- `buildGraph`: refuse with `ok:false` and an error naming `INSTALL_HINT` when `graphifyVersion` is null or unsupported. Take a lock by exclusive-creating `<checkout>/graphify-out/.estack-build.lock` (`mkdir -p graphify-out` first); if it exists and is younger than `timeoutMs`, sleep in 200 ms steps (`Atomics.wait`) until it is gone, then build; if older, treat as stale and replace it. Run `writeIgnore`, then `graphify extract <checkout> --code-only` with `GRAPHIFY_ENV` and the timeout. On success read `graph.json`; if `graph.schema_version !== 1` or the version is unsupported, `ok:false` with `expected schema 1 and Graphify >=0.9.121,<0.10, found ...`. Write `graphify-out/estack-files.json` = `{ built_at_commit, graphify_version, files: [sorted source_file values of code nodes] }`. Release the lock in `finally`. Log event `map_built` `{checkout, ok, duration_ms, nodes, error?}`.
- `loadGraph` keeps only nodes with a non-empty `source_file`. `line` from `source_location` `"L60"`. `kind`: `"function"` when the label ends in `()`; `"file"` when `line === 1` and the label ends with the file's basename; else `"symbol"`. `name` = label without a trailing `()` or leading `.`. Edges keep `relation`, `confidence`, `source_file`, line.
- `checkoutLabel`: `"main"` when `checkout === e.repo.root`, else `task <id>'s worktree` for the newest open task with that `cwd`, else the path.

CLI (`cli.ts`, add to `USAGE`):
- `estack map update [--json]`: `buildGraph(e, checkoutOf(e, io.cwd))`; prints `map built for main: 925 entries, 120 files, 1700ms` or `map build failed: <error>`; exit 0 or 1. With `code_map.enabled` false: prints `the code map is off (code_map.enabled is false in .estack/policy.yaml)`, exit 0.
- `estack map status [--json]`: enabled flag; Graphify version and whether supported; for the main checkout and each open task's `cwd`: label, `built_at_commit`, entries, files, and the top 10 `folderShares` (`adapters/claude-code 40%`); the newest failed `map_built` event since the last success, if any.

- [ ] **Step 1: Write failing tests** in `graph.test.ts`:
  - `versionSupported pins 0.9.121 up to 0.10`: true for `0.9.121`, `0.9.200`; false for `0.9.120`, `0.10.0`, `1.0.0`.
  - `writeIgnore writes the exclude list and local git excludes`: policy exclude `["dist/**","upstream/**"]` → `.graphifyignore` is exactly `dist/**\nupstream/**\n`; `info/exclude` contains both lines once after two calls.
  - `build refuses without Graphify and names the install command`: `fakeExec({ graphify: { code: 127 } })` → `ok:false`, `error` contains `INSTALL_HINT`.
  - `loadGraph reads nodes, kinds and edges`: `writeFakeGraph` with a file node, a `formatDate()` node at `L3`, an external node with empty `source_file`, and a `calls` edge → 2 nodes, kinds `file`/`function`, `name` `formatDate`, `line` 3, one edge.
  - `checkoutLabel names main and task worktrees`.
  - `describe.skipIf(!HAS_GRAPHIFY)("real graphify")`: `build maps code only and skips excluded folders` (fixture repo with `src/a.ts`, `dist/a.js`, `README.md`; exclude `dist/**`: files set is `{"src/a.ts"}`), and `a second build waits for the lock` (write a fresh `.estack-build.lock`, spawn a detached `node -e` that deletes it after 500 ms, then `buildGraph` returns `ok:true` with `duration_ms >= 400` and a valid `graph.json`).
  - `cli.test.ts`: `map update with the map off says so and exits 0`; `map status lists folder shares` (using `writeFakeGraph` on the main checkout with nodes in `src/` and `dist/`).
- [ ] **Step 2: Run** `npx vitest run engine/test/graph.test.ts engine/test/cli.test.ts`; expect the new tests to FAIL.
- [ ] **Step 3: Implement** `graph.ts`, the helpers, and the two CLI commands.
- [ ] **Step 4: Run** `npm test`; expect all PASS.
- [ ] **Step 5: Commit** `engine: Graphify adapter, code-only builds, map update and status`.

### Task 3: The three queries

**Files:**
- Create: `engine/src/codemap.ts`
- Test: `engine/test/codemap.test.ts`

**Interfaces:**
- Consumes: Task 2 `Graph`, `GraphNode`, `loadGraph`, `checkoutOf`, `checkoutLabel`.
- Produces:
  ```ts
  export const MAX_LIST = 40;
  export const MAX_MATCHES = 15;
  export interface Hit { symbol: string; file: string; line: number; relation?: string; confidence?: string; why?: ("name" | "text")[] }
  export interface ContextResult { graph: string; area: string; defines: Hit[]; uses: Hit[]; used_by: Hit[]; more: Record<string, number> }
  export interface FindResult { graph: string; description: string; words: string[]; matches: Hit[] }
  export interface WhoUsesResult { graph: string; symbol: string; defined_at: Hit[]; callers: Hit[]; ambiguous?: Hit[] }
  export function contextFor(g: Graph, label: string, area: string): ContextResult;
  export function whoUses(g: Graph, label: string, symbol: string): WhoUsesResult;
  export function descriptionWords(description: string): string[];
  export function findExisting(e: Engine, g: Graph, label: string, description: string): FindResult;
  ```

Behaviour to pin:
- `contextFor`: area is a file or folder path relative to the checkout (trailing `/` ignored). In-area nodes: `file === area` or `file` starts with `area + "/"`. `defines`: in-area `function` and `symbol` nodes. `uses`: edges from an in-area node to an out-of-area node with relation in `calls, indirect_call, imports, imports_from, inherits, references`, as the target's symbol, file and line. `used_by`: edges from an out-of-area node into the area with relation `calls, indirect_call, imports, inherits, references`, as the source's symbol with the edge's file and line. Dedupe by symbol+file; each list capped at `MAX_LIST`, the overflow count in `more`.
- `whoUses`: `symbol` is `name` or `path::name`. Match nodes whose `name` equals it (and whose `file` equals `path` when given). Several files and no path: return `ambiguous` (one `Hit` per candidate) and no callers. Callers: incoming edges with relation `calls, indirect_call, imports, references, inherits`, each with relation, confidence, the source's symbol and the edge's file and line.
- `descriptionWords`: lowercase, split on non-letters/digits, drop words under 3 characters and these: `the and for with from into this that some any are its function helper method code thing way something`. Unique, in order.
- `findExisting`: name score of a `function`/`symbol` node = number of distinct words contained in its lowercased `name`. Text search: `git grep --untracked -n -i -F -e <w1> -e <w2> ...` in the checkout, keep hits whose file is in `g.files`; map each hit line to the function in that file with the greatest `line <= hit`, or else a function starting within 3 lines after the hit; text score of a function = distinct words found on its hit lines (re-test each hit line for each word). Total score = distinct words across both; `why` lists which halves matched. Sort by score desc, then file, then line; return the top `MAX_MATCHES`. No words: empty matches.

- [ ] **Step 1: Write failing tests** with `writeFakeGraph` on a `makeRepo` checkout holding real files `src/utils.ts` (`export function formatInvoiceDate(d: Date) { ... }` and `export function runBounded(cmd: string, timeoutMs: number) { // timeout ... }`), `src/orders/invoice.ts` (imports and calls `formatInvoiceDate`), `dist/utils.js` NOT in the graph:
  - `context_for an area lists what it defines, uses and is used by`: `contextFor(g, "main", "src/orders")` → `uses` contains `formatInvoiceDate` at `src/utils.ts`; nothing from `dist/`.
  - `who_uses lists callers with file and line`; `who_uses with a name in two files asks which` (`ambiguous` has 2, `callers` empty); `who_uses path::name picks one`.
  - `descriptionWords drops filler`: `"run a command with a timeout"` → `["run", "command", "timeout"]`.
  - `find_existing finds by code text what names miss`: `findExisting(e, g, "main", "run a command with a timeout")` first match `runBounded` with `why` containing `"text"`.
  - `find_existing finds by name`: `"format invoice date"` → first match `formatInvoiceDate`, `why` contains `"name"`.
  - `lists are capped with a count of the rest`: 45 callers → 40 listed, `more.used_by === 5`.
- [ ] **Step 2: Run** `npx vitest run engine/test/codemap.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `codemap.ts` (pure over `Graph`, plus the one `git grep` through `runBounded` with `HOOK_GIT_TIMEOUT_MS`).
- [ ] **Step 4: Run** `npm test`; expect all PASS.
- [ ] **Step 5: Commit** `engine: context_for, find_existing and who_uses over graph.json`.

### Task 4: MCP tools, query log, `start_task` context, `reuse_check` rule

**Files:**
- Modify: `engine/src/codemap.ts`, `engine/src/mcp.ts`, `engine/src/tasks.ts`, `engine/src/hooks.ts` (cwd stamping only)
- Test: `engine/test/mcp.test.ts`, `engine/test/tasks.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  ```ts
  // codemap.ts
  export type CodeTool = "context_for" | "find_existing" | "who_uses";
  export function runCodeQuery(e: Engine, input: { tool: CodeTool; arg: string; actor: Actor; cwd?: string; task_id?: number; auto?: boolean }): unknown;
  export function taskContext(e: Engine, v: TaskView, area: string | undefined, actor: Actor): { context?: ContextResult; map_note?: string };
  ```
  MCP tools `context_for { area }`, `find_existing { description }`, `who_uses { symbol }`, each with optional `task_id`, `cwd`, `actor`. `start_task` gains optional `area`; its result becomes `{ ...TaskView, context?, map_note? }`.

Behaviour to pin:
- `runCodeQuery`: map off → throw `MAP_OFF` `the code map is off for this repository (code_map.enabled is false in .estack/policy.yaml); search with Read and Grep instead`. Checkout = `checkoutOf(e, cwd ?? e.cwd)`. Task = `task_id` if given (must be open, else `NO_TASK`/`TASK_CLOSED`), else the newest open task with `cwd = checkout` bound to `actor.session_id`, else null. No graph → `MAP_BROKEN` `no code map for <label> yet: run "estack map update" there, or start a task in it`. Every call, success or failure, inserts one `code_queries` row (`ok` 1/0, `auto` 0/1, `graph_version` = `<graphify_version>@<built_at_commit>`, `recorded_by = actorId(actor)`, `result_json` capped at 20000 chars) before returning or throwing.
- `taskContext`: map off → `{}`. No graph for the task's `cwd` → `buildGraph(e, cwd, START_TASK_BUILD_TIMEOUT_MS)`; a failed build → `{ map_note: "code map unavailable: <error>" }`. With `area`: `context` from `runCodeQuery({ tool: "context_for", arg: area, task_id, auto: true })`. Without: `map_note: "call context_for with the area you will change before writing code"`.
- `reuse_check` (in `checkEvidence`, note case): when `step === "reuse_check"` and `code_map.enabled`, require at least one `code_queries` row with this `task_id`, `recorded_by = actorId(actor)`, `ok = 1`, `auto = 0`, `tool IN ('find_existing','context_for')`; else `BAD_EVIDENCE` `reuse_check needs a find_existing or context_for search you ran yourself for this task; the automatic context from start_task and other agents' searches don't count`. Payload `{ text, queries: [ids] }`. Map off: unchanged (plain note).
- `hooks.ts` stamps the real `cwd` for `start_task`, `context_for`, `find_existing` and `who_uses`.

- [ ] **Step 1: Write failing tests:**
  - `mcp.test.ts`: `lists exactly the nine tools` (replace the six-tool test; dismiss_duplicate arrives in Task 6 and bumps it to ten); `code-map tools say the map is off` (isError, text starts `MAP_OFF:`); `no graph for checkout` (map on, no `graphify-out/`: isError, text starts `MAP_BROKEN:` and contains `estack map update`, and a `code_queries` row with `ok 0` exists); `context_for logs a code_queries row for the caller's task` (map on via policy edit, `writeFakeGraph`, then one row with `recorded_by "s1/A"`, `ok 1`, `auto 0`); `start_task with an area returns that area's context and logs it as automatic`.
  - `tasks.test.ts`: `with the map on, reuse_check needs the agent's own search` (A's note refused; after A's `find_existing` accepted, payload `queries` holds that id); `start_task's automatic context doesn't count`; `another agent's search doesn't count` (B searched, A refused); `a failed search doesn't count`; `with the map off, reuse_check takes a plain note`.
- [ ] **Step 2: Run** the two files; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect all PASS.
- [ ] **Step 5: Commit** `engine: code-map MCP tools, query log, start_task context, reuse_check needs own search`.

### Task 5: "Look at the map first" for Read and Grep

**Files:**
- Create: `engine/src/mapfirst.ts`
- Modify: `engine/src/hooks.ts`, `core/hooks/hooks.json`, `core/hooks/scripts/estack-hook.sh`
- Test: `engine/test/mapfirst.test.ts`, `engine/test/hooks.test.ts`

**Interfaces:**
- Consumes: Task 2 `mappedFiles`, `checkoutOf`; Task 4 `code_queries` rows.
- Produces: `export const READ_TOOLS: ReadonlySet<string>` (`Read`, `Grep`); `export function preRead(e: Engine, ev: HookEvent): HookOutput`.

Behaviour to pin (`preRead`, whole body in try/catch returning `null`):
1. Map off → null.
2. Target: Read `tool_input.file_path`; Grep `tool_input.path ?? ev.cwd`; resolved against `ev.cwd`. Checkout = git top level of the target's nearest existing folder (`HOOK_GIT_TIMEOUT_MS`); not this repo's main checkout or an open task's `cwd` → null.
3. Task: the newest open task with `cwd = checkout`, bound to `ev.session_id`, that has a `reuse_check` step with status `pending` or `in_progress`. None → null.
4. `mappedFiles(checkout)` null → null. Read: the path relative to the checkout must be in it, else null. Grep: applies.
5. Caller = `actorId(actorOf(ev))`. A `code_queries` row for this task with `recorded_by` = caller and `ok = 1` → null. An event `map_first_denied` for this task with that actor → null.
6. Log `map_first_denied` `{ tool, path }`, return deny: `estack: look at the code map before reading code for task #<id>. Call context_for with the area you are working in, or find_existing with what you need, then read <rel>. This happens once per task; the next read goes through either way.`

Wiring:
- `preToolUse`: `READ_TOOLS.has(tool)` → `preRead(e, ev)`.
- `runHook`: `gate = name === "pre-tool-use" && !READ_TOOLS.has(ev.tool_name ?? "")`, so an engine error on a read tool returns `null`.
- `hooks.json` PreToolUse matcher: `Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|mcp__plugin_estack_estack__.*`.
- `estack-hook.sh`: read `tool_name` from the input the same way as `cwd`; when it is `Read` or `Grep`, a missing node or an engine failure exits 0 with no output.

- [ ] **Step 1: Write failing tests** (`mapfirst.test.ts` via `runHook("pre-tool-use", ...)`, map on, `writeFakeGraph` listing `src/a.ts`):
  - `a worker's first read before reuse_check is denied once`: worker A Read `src/a.ts` → deny naming `context_for`; second Read → null.
  - `after its own search the agent reads freely` (A's `context_for` first, then Read → null).
  - `each agent gets its own denial` (A denied, then B denied once too).
  - `past reuse_check nobody is denied` (reuse_check done via a search and note; reviewer C's Read → null).
  - `no graph means no map-first denial`; `a file outside the map is never denied` (`README.md`); `a task without reuse_check is never denied` (spike task); `grep inside the checkout counts as a first read`.
  - `hooks.test.ts`: `read tools fail open when the engine errors` (corrupt `policy.yaml`: Read → null, Edit → deny); `the hook script lets Read through without node` (run `estack-hook.sh` with `PATH` lacking node on a Read event: exit 0, empty stdout; on an Edit: the existing deny).
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement**, then `npm run build:claude`.
- [ ] **Step 4: Run** `npm test` and `npm run check:claude`; expect PASS.
- [ ] **Step 5: Commit** `engine: map-first rule for Read and Grep, per agent and task, failing open`.

### Task 6: Duplicate check, `verify` gate, `dismiss_duplicate`

**Files:**
- Create: `engine/src/duplicates.ts`
- Modify: `engine/src/checks.ts`, `engine/src/mcp.ts`
- Test: `engine/test/duplicates.test.ts`, `engine/test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 2 `Graph`, `loadGraph`, `buildGraph`; Task 1 `duplicates` table.
- Produces:
  ```ts
  export interface Duplicate { id: number; task_id: number; commit_sha: string; new_symbol: string; new_file: string; new_line: number;
    existing_symbol: string; existing_file: string; existing_line: number; status: "open" | "resolved" | "dismissed"; reason: string | null; closed_by: string | null }
  export const NAME_PREFIXES = ["get", "make", "build", "create", "compute", "calculate", "calc", "do"];
  export function normaliseName(name: string): string;
  export function paramCount(checkout: string, file: string, line: number): number | null;
  export function isTestFile(file: string): boolean;
  export function newFunctions(e: Engine, g: Graph, task: Task): GraphNode[];
  export function checkDuplicates(e: Engine, task_id: number): Duplicate[];   // returns open ones
  export function openDuplicates(e: Engine, task_id: number): Duplicate[];
  export function ensureDuplicateCheck(e: Engine, task_id: number): void;
  export function afterCommit(e: Engine, checkout: string): void;
  export function dismissDuplicate(e: Engine, input: { id: number; reason: string; actor: Actor }): Duplicate;
  ```
  MCP tool `dismiss_duplicate { duplicate_id, reason, actor }`.

Behaviour to pin:
- `normaliseName`: lowercase, drop `_` and `-`, then strip one leading `NAME_PREFIXES` entry when at least 3 characters remain. `getInvoiceDate` and `invoice_date` both → `invoicedate`.
- `paramCount`: from the source at `line` (and up to 4 more lines), the text between the first `(` after the name and its matching `)`; empty → 0, else top-level commas + 1. Not found → null.
- `isTestFile`: `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`.
- `newFunctions`: function nodes of `g` (not test files) whose start line lies in an added range of `git diff -U0 --no-color <base_sha>..refs/heads/<branch>` (`@@ -a,b +c,d @@` → lines `c .. c+d-1`, `d` default 1, `d = 0` none).
- `checkDuplicates`: `g = loadGraph(task.cwd)` (null → `[]`). Each open duplicate whose new function is no longer in `newFunctions`, or whose match no longer holds → `resolved`. Each new function `f`, against every other function `x` in `g` (not a test file, not `f` itself): match when `normaliseName` is equal and `paramCount` is equal or either is null. Record each unordered pair once (insert ignoring the unique conflict) with `commit_sha` = branch head, and log `possible_duplicate`. Log `duplicate_check_done` `{ head }`.
- `ensureDuplicateCheck`: map off → return. Branch head equals the newest `duplicate_check_done` head for the task → return. Else `buildGraph(e, task.cwd)` (failure → `MAP_BROKEN` `the duplicate check could not run: <error>`) and `checkDuplicates`.
- `runCheck` with `step === "verify"`: before running the command, `ensureDuplicateCheck`; open duplicates → `BAD_EVIDENCE` `task #<id> has possible duplicates: <new_symbol> (<new_file>:<line>) matches <existing_symbol> (<existing_file>:<line>) [#<dup id>]; remove the copy and commit, or have an agent other than the author call dismiss_duplicate with a reason`.
- `afterCommit`: the open task with `cwd = checkout` whose branch is the checkout's current branch; none → return; else `checkDuplicates` (the caller has just built the graph).
- `dismissDuplicate`: must be `open` (else `BAD_EVIDENCE`); reason not blank; actor with `session_id "unknown"` and no agent → refused; author = `recorded_by` of the task's newest ok commit evidence, else `tasks.created_by`; caller equal to author → `BAD_EVIDENCE` `the task's author can't dismiss its own possible duplicate; ask a reviewer`. Sets `dismissed`, `reason`, `closed_by`, `closed_at`; logs `duplicate_dismissed`.

- [ ] **Step 1: Write failing tests** (`duplicates.test.ts`, real git commits, `writeFakeGraph` written to match the committed files):
  - `normaliseName strips case, separators and one prefix`; `paramCount reads arrow and function forms` (`const iso = (e: Engine) =>` → 1; `function f()` → 0; `function g(a, b: Map<string, number>)` → 2).
  - `a helper written again is flagged`: commit `src/orders/format.ts` adding `formatInvoiceDate(d)` while `src/utils.ts` has it → one open duplicate pointing at `src/utils.ts`.
  - `a different parameter count is not flagged`.
  - `functions in test files are neither checked nor matched`.
  - `a later commit that removes the copy resolves it`.
  - `verify is held back while a duplicate is open` (`runCheck` verify → `BAD_EVIDENCE` with `dismiss_duplicate`); `the author can't dismiss, another agent can, then verify runs`.
  - `with the map off verify runs as before`.
  - `mcp.test.ts`: update tool count to ten; `dismiss_duplicate by the author is refused`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect all PASS.
- [ ] **Step 5: Commit** `engine: post-commit duplicate check holds back verify; dismiss_duplicate`.

### Task 7: estack's map git hooks

**Files:**
- Modify: `engine/src/githooks.ts`, `engine/src/cli.ts`
- Test: `engine/test/githooks.test.ts`, `engine/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 2 `buildGraph`, `checkoutOf`; Task 6 `afterCommit`.
- Produces: `MAP_HOOKS = ["post-commit", "post-checkout", "post-merge", "post-rewrite"]`, installed by `installGitHooks` next to `pre-commit`/`pre-push` with the same chaining; CLI `estack map-hook <name>`.

Behaviour to pin:
- Map hook script: shebang, `MANAGED_MARK`, run any chained `<name>.estack-prev*` hooks ignoring their exit status, the same engine-path fallback as today but a missing engine exits 0 silently, then `nohup node --no-warnings "$engine" map-hook <name> </dev/null >/dev/null 2>&1 &` and `exit 0`. No `CLAUDECODE` check: they run for the owner's commands too.
- `estack map-hook <name>`: not opted in or map off → exit 0. Else `buildGraph(e, checkoutOf(e, cwd))`; for `post-commit` and `post-rewrite` on success, `afterCommit`. Every error is caught, exit 0 (the `map_built` event records failures).

- [ ] **Step 1: Write failing tests:**
  - `githooks.test.ts`: `init installs the four map hooks`; `map hooks run in the background and never check CLAUDECODE` (script contains `nohup`, `&`, `exit 0`, and no `CLAUDECODE`); `an existing post-commit hook is chained`; `a commit returns without waiting for the map` (install hooks with an engine path to a stub script that sleeps 3 s, `git commit` finishes in under 1.5 s).
  - `cli.test.ts`: `map-hook with the map off does nothing and exits 0`; `map-hook outside an opted-in repo exits 0`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect all PASS.
- [ ] **Step 5: Commit** `engine: estack-managed git hooks keep the code map current`.

### Task 8: Setup, `map suggest`, and the agent-facing docs

**Files:**
- Modify: `engine/src/cli.ts`, `engine/src/graph.ts`, `core/skills/setup/SKILL.md`, `core/skills/enterprise-gates/SKILL.md`, `core/skills/poteto-mode/SKILL.md`, `README.md`
- Test: `engine/test/cli.test.ts`, `engine/test/graph.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 7.
- Produces: `export function suggestExcludes(e: Engine, root: string): { glob: string; reason: string }[]` in `graph.ts`; CLI `estack map suggest`; `estack init` options `--code-map <on|off>` and `--exclude <comma-separated globs>`.

Behaviour to pin:
- `suggestExcludes`, from `git ls-files`: folders up to 3 levels deep named `dist`, `build`, `out`, `vendor`, `third_party` or `generated` → `<path>/**` (`named dist`); `.gitattributes` patterns marked `linguist-generated` or `linguist-vendored` → that pattern (`marked linguist-generated`); code files whose first 5 lines contain `@generated`, `Code generated` or `DO NOT EDIT` → the folder's `<dir>/**` when every tracked code file in it is so marked, else the file (`header says generated`). Sorted, unique.
- `estack init`: without `--code-map`, the map is on when `graphifyVersion` is supported, else off, and init prints `code map off: Graphify not found (install with <INSTALL_HINT>, then re-run setup)`. `--exclude` goes into `code_map.exclude`. Init never overwrites an existing `policy.yaml` (unchanged), so these options only apply on first setup. With the map on, init then runs `buildGraph` on the main checkout and prints the build line and the top 10 folder shares.
- `setup/SKILL.md`: a new section before "Run init": check `graphify --version`; if missing or outside `>=0.9.121,<0.10`, show the install command and let the owner choose to install first or set up with the map off; run `estack map suggest` and walk the owner through each suggestion folder by folder, keeping any generated code their own code calls into (a generated database or API client); pass the confirmed list to init. After init, show the folder shares and ask whether any big folder is a copy of other code; if so, give the owner the exact `code_map.exclude` line to add to `policy.yaml` themselves. Extend "Prove it works" with: `start_task` with an `area` returns context; a Read before any search is denied once.
- `enterprise-gates/SKILL.md` table gains rows: reading code before `reuse_check` (call `context_for`/`find_existing` first); `reuse_check` needs your own search; `verify` held back by a possible duplicate (remove the copy, or a reviewer calls `dismiss_duplicate`).
- `poteto-mode/SKILL.md` rules paragraph: pass `area` to `start_task`; tell workers to call `context_for` on their area and `find_existing` before writing a helper; `reuse_check` evidence is their own search plus a one-line conclusion.
- `README.md`: Graphify install line in requirements; phase 5 row `Done`; the code map in a short paragraph (what it shows, what's left out, map off).

- [ ] **Step 1: Write failing tests:** `suggestExcludes finds dist, gitattributes and generated headers`; `init with --code-map off writes enabled false`; `init with --exclude writes the list`; `init without Graphify turns the map off and says how to install` (`fakeExec({ graphify: { code: 127 } })` through `main` needs an injectable exec: add optional `exec` to `Io`).
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement**, edit the docs, `npm run build:claude`.
- [ ] **Step 4: Run** `npm test` and `npm run check:claude`; expect PASS.
- [ ] **Step 5: Commit** `setup: code map on first setup, exclude suggestions, agent docs`.

### Task 9: The `utils.ts` failure, end to end with real Graphify

**Files:**
- Create: `engine/test/codemap.e2e.test.ts`
- Test: same

**Interfaces:**
- Consumes: everything above, through the MCP server (`createServer`) and `runHook`, exactly as an agent would.

- [ ] **Step 1: Write the test** under `describe.skipIf(!HAS_GRAPHIFY)`, in a `makeRepo` fixture with `src/utils.ts` (`formatInvoiceDate(d: Date)`), `src/orders/invoice.ts` using it, and `dist/utils.js` (a generated copy defining `formatInvoiceDate`), `init` with the map on and `exclude: ["dist/**"]`, committed. Task 2 is started by agent W with `area: "src/orders"`:
  - `the second task is shown the helper, never its copy`: start_task's `context.uses` has `formatInvoiceDate` at `src/utils.ts`; nothing in `dist/`.
  - `its worker is sent to the map once and its reviewer never`: W's first Read of `src/utils.ts` denied, second allowed; after `reuse_check`, reviewer R's Read allowed with no denial event.
  - `the duplicate is flagged if written anyway and holds back verify until a different agent dismisses it`: W commits `src/orders/format.ts` with its own `formatInvoiceDate(d)`, run `estack map-hook post-commit` synchronously; `run_check verify` refused; W's `dismiss_duplicate` refused; R's accepted; verify runs.
  - `nothing is matched against the copy`: no duplicate row mentions `dist/`.
  - `with the map off every task type runs end to end`: a second fixture with `--code-map off`: feature, bugfix and refactor tasks complete with notes for `reuse_check`.
- [ ] **Step 2: Run** `npx vitest run engine/test/codemap.e2e.test.ts`; expect PASS (each earlier task already built the parts; fix anything that fails in the owning module).
- [ ] **Step 3: Run** `npm test` and `npm run check:claude`; expect all PASS.
- [ ] **Step 4: Commit** `test: the utils.ts failure, end to end on real Graphify`.

---

## Controller live check (after the final review, not an implementer task)

Install the worktree's plugin (`claude plugin marketplace add <worktree>`), set up a scratch fixture repo like Task 9's with `/estack:setup`, and run headless `claude -p` sessions: one that starts a task with an area and must see `formatInvoiceDate` from `src/utils.ts`; one subagent worker whose first Read is denied once; a commit of a copied helper followed by a `verify` that is refused. Confirm `estack map status` shows the map current after each commit. Then remove the marketplace.
