# Phase 4: Handover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Work survives a full context window. A session can hand a task over as recorded state, and a fresh session picks it up from that state, not a prose summary. The harness also tells the session when its context is getting full, and saves a handover automatically before compaction.

**Architecture:** A `handovers` table (schema migration 2) stores a JSON body for each handover. Most of the body is assembled by the engine from its own tables and from git. The agent adds only the two things only it knows: decisions and open questions. Two new MCP tools, `handover` and `resume`, are wrapped by two slash skills, `/estack:handover` and `/estack:resume <task>`. `resume` also binds the new session to the task, because without that the phase 3 edit gate would refuse the fresh session's edits.

Three hooks drive it:
- `PreCompact` writes an automatic handover.
- `SessionStart` lists waiting handovers. After a compaction it injects the latest handover, so the compacted session gets its state back.
- `UserPromptSubmit` measures context fullness from the transcript and suggests a handover once per step when it passes the policy threshold.

**Tech Stack:** Existing engine (TypeScript, `node:sqlite`, MCP SDK, vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-estack-engine-design.md`. Section 11 (Handover), the hook table rows for `PreCompact` and `SessionStart` in section 7, section 8 (`handovers` table), section 13 phase 4, and section 15 (Context size detection).

## Global Constraints

- **No new dependencies.** Don't run `npm install`; `package-lock.json` must not change.
- **Edit `core/` and `engine/`, never `adapters/claude-code/`.** Regenerate with `npm run build:claude`; `npm run check:claude` must pass.
- **The schema is released, so this is a real migration.** Add `MIGRATION_2` and set `SCHEMA_VERSION = 2`. Existing version-1 databases upgrade in place, and data is never dropped.
- **A handover holds state and pointers, not explanations.** Its body has this shape:
  ```json
  { "task": {"id","title","type","goal","done_check","branch","cwd","base_sha"},
    "steps": [{"name","status","evidence":[{"kind","ok","summary"}]}],
    "next_step": "<name|null>",
    "commits": ["<sha7> <subject>"],          // base_sha..branch, newest first, max 30
    "files": ["<path>"],                       // changed since base_sha, plus uncommitted, plus agent-listed; max 50
    "decisions": [{"what","why"}],
    "open_questions": ["..."],
    "auto": false, "created_at": "...", "from_session": "..." }
  ```
  Each evidence `summary` is one line: a commit sha, a command plus exit code, a PR URL, a review verdict, or the note's first 120 characters.
- **Resume never trusts a summary of code.** The resume output tells the agent to re-read the listed files before changing anything.
- **Context measurement.** Read the session's `transcript_path` and use the newest main-thread assistant entry's `message.usage`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Skip `isSidechain: true` entries. The controller confirmed on 2026-11-28 that these fields are present: a live transcript showed `cache_read_input_tokens` of 654,850.
  - Window size: `policy.handover.window_tokens`, default 200000. The transcript names the model, not its window.
  - Threshold: `policy.handover.threshold`, default 0.5.
  - Read only the last 2 MB of the transcript. Any read or parse failure means "unknown", and nothing is suggested.
- **Context hooks fail open.** `PreCompact`, `SessionStart` and `UserPromptSubmit` never block and never print errors.
- **No em or en dashes** in `core/` text files.

## Review Focus

1. **Upgrading an existing database.** A version-1 `state.db` with tasks in it opens under the new engine, becomes version 2, and keeps every row. Owner: Task 1.
2. **Resuming in a fresh session actually works end to end.** After `resume`, the phase 3 edit gate allows that session's code edits on the task. Owner: Task 2.
3. **The nudge is helpful, not noisy.** It appears at most once per task step, never below the threshold, never when the transcript can't be read, and never for a session with no bound task. Owner: Task 3.
4. **PreCompact never loses data and never blocks.** It writes one automatic handover per bound open task, and a failure is silent. Owner: Task 3.
5. **Big repos don't bloat a handover.** Commits are capped at 30 and files at 50, with a `"+N more"` marker. Owner: Task 1.

---

## File structure

| Path | Responsibility |
|---|---|
| `engine/src/db.ts` | Modified: `MIGRATION_2` (handovers table), `SCHEMA_VERSION = 2` |
| `engine/src/handover.ts` | Build, store, list and consume handovers |
| `engine/src/context.ts` | Read context usage from a transcript |
| `engine/src/policy.ts` | Modified: optional `handover: { threshold, window_tokens }` |
| `engine/src/mcp.ts` | Modified: `handover`, `resume` tools |
| `engine/src/cli.ts` | Modified: `estack handovers` (list) |
| `engine/src/hooks.ts` | Modified: `preCompact`; `sessionStart` and `userPromptSubmit` extended |
| `engine/test/handover.test.ts`, `context.test.ts`, plus additions to `hooks.test.ts` and `mcp.test.ts` | Tests |
| `core/hooks/hooks.json` | Modified: `PreCompact` entry |
| `core/skills/handover/SKILL.md`, `core/skills/resume/SKILL.md` | The two slash commands |
| `core/skills/poteto-mode/SKILL.md`, `README.md`, `core/skills/setup/SKILL.md` | Modified: when to hand over, and the policy keys |

---

### Task 1: Handover storage and assembly

**Files:**
- Create: `engine/src/handover.ts`, `engine/test/handover.test.ts`
- Modify: `engine/src/db.ts`

**Interfaces:**
- Consumes: `getTask`, `TaskView`, `runBounded`, `tx`, `logEvent` from `tasks.ts`; `Engine`; `Actor`, `actorId`.
- Produces:
  ```ts
  // db.ts
  export const SCHEMA_VERSION = 2;
  // MIGRATION_2:
  // CREATE TABLE handovers (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
  //   from_session TEXT NOT NULL, created_at TEXT NOT NULL, body_json TEXT NOT NULL, auto INTEGER NOT NULL,
  //   consumed_by TEXT, consumed_at TEXT);
  // handover.ts
  export interface HandoverBody { /* exactly the Global Constraints shape */ }
  export interface Handover { id: number; task_id: number; from_session: string; created_at: string;
    auto: boolean; consumed_by: string | null; consumed_at: string | null; body: HandoverBody }
  export const MAX_COMMITS = 30, MAX_FILES = 50;
  export function buildHandover(e: Engine, task_id: number, input: { decisions?: {what: string; why: string}[];
    open_questions?: string[]; files?: string[] }, actor: Actor, auto?: boolean): HandoverBody;
  export function saveHandover(e: Engine, task_id: number, input: Parameters<typeof buildHandover>[2],
    actor: Actor, auto?: boolean): Handover;              // builds, inserts, logs "handover" event
  export function latestHandover(e: Engine, task_id: number): Handover | null;
  export function pendingHandovers(e: Engine): Handover[]; // newest unconsumed per open task
  export function consumeHandover(e: Engine, task_id: number, actor: Actor): { handover: Handover | null; view: TaskView };
  // consume: TASK_CLOSED if the task isn't open; marks the latest unconsumed handover consumed (if any);
  // inserts a task_bindings row for actor (role "cto" or "worker" by agent_id) unless one already exists;
  // logs "resumed"; returns the handover (or null) and the task view.
  ```
  How `buildHandover` gathers its parts:
  - **Commits:** `git log --format=%h %s <base_sha>..refs/heads/<branch>` in `task.cwd`, through `runBounded` with the 5 s hook timeout.
  - **Files:** `git diff --name-only <base_sha>..refs/heads/<branch>`, plus `git status --porcelain` paths in `task.cwd`, plus `input.files`. De-duplicated, then sorted.
  - **On git failure:** the field is empty and the body gets `"git_error": "<message>"`. It never throws.

- [ ] **Step 1: Write the failing tests** in `engine/test/handover.test.ts`. Use a real temp repo from `makeRepo` and `initRepo`, and `startTask`:
  ```ts
  test("a version-1 database upgrades to 2 and keeps its rows", ...)
      // create a db with MIGRATION_1 only + a task row; openDb -> schema_version "2", handovers table exists, task row intact
  test("a handover holds the task, steps with evidence summaries, next step, commits and files", ...)
      // feature task, complete plan (note), make a commit, edit an uncommitted file -> body fields as specified
  test("decisions, open questions and extra files come from the caller", ...)
  test("commits and files are capped with a '+N more' marker", ...)   // 35 commits -> 30 + "+5 more"
  test("a git failure leaves commits/files empty and records git_error, without throwing", ...)
  test("pending lists the newest unconsumed handover per open task", ...)
  test("consume binds the new session, marks the handover consumed and logs resumed", ...)
      // then the binding exists for the new session_id; latestHandover().consumed_by === actor id
  test("consume on a closed task is TASK_CLOSED", ...)
  test("consume with no handover still binds and returns the view", ...)
  ```

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run engine/test/handover.test.ts`. Expected: FAIL, because `../src/handover` doesn't exist.

- [ ] **Step 3: Implement** `MIGRATION_2` and `handover.ts`.

- [ ] **Step 4: Run them and confirm they pass**, then run `npm test` and `npx tsc -p .`.

- [ ] **Step 5: Commit.** `git commit -m "engine: handovers table and assembly"`

---

### Task 2: MCP tools and CLI

**Files:**
- Modify: `engine/src/mcp.ts`, `engine/src/cli.ts`, `engine/src/hooks.ts` (stamping list), `engine/test/mcp.test.ts`, `engine/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1's `saveHandover`, `consumeHandover`, `pendingHandovers`.
- Produces:
  - MCP tool `handover`, with input `{ task_id, decisions?: [{what, why}], open_questions?: string[], files?: string[], actor? }`. It returns the saved `Handover`.
  - MCP tool `resume`, with input `{ task_id, actor? }`. It returns `{ handover, view, instructions }`. `instructions` is exactly:
    `"Re-read every file in handover.body.files before changing anything; do not trust a summary of code. Your next step is <next_step>."`
    When there's no next step: `"... The task has no remaining steps."`
  - The PreToolUse stamping in `hooks.ts` already covers `mcp__plugin_estack_estack__*`, so `actor` is stamped for both new tools. Add a test that confirms it for `resume`.
  - CLI `estack handovers [--json]` lists the pending handovers. Each line is `#<task> <created_at> from <session> auto|manual next: <step>`, and "no pending handovers" when there are none.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  // mcp.test.ts
  test("lists six tools", ...)    // ["complete_step","handover","resume","run_check","start_task","status"]
  test("handover then resume in a different session: resume returns the body and the new session can edit", ...)
      // session s1 starts a feature task, completes plan, calls handover with one decision;
      // session s2 calls resume -> handover.body.decisions[0].what matches, instructions mention re-reading files;
      // then runHook("pre-tool-use", Write src/x.ts as session s2) returns null (allowed)
  test("resume on an unknown task is NO_TASK as a tool error", ...)
  // cli.test.ts
  test("estack handovers lists pending handovers, else says none", ...)
  // hooks.test.ts
  test("resume calls get the real actor stamped", ...)
  ```

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them and confirm they pass**, then run `npm test` and `npx tsc -p .`.

- [ ] **Step 5: Commit.** `git commit -m "engine: handover and resume MCP tools, estack handovers"`

---

### Task 3: Context measurement and the handover hooks

**Files:**
- Create: `engine/src/context.ts`, `engine/test/context.test.ts`
- Modify: `engine/src/policy.ts`, `engine/src/hooks.ts`, `engine/test/hooks.test.ts`, `core/hooks/hooks.json`

**Interfaces:**
- Consumes: Task 1's `saveHandover`, `latestHandover`, `pendingHandovers`; the existing `boundTasks` and `ctxOut` in `hooks.ts`.
- Produces:
  ```ts
  // context.ts
  export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
  export function contextTokens(transcriptPath: string): number | null;   // newest main-thread assistant usage sum
  export function contextRatio(transcriptPath: string | undefined, windowTokens: number): number | null;
  // policy.ts: Policy gains handover: { threshold: number; window_tokens: number } with defaults 0.5 and 200000;
  //   threshold must be in (0, 1], window_tokens a positive integer, else POLICY_INVALID naming the key.
  //   The key is optional in the YAML; DEFAULT_POLICY_YAML gains a commented example block.
  // hooks.ts
  export function preCompact(e: Engine, ev: HookEvent): HookOutput;      // always null
  ```
  `HookEvent` gains `transcript_path?: string` and `trigger?: string`.

  Rules:
  - **`preCompact`:** for each open task bound to this session, `saveHandover(e, id, {}, actor, true)`. Return `null`. Errors are swallowed per task.
  - **`sessionStart`:**
    - Keep the existing header and task lines.
    - Append `handover waiting for #N (<created_at>, auto|manual): run /estack:resume N` for each pending handover. Cap the list at 10.
    - When `ev.source === "compact"`: for each open task bound to this session, append the compact form of its latest handover (`task`, `next_step`, `decisions`, `open_questions`, `files`). Add the line `estack: context was compacted; this is the recorded state of your task. Re-read the listed files before changing anything.`
  - **`userPromptSubmit`:**
    - Keep the existing next-step line.
    - If the session has a bound task with a next step, and `contextRatio(ev.transcript_path, policy.handover.window_tokens) >= policy.handover.threshold`, and no `handover_suggested` event exists for (task, step), then log `handover_suggested` with payload `{task_id, step, ratio}` and append:
      `estack: context is <pct>% full. When the current step is done, run /estack:handover, then continue in a fresh session with /estack:resume <id>.`
    - `<pct>` is the rounded integer.
  - **`runHook`:** route `pre-compact` to `preCompact`. Context hooks stay fail-open.
  - **`hooks.json`:** add `PreCompact`, with no matcher, running `"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/estack-hook.sh" pre-compact`, timeout 30.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  // context.test.ts (write small JSONL fixtures to a temp file)
  test("sums input, cache read and cache creation tokens of the newest main-thread assistant entry", ...)
  test("sidechain entries are ignored", ...)
  test("a missing, empty or malformed transcript is null", ...)
  test("only the tail of a large transcript is read", ...)   // 3 MB of filler before the last entry -> still found
  test("ratio uses the window", ...)                       // 100000 tokens, window 200000 -> 0.5
  // policy (foundation.test.ts or a new block)
  test("handover settings default to 0.5 and 200000 and reject bad values", ...)
  // hooks.test.ts
  test("pre-compact writes one auto handover per bound open task and returns nothing", ...)
  test("session start lists waiting handovers", ...)
  test("session start after compaction injects the recorded state of the session's task", ...)
  test("prompt submit suggests a handover once per step above the threshold", ...)
      // fixture transcript at 60% -> suggestion; second prompt same step -> no suggestion; after completing the step -> suggests again
  test("prompt submit stays quiet below the threshold or when the transcript can't be read", ...)
  ```

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them and confirm they pass**, then run `npm test` and `npx tsc -p .`.

- [ ] **Step 5: Commit.** `git commit -m "engine: context measurement, PreCompact handover, resume hints"`

---

### Task 4: Slash commands, docs, plugin wiring, live check

**Files:**
- Create: `core/skills/handover/SKILL.md`, `core/skills/resume/SKILL.md`
- Modify: `core/skills/poteto-mode/SKILL.md`, `core/skills/setup/SKILL.md`, `README.md`, `core/scripts/selftest.py` (if the hook check needs the new event)
- Regenerate: `adapters/claude-code/`

**Interfaces:**
- **`/estack:handover`** (`core/skills/handover/SKILL.md`). Follow the frontmatter and manual-only conventions of the other estack skills; the selftest enforces them, so read `core/scripts/selftest.py` first. The skill tells the agent to:
  1. find its bound task (`status`); if there is none, say so and stop;
  2. call `handover` with the decisions it made and why, its open questions, and any files that matter beyond the changed ones;
  3. tell the owner, in two lines, to start a fresh session (`/clear` or a new terminal) and run `/estack:resume <id>`.

  It must not summarise code in prose.
- **`/estack:resume <task>`** (`core/skills/resume/SKILL.md`). The skill tells the agent to:
  1. call `resume` with the task id (if no id is given, call `status` and list the waiting handovers instead);
  2. read every file in `handover.body.files`;
  3. state the goal, the done check and the next step in three lines;
  4. continue with the next step under poteto-mode's rules.
- **`poteto-mode/SKILL.md`:** one short paragraph. When the engine says context is filling, finish the current step, then hand over; never hand over mid-step. After compaction, trust the injected recorded state and re-read files.
- **`setup/SKILL.md`:** mention the optional `handover:` policy keys (`threshold`, `window_tokens`). Tell owners on a 1M-token context model to set `window_tokens: 1000000`.
- **`README.md`:**
  - a short "Handover" subsection under Engine;
  - add `PreCompact` to the Hooks table;
  - mark phase 4 "Done" in the roadmap table.

- [ ] **Step 1: Check the selftest catches the new pieces.** Extend `selftest.py` if its hook check lists events, so `PreCompact` is required. Then run `npm run build:claude && (cd adapters/claude-code && bash scripts/selftest.sh)` before adding the skill files. Expected: FAIL, if the selftest requires the hook entry or skill conventions not yet present.

- [ ] **Step 2: Implement** the two skills and the doc changes, then regenerate.

- [ ] **Step 3: Run every check.** `npm run build:claude && npm test && npx tsc -p . && npm run check:claude && (cd adapters/claude-code && bash scripts/selftest.sh)`. Expected: all pass.

- [ ] **Step 4: Live check.** The controller runs this, because it installs the plugin into the owner's Claude Code config. In a scratch repo with the plugin installed and `.estack/` committed by the owner:
  1. Session A (`claude -p`): start a feature task, complete `plan` with a note, then run `/estack:handover` with one decision.
  2. Confirm `estack handovers` lists it.
  3. Session B (a new `claude -p`): run `/estack:resume <id>`. Expected: it states the goal and the next step `reuse_check`, and a code edit for the task is allowed. The binding row shows session B's real id.
  4. Remove the marketplace.

  Record the results in the commit message.

- [ ] **Step 5: Commit.** `git commit -m "Handover and resume slash commands; docs"`
