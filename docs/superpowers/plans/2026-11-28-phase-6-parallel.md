# Phase 6: Parallel work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CTO can run several workers side by side on one feature without two of them building the same shared helper, or silently editing the same file. Each worker works in its own engine-made worktree and merges back into the feature branch; the owner reviews one PR per feature.

**Architecture:**
- **Features and workers.** A feature is the CTO's main task with its own branch and checkout. Worker tasks (`parent_id` = the feature) get engine-made worktrees under the CTO session's checkout, branch from the feature branch, and finish with a `merge` step checked by the engine.
- **Planning.** `plan_tasks` records planned worker tasks with areas, shared-helper names and dependencies, and reports overlaps.
- **Claims.** A claims table holds files, taken automatically on first edit or commit, and shared-helper names. A held file means "check first": the owning CTO (`allow_edit`) or, across two CTOs, the owner (`estack allow`) grants an edit with a reason.
- **Grant outcomes** are recorded for a later learning step.

**Tech Stack:** Existing engine (TypeScript, `node:sqlite`, MCP SDK, zod, vitest), git worktrees, `gh` for merge state.

**Spec:** `docs/superpowers/specs/2026-11-25-estack-engine-design.md`, amendment 2, approved 2026-11-28. Section 10 is the binding text; the relevant changes are in sections 7 (hook table edit row, Stop row, Roles, git hooks, Overrides), 8 (data model), 12, 13 (phase 6 row), 14 and 15.

## Global Constraints

- **Dependencies and generated files:** no new npm dependencies. Use `npm ci`, never `npm install`; `package-lock.json` must not change. Edit `core/` and `engine/`, never `adapters/claude-code/` by hand; regenerate it with `npm run build:claude`, and `npm run check:claude` must pass.
- **Migration:** `MIGRATION_5` and `SCHEMA_VERSION = 5`. Version-4 databases upgrade in place, and existing tasks read as `parent_id` null and `task_group` null.
- **Worktree location:** every engine-made worktree is at `<checkout of the calling session>/.estack/worktrees/<id>-<slug>`. The task row records the absolute path as `cwd`. The engine appends `.estack/worktrees/` to `<git common dir>/info/exclude` when missing, and never edits a tracked file for this.
- **Branch names:** feature `feat/<id>-<slug>`, worker `task/<id>-<slug>`. The slug is the title lowercased, runs of anything outside `[a-z0-9]` turned into `-`, trimmed, at most 40 characters.
- **Bases:**
  - A worker branches from its feature branch's current head.
  - A feature branches from `origin/main` when the repository has an `origin` remote. The engine runs `git fetch origin main` first, time-limited, and ignores a fetch failure. Otherwise it branches from local `main`.
- **Never destroy work:** worktree removal never uses `--force`. A worktree with uncommitted changes is kept, and `status` reports it.
- **Ownership:** a session owns a task when it has a `task_bindings` row with role `cto` for that task or for the task's parent. "Same CTO" means some session owns both tasks.
- **Claims are held relative to the checkout,** with `/` separators. `claims.exempt` defaults to `["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "Gemfile.lock", "composer.lock"]`. Files matching `exempt_paths` are never held.
- **Owner-only CLI commands** (`estack allow`, `estack release`) use `assertOwner`, like `estack override`.
- **Merge state** is checked only by `status`, `plan_tasks`, `start_task` and `complete_step`, never inside per-edit hooks.
- **Content rules:** no em or en dashes in `core/` or `README.md`. Real-Graphify tests use `describe.skipIf(!HAS_GRAPHIFY)`.

## Review Focus

1. **A CTO in the main checkout on `main` starts a feature.** The main checkout must stay on `main`, and the feature gets its own worktree. Owner: Task 2 (`a feature started from the main checkout leaves it on main`).
2. **A worker writes a path without its worktree prefix.** The edit lands in the CTO's checkout. When the feature lives in its own worktree, the main checkout has no open task, so the edit is denied. Owner: Task 5 (`a worker's edit outside its worktree is denied`).
3. **Two workers edit the same free file at nearly the same moment.** Exactly one becomes the holder, the other is denied, and there is never an internal error. Owner: Task 5 (`two tasks racing for a free file: one holds it`).
4. **The worktree being removed has uncommitted work.** It is kept and reported, never force-removed. Owner: Task 3 (`a merged worker's dirty worktree is kept`).
5. **A dependency was cancelled.** The dependent task can't start, and the refusal says the dependency was cancelled and to withdraw or re-plan. Owner: Task 4 (`a task whose dependency was cancelled can't start`).

---

### Task 1: Storage, types, policy

**Files:**
- Modify: `engine/src/db.ts`, `engine/src/types.ts`, `engine/src/policy.ts`, `engine/src/tasks.ts` (view mapping only)
- Test: `engine/test/foundation.test.ts`, plus every test asserting `SCHEMA_VERSION` (grep `toBe(4)` and `value: "4"`)

**Interfaces:**
- Produces:
  ```sql
  -- MIGRATION_5
  ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id);
  ALTER TABLE tasks ADD COLUMN task_group TEXT;
  CREATE TABLE task_areas (task_id INTEGER NOT NULL REFERENCES tasks(id), path TEXT NOT NULL, PRIMARY KEY (task_id, path));
  CREATE TABLE task_deps (task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on INTEGER NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on));
  CREATE TABLE plan_items (task_id INTEGER NOT NULL REFERENCES tasks(id), adds TEXT NOT NULL, PRIMARY KEY (task_id, adds));
  CREATE TABLE overlap_accepts (a INTEGER NOT NULL REFERENCES tasks(id), b INTEGER NOT NULL REFERENCES tasks(id), reason TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (a, b));
  CREATE TABLE claims (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, released_at TEXT);
  CREATE UNIQUE INDEX claims_active ON claims(kind, target) WHERE status = 'active';
  CREATE TABLE claim_grants (id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id), task_id INTEGER NOT NULL REFERENCES tasks(id), path TEXT NOT NULL, reason TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT, outcome_at TEXT);
  CREATE INDEX claim_grants_task_path ON claim_grants(task_id, path);
  ```
  In `overlap_accepts`, `a` is always the smaller task id.
- `TaskStatus` gains `"planned"`. `Task` gains `parent_id: number | null` and `task_group: string | null`. `EvidenceKind` gains `"merged"`. `STEP_EVIDENCE` gains `merge: "merged"`.
- `Policy.commands` gains `worktree_setup?: string`. `Policy.claims: { exempt: string[] }` defaults to the Global Constraints list. Both are added to `defaultPolicyYaml` (`worktree_setup` as a commented example, `claims:` with the default list).
- `ErrorCode` gains `"HELD"`, `"OVERLAP"`, `"DEPENDENCY"`.

- [ ] **Step 1: Write failing tests:**
  - `a version-4 database upgrades to 5 and keeps its rows` (a v4 db with a task and a handover; after opening, schema "5", `parent_id` and `task_group` are null, the six new tables exist)
  - `claims allow one active holder per target` (a second active insert for the same kind+target throws a UNIQUE error; a released one doesn't block)
  - `policy has claims.exempt and worktree_setup defaults`
  - `merge is a known step`, via `parsePolicy` accepting `merge` in a task type
- [ ] **Step 2: Run** `npx vitest run engine/test/foundation.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Update every test that asserts schema version 4 to 5.
- [ ] **Step 4: Run** `npm test`; expect all PASS.
- [ ] **Step 5: Commit** `engine: phase 6 storage, task parent and group, claims, merge step kind`.

### Task 2: Engine-made worktrees for features and workers

**Files:**
- Create: `engine/src/worktree.ts`
- Modify: `engine/src/tasks.ts` (`startTask`), `engine/src/mcp.ts` (`start_task` schema), `engine/src/hooks.ts` (nothing new to stamp; `cwd` is already stamped for `start_task`)
- Test: `engine/test/worktree.test.ts`, `engine/test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  ```ts
  // worktree.ts
  export const WORKTREES_DIR = ".estack/worktrees";
  export const WORKTREE_SETUP_TIMEOUT_MS = 600_000;
  export function slug(title: string): string;
  export function ensureWorktreeExclude(e: Engine): void;   // `.estack/worktrees/` in <common dir>/info/exclude
  export function createWorktree(e: Engine, input: { under: string; name: string; branch: string; base: string }): string;  // absolute path
  export function runWorktreeSetup(e: Engine, cwd: string): { ok: boolean; output_tail: string } | null;  // null when no command
  export function removeWorktree(e: Engine, task: Task): "removed" | "kept" | "missing";
  // tasks.ts
  startTask(e, input: { title; type; goal; done_check; actor; cwd?; branch?;
    worktree?: boolean; parent_task_id?: number; area?: string[]; group?: string; task_id?: number }): TaskView
  ```

Behaviour to pin:
- `worktree: true` and no parent makes a **feature**: branch `feat/<id>-<slug>` from the base in Global Constraints, worktree under `checkoutOf(e, input.cwd ?? e.cwd)`.
- `worktree: true` with `parent_task_id` makes a **worker**:
  - The parent must be open, else `TASK_CLOSED` or `NO_TASK`.
  - Branch `task/<id>-<slug>` from the parent's branch head, worktree under the caller's checkout.
  - The step list is the type's steps with `pr` replaced by `merge`.
  - `task_group` comes from `group`, and areas are inserted into `task_areas`.
- **Without `worktree`,** the task starts as today, but `parent_task_id`, `area` and `group` are still recorded. This is how a studio CTO in its own feature checkout starts its feature task.
- **Insert, then build the worktree:**
  1. Insert the task (to get its id) and commit.
  2. Then run `git worktree add -b <branch> <path> <base>`, `ensureWorktreeExclude` and `runWorktreeSetup`.
  3. Then, in one transaction, set `cwd`, `branch`, `base_sha` (the new branch's head), the steps and the binding.
  - If the git step fails, mark the task `cancelled`, log `worktree_failed` `{error}`, and throw `NOT_A_REPO` with git's message. No open task remains.
- **`worktree_setup` failure:** log `worktree_setup_failed` `{output_tail}`. The task stays open, and the result carries `setup: { ok: false, output_tail }`.
- **Events:** log `worktree_created` `{path, branch, base}`.
- **`task_id`:** starts a planned task. Its row is updated rather than inserted; Task 4 adds the overlap and dependency checks here.
- **MCP `start_task`:** accepts `worktree`, `parent_task_id`, `area` (string array), `group` and `task_id`. Its result adds `worktree_path` and `setup` when they apply. `area[0]` is passed to `taskContext` (phase 5).
- **`removeWorktree`:**
  - `git -C <cwd> status --porcelain` not empty: return `"kept"` and log `worktree_kept`.
  - Clean: run `git worktree remove <cwd>` (no force), then `git branch -d <branch>` from the parent's or the main checkout, and log `worktree_removed`.
  - Path already gone: return `"missing"`.

- [ ] **Step 1: Write failing tests** in `worktree.test.ts`, with real git, `makeRepo` and `initRepo`:
  - `slug makes short branch-safe names` (`"Add invoice totals!"` gives `add-invoice-totals`, and a 60-character title gives 40 characters)
  - `a feature started from the main checkout leaves it on main` (`git branch --show-current` in the main checkout is still `main`, and the feature `cwd` is `<root>/.estack/worktrees/<id>-<slug>` on `feat/<id>-<slug>`)
  - `a worker branches from its feature's head and ends with merge` (a commit on the feature branch first; the worker's `base_sha` equals that commit; its steps end in `merge`, not `pr`)
  - `git ignores the worktrees folder without a tracked change` (`git status --porcelain` in the main checkout is empty after creating two worktrees, and `info/exclude` has the line once)
  - `worktree_setup runs in the new worktree, and its failure is reported` (`commands.worktree_setup: "touch ok"` creates `ok` there; `"exit 3"` gives `setup.ok` false and the task stays open)
  - `a failed worktree leaves no open task` (pre-create the branch name to force a failure)
  - `removeWorktree keeps a dirty worktree and removes a clean one`
  - `mcp.test.ts`: `start_task with worktree returns the worktree path`
- [ ] **Step 2: Run** the test files; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run build:claude` and `npm run check:claude`; expect PASS.
- [ ] **Step 5: Commit** `engine: engine-made worktrees for features and workers`.

### Task 3: Worker binding, the merge step, the push check

**Files:**
- Modify: `engine/src/tasks.ts`, `engine/src/hooks.ts`, `engine/src/mapfirst.ts`, `engine/src/mcp.ts`
- Test: `engine/test/tasks.test.ts`, `engine/test/hooks.test.ts`, `engine/test/mapfirst.test.ts`

**Interfaces:**
- Consumes: Task 2 (`removeWorktree`, worker tasks with `merge`).
- Produces: `export function bindWorker(e: Engine, task_id: number, actor: Actor): void` in tasks.ts. Merge evidence input `{ kind: "merged" }` in `EvidenceInput` and the MCP schema. `export function ownsTask(e: Engine, session_id: string, task_id: number): boolean` in tasks.ts (see Ownership in Global Constraints).

Behaviour to pin:
- **`bindWorker`:** when `actor.agent_id` is set and the task has no binding with that agent id, insert a binding with role `worker`. It is called:
  - from `preEdit`, after the task-in-checkout check passes, for the bound task in that checkout;
  - from `preRead`, when a task in the target's checkout is bound to the session, before the map-first check (so a worker is "on" its task from its first read);
  - by every MCP tool that takes a `task_id`.
- **The merge step** (`checkEvidence` for kind `merged`):
  - The task must have a parent.
  - Take the worker branch head (`git rev-parse refs/heads/<branch>`). It must be an ancestor of `refs/heads/<parent branch>`, checked in the parent's `cwd` with `git merge-base --is-ancestor`. Otherwise `BAD_EVIDENCE`: `task/<…> is not merged into feat/<…> yet; merge it there first (git -C <feature cwd> merge --no-ff <branch>)`.
  - Payload `{ head, into }`.
- **After the merge step completes:** `removeWorktree` runs, `task_merged` `{into}` is logged, and Task 5's claim passing hooks in here.
- **Push check:** in `preBash`, for `git_push`, the branch is taken from the command when it names one:
  - `git -C <dir> push …` uses `<dir>`'s current branch.
  - `git push <remote> <ref>` uses `<ref>` with any `HEAD:` and `refs/heads/` prefix stripped.
  - Otherwise, `ev.cwd`'s current branch.
  - The `pre-push` git hook already checks exact refs and is unchanged.

- [ ] **Step 1: Write failing tests:**
  - `a worker is bound on its first edit, read or task tool call` (agent W edits in the worker worktree, then the bindings have W as `worker`; the same for a Read through `runHook`, and for `status` with `task_id`)
  - `the merge step needs the worker merged into its feature` (refused before `git merge`; after merging in the feature worktree, accepted and the task is done)
  - `a merged worker's dirty worktree is kept, and its clean one is removed`
  - `the push check uses the pushed branch` (with the CTO's checkout on `main` and a task on `feat/x` with verify done, `git push origin feat/x` asks, while `git push origin main` is denied for lack of a task)
  - `a feature's own steps run on the merged result` (a worker merged into the feature; the feature's `implement` accepts the merge commit)
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect PASS.
- [ ] **Step 5: Commit** `engine: workers bind on first touch; merge step; push check on the pushed branch`.

### Task 4: plan_tasks, overlaps, dependencies

**Files:**
- Create: `engine/src/plan.ts`
- Modify: `engine/src/tasks.ts` (`startTask` checks), `engine/src/mcp.ts`, `engine/src/cli.ts` (`status` shows planned tasks)
- Test: `engine/test/plan.test.ts`, `engine/test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, Task 3 `ownsTask`, phase 5 `loadGraph` and `topLevelFunctions`.
- Produces:
  ```ts
  export interface PlanTaskInput { title: string; type: string; goal: string; done_check: string; area: string[]; adds?: string[]; depends_on?: (number | string)[]; group?: string }
  export interface Overlap { a: number; b: number; kind: "area" | "adds" | "exists"; detail: string; resolved: boolean }
  export function planTasks(e: Engine, input: { parent_task_id: number; tasks: PlanTaskInput[]; actor: Actor }): { tasks: TaskView[]; overlaps: Overlap[] };
  export function overlapsFor(e: Engine, task_id: number): Overlap[];          // against every open or planned task
  export function acceptOverlap(e: Engine, input: { a: number; b: number; reason: string; by: string; owner: boolean; actor?: Actor }): void;
  export function withdrawTask(e: Engine, task_id: number, actor: Actor): void;
  export function dependencyState(e: Engine, task_id: number): { finished: boolean; detail: string }[];
  export function mergedIntoMain(e: Engine, task: Task): boolean;
  ```
  MCP tools: `plan_tasks`, `accept_overlap`, `withdraw_task`. In `depends_on`, a string `"#2"` means the second task in the batch.

Behaviour to pin:
- **`planTasks`:**
  - The caller must own the parent, else `NO_TASK`.
  - It inserts each task as `planned` (no steps yet, `parent_id` set, `cwd` = parent's cwd as a placeholder, `branch` empty), with `task_areas`, `plan_items` and `task_deps`.
  - It logs `task_planned` and returns the overlaps, logging `overlap_found` for each unresolved one.
- **What overlaps** (task pairs not in the same `task_group`, and not parent/child):
  - **area:** some area path of one equals or contains, by whole path segments, an area path of the other;
  - **adds:** the same name in both tasks' `plan_items`;
  - **exists:** a name in `plan_items` matches a top-level function name in the parent's checkout graph (`normaliseName` equal). Detail: `reuse <name> at <file>:<line> instead`.
- **Resolved:**
  - a `task_deps` edge in either direction, or an `overlap_accepts` row;
  - `exists` is resolved by accepting, the same as the others.
- **`acceptOverlap`:**
  - With `owner: false`, the actor's session must own both tasks, else `OWNER_ONLY` with `estack allow --task <a> --with <b> --reason <text>`.
  - With `owner: true`, only the CLI calls it, behind `assertOwner`.
  - Logs `overlap_accepted`.
- **`startTask` with `task_id` of a planned task, and any `startTask` given an `area`:**
  - Unresolved overlaps: `OVERLAP`, listing them.
  - Unfinished dependency: `DEPENDENCY`, naming it.
  - Cancelled dependency: `DEPENDENCY` with `task #<id> was cancelled; withdraw this task or plan it again`.
- **When a dependency is finished:**
  - The same parent: its `merge` step is done.
  - Otherwise: `mergedIntoMain` of its feature. That uses `gh pr view <branch> --json state` with `state` MERGED, or failing that `git merge-base --is-ancestor <branch head> origin/main` after a time-limited fetch.
  - Log `dependency_finished` once.
- **`withdrawTask`:** only a planned task the actor owns. Sets `cancelled` and logs `task_withdrawn`.
- **`status`** lists planned tasks under their parent, with their dependencies and open overlaps.

- [ ] **Step 1: Write failing tests:**
  - `plan_tasks records planned tasks and reports area overlaps` (areas `src/orders` and `src/orders/invoice.ts` overlap; `src/orders` and `src/ordersx` don't)
  - `two tasks planning the same helper overlap, and an existing helper says reuse it` (fake graph with `formatInvoiceDate` at `src/utils.ts`)
  - `a dependency resolves the overlap and holds the dependent back until the foundation is merged into the feature`
  - `the CTO accepts an overlap between its own tasks; across CTOs it is the owner's` (the second CTO session gets `OWNER_ONLY`, naming `estack allow`)
  - `starting a task without plan_tasks still checks overlaps`
  - `a task whose dependency was cancelled can't start`
  - `a dependency in another feature waits for main` (fake `gh` returns OPEN, then MERGED)
  - `withdraw_task cancels a planned task`
  - `mcp.test.ts`: the tool count rises by three
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect PASS.
- [ ] **Step 5: Commit** `engine: plan_tasks with overlaps, foundations and dependencies`.

### Task 5: File claims in the edit gate and pre-commit

**Files:**
- Create: `engine/src/claims.ts`
- Modify: `engine/src/hooks.ts` (`preEdit`), `engine/src/githooks.ts` (`preCommit`), `engine/src/tasks.ts` (after `merge`, after cancel through `owner.ts`)
- Test: `engine/test/claims.test.ts`, `engine/test/hooks.test.ts`, `engine/test/githooks.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, Task 3 `bindWorker`, `ownsTask` and the merge completion point.
- Produces:
  ```ts
  export type EditVerdict = { ok: true } | { ok: false; holder: Task; claim_id: number };
  export function isClaimExempt(e: Engine, path: string): boolean;
  export function checkEdit(e: Engine, task: Task, path: string): EditVerdict;   // takes the claim when free
  export function holderOf(e: Engine, path: string): { claim_id: number; task: Task } | null;
  export function passClaims(e: Engine, from: Task, to: Task): void;           // worker -> feature on merge
  export function releaseClaims(e: Engine, task: Task, actor: Actor): void;    // feature merged or task cancelled
  export function hasGrant(e: Engine, task_id: number, path: string): boolean;
  ```

Behaviour to pin:
- **`checkEdit`:**
  - Exempt: `{ok}`.
  - Free: insert an active claim (`kind: "file"`), log `claim_taken`, `{ok}`. A UNIQUE conflict means another task just took it, so re-read the holder.
  - Held by this task, its parent, its child, a task in its group, or with a grant for this task: `{ok}`.
  - Otherwise: deny, and log `claim_denied`.
- **`preEdit`:** after the task-binding check, call `checkEdit` with the path relative to the checkout. The deny message is `<path> is held by task #<id> (goal: <goal>); report to your CTO, which can check it with claim_status and allow it with allow_edit.`
- **`preCommit`:** for each staged path that is not exempt, `checkEdit` for the checkout's open task. Pick the task with the most recent binding when several are open in that checkout. A held path is refused with the same message.
- **After a worker's merge:** `passClaims(worker, feature)` sets `task_id` to the feature and logs `claim_passed`.
- **Releasing:** when a feature is known merged into `main` (Task 4's check, at `status` or `start_task` time), or any task is cancelled, `releaseClaims` sets `released`, logs `claim_released`, and makes the newest grant holder on that path the new holder.
- **Feature cleanup:** a feature known merged into `main` also gets `removeWorktree` (Task 2), when the engine made its worktree (its `cwd` is under `.estack/worktrees/`).

- [ ] **Step 1: Write failing tests:**
  - `the first edit holds a file and another task's edit is denied with the CTO hint`
  - `exempt files and exempt_paths are never held`
  - `a task's own workers and its group are never blocked`
  - `two tasks racing for a free file: one holds it` (two `checkEdit` calls on separate engines over one database: exactly one claim, and the other is denied)
  - `a worker's edit outside its worktree is denied` (feature in its own worktree; a worker Edit with a main-checkout path is denied by the existing no-task message)
  - `pre-commit takes claims for files edited through Bash and refuses held ones`
  - `merge passes the worker's claims to the feature, and a cancelled task releases them`
  - `a release hands the file to the task holding a grant`
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect PASS.
- [ ] **Step 5: Commit** `engine: files are held on first edit; held means check first`.

### Task 6: Deciding: claim_status, allow_edit, estack allow and release, claim_symbol

**Files:**
- Modify: `engine/src/claims.ts`, `engine/src/mcp.ts`, `engine/src/cli.ts`, `engine/src/owner.ts`
- Test: `engine/test/claims.test.ts`, `engine/test/cli.test.ts`, `engine/test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces:
  ```ts
  export interface ClaimStatus { path: string; holder: { task_id: number; title: string; goal: string; cwd: string } | null; diff: string; grants: { task_id: number; reason: string; by: string; at: string }[] }
  export const MAX_CLAIM_DIFF = 8000;
  export function claimStatus(e: Engine, path: string): ClaimStatus;   // diff = git diff <base_sha> -- <path> in the holder's cwd (committed + uncommitted), capped
  export function allowEdit(e: Engine, input: { task_id: number; path: string; reason: string; actor?: Actor; owner: boolean }): void;
  export function releaseClaim(e: Engine, path: string, reason: string): void;   // owner only
  export function claimSymbol(e: Engine, input: { task_id: number; name: string; file: string; actor: Actor }):
    { status: "claimed" } | { status: "exists"; file: string; line: number } | { status: "claimed_by"; task_id: number };
  ```
  MCP tools: `claim_status`, `allow_edit`, `claim_symbol`. CLI commands, owner-only:
  - `estack allow --task <id> --path <path> --reason <text>`
  - `estack allow --task <a> --with <b> --reason <text>`
  - `estack release --path <path> --reason <text>`

Behaviour to pin:
- **`allowEdit`:**
  - With `owner: false`, the actor's session must own both the holder and the task, else `OWNER_ONLY` with the exact `estack allow …` command.
  - Reason not blank.
  - Inserts `claim_grants` and logs `claim_granted` `{path, holder, by}`.
- **`claimSymbol`:**
  - `exists` when a top-level function of that normalised name is in the task's checkout graph.
  - `claimed_by` when an active `new_symbol` claim for the name exists.
  - Otherwise inserts a claim of kind `new_symbol`, target = the name, and logs `symbol_claimed`.
- **`status`** (CLI and MCP) lists active claims (path, holder task) and kept worktrees.

- [ ] **Step 1: Write failing tests:**
  - `claim_status shows the holder's goal and its changes, committed and not`
  - `the owning CTO allows an edit and the task then edits freely`
  - `across CTOs allow_edit names the owner command, and estack allow works from a terminal` (inside `CLAUDECODE=1`, `OWNER_ONLY`)
  - `estack allow --with accepts an overlap across CTOs`
  - `estack release frees a stale hold`
  - `claim_symbol returns the existing helper, another task's claim, or claims it`
  - `status lists claims and kept worktrees`
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run check:claude`; expect PASS.
- [ ] **Step 5: Commit** `engine: claim_status, allow_edit, owner allow and release, claim_symbol`.

### Task 7: The code map across worktrees

**Files:**
- Modify: `engine/src/codemap.ts`, `engine/src/duplicates.ts`
- Test: `engine/test/codemap.test.ts`, `engine/test/duplicates.test.ts`

**Interfaces:**
- Consumes: phase 5 `newFunctions`, `loadGraph`, `topLevelFunctions`; Task 5 claims.
- Produces: `export function inProgressFunctions(e: Engine, exceptTaskId: number | null): { task_id: number; node: GraphNode }[]` in duplicates.ts. It returns the new top-level functions of every other open task whose `cwd` has a graph. `Hit` gains `task_id?: number`.

Behaviour to pin:
- **`find_existing`:** appends matches from `inProgressFunctions`, using the same name scoring. Each is labelled `why` "name", has `task_id`, and its `file` is prefixed `task #<id>: `. They are capped within `MAX_MATCHES`.
- **`who_uses`:** an exact name match in another task's new functions adds a `defined_at` hit with `task_id`.
- **`context_for`:** adds `claims: { path, task_id }[]` for active file claims whose path is inside the area.
- **`checkDuplicates`:** also matches the task's new functions against `inProgressFunctions`, under the same name and parameter rule. The `existing_file` is prefixed `task #<id>: `.

- [ ] **Step 1: Write failing tests:**
  - `find_existing shows a helper another task is adding, labelled with the task`
  - `context_for lists active claims in the area`
  - `the duplicate check flags a helper another open task is already adding`
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect PASS.
- [ ] **Step 5: Commit** `engine: code map and duplicate check see other tasks' work in progress`.

### Task 8: Grant outcomes

**Files:**
- Create: `engine/src/outcomes.ts`
- Modify: `engine/src/checks.ts` (after a failed test or verify), `engine/src/cli.ts` and `engine/src/mcp.ts` (`status` calls the check), `engine/src/tasks.ts` (after `merge`)
- Test: `engine/test/outcomes.test.ts`

**Interfaces:**
- Consumes: Task 6 grants, Task 4 merge state.
- Produces: `export function recordOutcomes(e: Engine): void` (idempotent). It is called from `status`, `complete_step` and `run_check`.

Behaviour to pin, for each grant with a null outcome:
- **`conflict`:**
  - The granted path is listed by `git -C <feature cwd> diff --name-only --diff-filter=U` while a merge is in progress there; or
  - `gh pr view <feature branch> --json mergeable` gives `CONFLICTING`, and the path is in both features' changes.
- **`holder_failed`:** a `command` evidence row with `ok` 0 for the holder's `test` or `verify`, recorded after the grant, where the holder's change (`git diff --name-only <base_sha>`) includes the path.
- **`clean`:** both tasks finished (worker merged, or feature merged into `main`) with neither of the above.
- **Logging:** set `outcome` and `outcome_at`, and log `grant_outcome` `{grant_id, outcome}`.

- [ ] **Step 1: Write failing tests:** `a conflicted merge in the granted file records conflict`; `the holder's failing test after a grant records holder_failed`; `both merged with no trouble records clean`; `outcomes are recorded once`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; expect PASS.
- [ ] **Step 5: Commit** `engine: record what happened after each shared-edit grant`.

### Task 9: Seats, orchestrator, setup and docs

**Files:**
- Modify:
  - `core/agents/ent-backend-engineer.md`, `ent-frontend-engineer.md`, `ent-integration-engineer.md`, `ent-database-engineer.md`, `ent-mobile-engineer.md`, `ent-performance-engineer.md`
  - `core/agents/estack-verifier.md`, `estack-panel-1.md`, `estack-panel-2.md`, `estack-panel-3.md`
  - `core/skills/poteto-mode/SKILL.md`, `core/skills/enterprise-gates/SKILL.md`, `core/skills/setup/SKILL.md`
  - `README.md`, `vitest.config.ts`
- Test: `npm test` (content gate), `npm run check:claude`

Behaviour to pin:
- **Seats:** remove `isolation: worktree` from each seat's frontmatter, and fix any body text that says the seat runs in its own Claude Code worktree.
- **poteto-mode:** a short "Parallel work in an estack repository" passage:
  - Start the feature (`start_task` with `worktree: true` from the main checkout; in a feature checkout, start it there).
  - Plan workers with `plan_tasks`, and resolve overlaps with `depends_on` or `accept_overlap`.
  - Start each worker with `start_task(task_id, worktree: true)`.
  - Dispatch the worker seat with the worktree path, full paths and `git -C`.
  - After its verify and review pass, merge its branch into the feature and complete `merge`.
  - A held-file report goes to `claim_status`, then `allow_edit` or wait. Across CTOs, ask the owner to run `estack allow`.
  - Bakeoff candidates share a `group`.
  - Outside an estack repository, pass `isolation: "worktree"` yourself.
- **enterprise-gates:** table rows for a held file, and for `DEPENDENCY` and `OVERLAP` refusals.
- **setup:** `commands.worktree_setup` (with an example), `claims.exempt`, and telling the owner to exclude `.estack/` in test runners and linters that scan the whole tree.
- **README:**
  - The phase 6 row reads `Done`.
  - New MCP tools and CLI commands.
  - The Stop row no longer mentions claims.
  - One paragraph on features and workers.
- **`vitest.config.ts`:** excludes `.estack/**` and `**/node_modules/**`.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run** `npm test`, `npm run build:claude` and `npm run check:claude`; expect PASS. Also check that no em or en dashes appear.
- [ ] **Step 3: Commit** `docs: phase 6 orchestration, seats without Claude Code isolation, setup`.

### Task 10: Done-when, end to end

**Files:**
- Create: `engine/test/parallel.e2e.test.ts`

**Interfaces:**
- Consumes: everything above, driven through `createServer` (MCP), `runHook` and `main` (CLI), as agents and the owner would. Use a real git repo with a bare `origin`, and script `gh` for PR states.

- [ ] **Step 1: Write the test.** One fixture, CTO `{session_id:"s1"}`, workers W1 and W2 as agents of s1, and a second CTO `{session_id:"s2"}`:
  - `the dependent worker waits for the foundation, then builds on it, and the helper is built once`:
    1. CTO starts a feature, then plans W1 (`adds: ["formatInvoiceDate"]`, area `src/utils.ts`) and W2 (area `src/orders`, `depends_on: ["#1"]`).
    2. `start_task` for W2 fails with `DEPENDENCY`.
    3. W1 writes the helper, then commits, tests, verifies and reviews (a different agent). The CTO merges W1 into the feature and completes `merge`.
    4. W2 now starts. Its worktree contains `src/utils.ts` with the helper. Its `find_existing("format invoice date")` returns `src/utils.ts`, and no duplicate is raised.
  - `a task's own feature never blocks it`: W2's edit to `src/utils.ts` goes through. The feature holds that file after W1's merge, and W2 is the feature's child.
  - `an edit to a held file is denied until the owning CTO allows it`:
    1. s1 starts a second feature F2 with a worker W3.
    2. W3's edit to `src/utils.ts` (held by feature 1) is denied with the CTO hint.
    3. s1's `claim_status` shows feature 1's change, and s1's `allow_edit` for W3 is accepted.
    4. W3's edit goes through.
  - `across two CTOs only the owner can allow`: s2's task is denied; s2's `allow_edit` gives `OWNER_ONLY`; `estack allow` from the CLI works.
  - `the grant and its outcome are recorded` (a clean outcome after both are merged)
  - `the feature ends in one PR containing both workers' work` (`git log feat/<…>` contains both workers' commits; feature `pr` evidence with scripted `gh`)
- [ ] **Step 2: Run**; expect PASS. Fix anything that fails in the module that owns it.
- [ ] **Step 3: Run** `npm test` and `npm run check:claude`; expect PASS.
- [ ] **Step 4: Commit** `test: phase 6 done-when, end to end`.

---

## Controller live check (after the final review)

1. Install the branch's plugin.
2. Make a fixture repo with `/estack:setup`-style init, a bare `origin`, and `commands.worktree_setup` unset.
3. Run one headless `claude -p` CTO session that:
   - starts a feature from the main checkout;
   - plans two workers with a foundation dependency;
   - starts W1 and dispatches it as a subagent with its worktree path;
   - merges W1 and completes `merge`;
   - starts W2, and confirms it sees the helper;
   - has W2 attempt an edit to a file held by another feature, and reports the denial text.
4. Confirm the events and claims in `state.db`.
5. Remove the plugin.
