# Phase 4: Handover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Work survives a full context window. The CTO session, or a worker, can hand its work over as recorded state. After `/clear`, the fresh session picks it up from that state automatically, not from a prose summary. The harness also says when to switch, and protects task state around any compaction.

**Architecture:** A `handovers` table (schema migration 2) stores two kinds of handover:

- A **task** handover: one task's state, used by workers.
- A **session** handover: the CTO's whole state. That is every open task the session owns, plus the owner's goal, the remaining plan, decisions and open questions.

Most of each body is assembled by the engine from its tables and from git. The agent supplies only what it alone knows. Two MCP tools, `handover` and `resume`, take an optional task id. Without one, they work at session level. `resume` re-binds the task or tasks to the new session, because the phase 3 edit gate is per session.

Hooks:
- `PreCompact` saves an automatic session handover.
- `SessionStart` does three things. After a compaction, it re-injects the recorded state. After `/clear` or at startup, it tells the agent to resume a single waiting handover. If several are waiting, it lists them.
- `UserPromptSubmit` measures context fullness from the transcript. Once per step, past the threshold, it suggests: finish the step, hand over, `/clear`.

**Why a fresh session and not `/compact` (owner decision, 2026-11-28):** Anthropic's guidance for long-running agents is to keep state outside the model and start fresh context windows rather than compacting, since compaction is a lossy prose summary. Models also degrade well before the window is full. `/compact` stays available for when the conversation itself is worth keeping, and auto-compaction stays the safety net. The engine saves and restores task state around both.

**Tech Stack:** Existing engine (TypeScript, `node:sqlite`, MCP SDK, vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-estack-engine-design.md` section 11 (Handover), section 7 hook table (`PreCompact`, `SessionStart`), section 8 (`handovers` table), section 12 (CTO session), section 13 phase 4, section 15 (Context size detection). This plan extends section 11 with session-level handovers, per the owner's 2026-11-28 decision.

## Global Constraints

- **Dependencies:** no new dependencies. Don't run `npm install`; `package-lock.json` must not change.
- **What to edit:** edit `core/` and `engine/`, never `adapters/claude-code/`. Regenerate with `npm run build:claude`; `npm run check:claude` must pass.
- **This is a real migration.** Add `MIGRATION_2` and set `SCHEMA_VERSION = 2`. Existing version-1 databases upgrade in place without losing data.
- **Handovers hold state and pointers, not explanations.** Body shapes:
  ```json
  // shared by both kinds
  { "kind": "task"|"session", "auto": false, "created_at": "...", "from_session": "...",
    "decisions": [{"what","why"}], "open_questions": ["..."] }
  // kind "task" adds
  { "task": {"id","title","type","goal","done_check","branch","cwd","base_sha"},
    "steps": [{"name","status","evidence":[{"kind","ok","summary"}]}],
    "next_step": "<name|null>",
    "commits": ["<sha7> <subject>"],      // base_sha..branch, newest first, max 30, then "+N more"
    "files": ["<path>"] }                  // changed since base_sha + uncommitted + agent-listed, max 50, then "+N more"
  // kind "session" adds
  { "goal": "<owner's goal for the session>",
    "plan": ["<remaining work not yet started as a task>"],
    "tasks": [ <the kind-"task" body of each open task bound to the session> ] }
  ```
  Each evidence `summary` is one line: a commit sha, a command plus exit code, a PR URL, a review verdict, or the note's first 120 characters.
- **Resume never trusts a summary of code.** Every resume answer tells the agent to re-read the listed files before changing anything.
- **Context measurement:**
  - **What to read:** the session's `transcript_path`, taking the newest main-thread assistant entry's `message.usage` and adding `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Skip `isSidechain: true` entries. (The controller confirmed these fields exist in a live transcript.)
  - **Window:** `policy.handover.window_tokens`, default 200000.
  - **Threshold:** `policy.handover.threshold`, default 0.5.
  - **How much:** read only the last 2 MB.
  - **Failures:** any failure means "unknown", and nothing is suggested.
- **Context hooks fail open.** `PreCompact`, `SessionStart` and `UserPromptSubmit` never block and never print errors.
- **Writing style:** no em or en dashes in `core/` text files.

## Review Focus

1. **Upgrading an existing database.** A version-1 `state.db` with tasks becomes version 2 and keeps every row. Owner: Task 1.
2. **A fresh session takes over all of the CTO's work.** After a session-level resume, the new session's code edits are allowed on every open task the old session owned, and nowhere else. Owner: Task 2.
3. **Workers first.** A session handover is refused while a worker is still mid-task, unless the CTO states the workers are done. Owner: Task 2.
4. **The nudge is helpful, not noisy.** It appears at most once per task step, and never below the threshold, with an unreadable transcript, or with no bound task. Owner: Task 3.
5. **Auto-resume never guesses.** After `/clear` it resumes only when exactly one handover is waiting. With several it lists them and asks the owner. Owner: Task 3.

---

## File structure

| Path | Responsibility |
|---|---|
| `engine/src/db.ts` | Modified: `MIGRATION_2`, `SCHEMA_VERSION = 2` |
| `engine/src/handover.ts` | Build, store, list and consume task and session handovers |
| `engine/src/context.ts` | Context usage from a transcript |
| `engine/src/policy.ts` | Modified: optional `handover: { threshold, window_tokens }` |
| `engine/src/mcp.ts` | Modified: `handover`, `resume` tools |
| `engine/src/cli.ts` | Modified: `estack handovers` |
| `engine/src/hooks.ts` | Modified: `preCompact`; `sessionStart` and `userPromptSubmit` extended |
| `engine/test/handover.test.ts`, `context.test.ts`, plus additions to existing tests | Tests |
| `core/hooks/hooks.json` | Modified: `PreCompact` |
| `core/skills/handover/SKILL.md`, `core/skills/resume/SKILL.md` | Slash commands |
| `core/skills/poteto-mode/SKILL.md`, `core/skills/setup/SKILL.md`, `README.md` | Docs |

---

### Task 1: Handover storage and assembly

**Files:**
- Create: `engine/src/handover.ts`, `engine/test/handover.test.ts`
- Modify: `engine/src/db.ts`

**Interfaces:**
- Consumes: `getTask`, `listOpen`, `TaskView`, `runBounded`, `tx`, `logEvent` from `tasks.ts`; `Engine`; `Actor`, `actorId`.
- Produces:
  ```ts
  // db.ts — MIGRATION_2:
  // CREATE TABLE handovers (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, task_id INTEGER REFERENCES tasks(id),
  //   from_session TEXT NOT NULL, created_at TEXT NOT NULL, auto INTEGER NOT NULL, body_json TEXT NOT NULL,
  //   consumed_by TEXT, consumed_at TEXT);          -- task_id NULL for kind 'session'
  export const SCHEMA_VERSION = 2;
  // handover.ts
  export type HandoverKind = "task" | "session";
  export interface TaskHandoverBody { /* Global Constraints, kind "task" */ }
  export interface SessionHandoverBody { /* Global Constraints, kind "session" */ }
  export interface Handover { id: number; kind: HandoverKind; task_id: number | null; from_session: string;
    created_at: string; auto: boolean; consumed_by: string | null; consumed_at: string | null;
    body: TaskHandoverBody | SessionHandoverBody }
  export interface HandoverInput { goal?: string; plan?: string[]; decisions?: {what: string; why: string}[];
    open_questions?: string[]; files?: string[]; workers_done?: boolean }
  export const MAX_COMMITS = 30, MAX_FILES = 50;
  export function sessionTasks(e: Engine, session_id: string): TaskView[];   // open tasks bound to the session
  export function busyWorkerTasks(e: Engine, session_id: string): TaskView[];
      // open tasks bound to this session with an agent_id binding whose next step is at or before "test"
      // in the task's step list (worker's part unfinished)
  export function saveTaskHandover(e: Engine, task_id: number, input: HandoverInput, actor: Actor, auto?: boolean): Handover;
  export function saveSessionHandover(e: Engine, input: HandoverInput, actor: Actor, auto?: boolean): Handover;
      // throws BAD_EVIDENCE listing busy worker tasks ("#N next: <step>") unless input.workers_done or auto
      // auto: goal/plan/decisions/open_questions copied from this session's latest earlier session handover, if any
  export function pendingHandovers(e: Engine): Handover[];
      // unconsumed; newest session handover per from_session + newest task handover per open task not
      // covered by a newer pending session handover
  export function latestSessionHandover(e: Engine, session_id: string): Handover | null;
  export function consumeHandover(e: Engine, actor: Actor, task_id?: number):
    { handover: Handover | null; views: TaskView[] };
      // with task_id: TASK_CLOSED if not open; consume latest unconsumed task handover (if any); bind actor to it.
      // without: consume the newest pending session handover (NO_TASK "no session handover waiting" if none);
      // bind actor to every task in its body that is still open. Bindings: role "cto" without agent_id,
      // "worker" with; skip if already bound. Logs "resumed". Returns views of the bound tasks.
  ```
  `buildTaskBody` details:
  - **Commits:** `git log --format=%h %s <base_sha>..refs/heads/<branch>`, run in `task.cwd` through `runBounded` with the 5 s hook timeout.
  - **Files:** `git diff --name-only <base_sha>..refs/heads/<branch>`, plus the paths from `git status --porcelain`, plus `input.files`. De-duplicate and sort.
  - **Git failures:** if git fails, those fields are empty and the body gets `"git_error"`. It never throws.

- [ ] **Step 1: Write the failing tests** in `engine/test/handover.test.ts`. Use real temp repos.
  ```ts
  test("a version-1 database upgrades to 2 and keeps its rows", ...)
  test("a task handover holds task, steps with evidence summaries, next step, commits and files", ...)
  test("commits and files are capped with a '+N more' marker", ...)
  test("a git failure leaves commits/files empty with git_error, without throwing", ...)
  test("a session handover holds the goal, plan, decisions and every open task of the session", ...)
  test("a session handover is refused while a worker is mid-task, and allowed with workers_done", ...)
      // worker-bound task at "implement" -> BAD_EVIDENCE listing "#N next: implement"; workers_done:true -> saved
  test("an auto session handover carries goal and plan forward from the previous one", ...)
  test("pending lists session handovers and task handovers not covered by a newer session handover", ...)
  test("resuming a session handover binds the new session to every open task in it", ...)
  test("resuming a task handover binds one task; on a closed task it is TASK_CLOSED", ...)
  test("resuming with nothing waiting is NO_TASK", ...)
  ```

- [ ] **Step 2: Run them and confirm they fail.** `npx vitest run engine/test/handover.test.ts`.

- [ ] **Step 3: Implement** the migration and `handover.ts`.

- [ ] **Step 4: Run them and confirm they pass**, then run `npm test` and `npx tsc -p .`.

- [ ] **Step 5: Commit.** `git commit -m "engine: handovers table, task and session handovers"`

---

### Task 2: MCP tools and CLI

**Files:**
- Modify: `engine/src/mcp.ts`, `engine/src/cli.ts`, `engine/test/mcp.test.ts`, `engine/test/cli.test.ts`, `engine/test/hooks.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - **MCP tool `handover`.** Input: `{ task_id?, goal?, plan?, decisions?, open_questions?, files?, workers_done?, actor? }`. With `task_id` it saves a task handover; without, a session handover. Either way it returns the `Handover` plus `next`, the exact string:
    `"Handover saved. Tell the owner: run /clear; the new session will load this automatically."`
  - **MCP tool `resume`.** Input: `{ task_id?, actor? }`. It calls `consumeHandover` and returns `{ handover, views, instructions }`. The `instructions` string is:
    `"Re-read every file listed in the handover before changing anything; do not trust a summary of code. Goal: <goal or task goal>. Next: <next steps per task, '#N <step>'>."`
  - **Actor stamping:** the PreToolUse stamping (`mcp__plugin_estack_estack__*`) already covers both tools. Add a test for `resume`.
  - **CLI `estack handovers [--json]`.** Lists pending handovers, one line each:
    `<session|#task> <created_at> from <session> auto|manual next: <...>`
    Prints `no pending handovers` when there are none.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  // mcp.test.ts
  test("lists six tools", ...)    // complete_step, handover, resume, run_check, start_task, status
  test("CTO handover in session s1, resume in s2: s2 gets goal and plan and can edit every task of s1", ...)
      // s1 starts two feature tasks, completes plan on one, handover {goal, plan:["UI later"], decisions:[...] };
      // s2 resume -> handover.body.goal, plan; views has both tasks; runHook pre-tool-use Write for each task's
      // worktree file as s2 -> null; a third session s3 is still denied
  test("handover refuses while a worker is mid-task and names it", ...)
  test("resume with nothing waiting is a NO_TASK tool error", ...)
  // cli.test.ts
  test("estack handovers lists pending handovers, else says none", ...)
  // hooks.test.ts
  test("resume calls get the real actor stamped", ...)
  ```

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them and confirm they pass**, then run `npm test` and `npx tsc -p .`.

- [ ] **Step 5: Commit.** `git commit -m "engine: handover and resume tools, estack handovers"`

---

### Task 3: Context measurement and the handover hooks

**Files:**
- Create: `engine/src/context.ts`, `engine/test/context.test.ts`
- Modify: `engine/src/policy.ts`, `engine/src/hooks.ts`, `engine/test/hooks.test.ts`, `core/hooks/hooks.json`

**Interfaces:**
- Consumes: Task 1 (`saveSessionHandover`, `latestSessionHandover`, `pendingHandovers`, `sessionTasks`); the existing `boundTasks` and `ctxOut`.
- Produces:
  ```ts
  // context.ts
  export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
  export function contextTokens(transcriptPath: string): number | null;
  export function contextRatio(transcriptPath: string | undefined, windowTokens: number): number | null;
  // policy.ts: Policy.handover: { threshold: number; window_tokens: number } (defaults 0.5, 200000;
  //   threshold in (0,1], window_tokens positive integer, else POLICY_INVALID naming the key);
  //   DEFAULT_POLICY_YAML gains a commented example block for it.
  // hooks.ts
  export function preCompact(e: Engine, ev: HookEvent): HookOutput;     // always null
  ```
  `HookEvent` gains `transcript_path?: string` and `trigger?: string`.

  Rules:
  - **`preCompact`:** if the session has open bound tasks, save an auto session handover (`saveSessionHandover(e, {}, actor, true)`) and return `null`. Errors are swallowed.
  - **`sessionStart`:** keep the existing header and task lines, then add the following.
    - **`source === "compact"`:** append this session's latest session handover in compact form (goal, plan, per task `#N next: <step>`, decisions, open questions, files). Add the line:
      `estack: context was compacted; this is the recorded state of your work. Re-read the listed files before changing anything.`
    - **Otherwise** (startup, clear, resume), with exactly one pending handover, append:
      `estack: a handover is waiting (<session|#N>, <created_at>). Call the resume tool now<" with task_id N" for a task handover>, then re-read the files it lists and continue.`
    - **More than one pending:** list them, capped at 10, and append:
      `estack: several handovers are waiting; ask the owner which to resume.`
  - **`userPromptSubmit`:** keep the existing next-step line. Then, if all of these hold:
    - the session has a bound task with a next step;
    - `contextRatio(ev.transcript_path, policy.handover.window_tokens) >= policy.handover.threshold`;
    - no `handover_suggested` event exists for (task, step);

    log `handover_suggested` with payload `{task_id, step, ratio}` and append:
    `estack: context is <pct>% full. Finish the current step and collect any running workers, then call the handover tool and tell the owner to run /clear; the new session picks up automatically. Use /compact instead only if the conversation itself must be kept.`
  - **`runHook`:** route `pre-compact`.
  - **`hooks.json`:** add `PreCompact` with no matcher, running `"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/estack-hook.sh" pre-compact`, timeout 30.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  // context.test.ts
  test("sums input, cache read and cache creation tokens of the newest main-thread assistant entry", ...)
  test("sidechain entries are ignored", ...)
  test("a missing, empty or malformed transcript is null", ...)
  test("only the tail of a large transcript is read", ...)
  test("ratio uses the window", ...)
  // policy
  test("handover settings default to 0.5 and 200000 and reject bad values", ...)
  // hooks.test.ts
  test("pre-compact saves one auto session handover and returns nothing", ...)
  test("after compaction, session start injects the recorded state", ...)
  test("after /clear with one waiting handover, session start tells the agent to resume it", ...)
  test("with several waiting handovers, session start lists them and says to ask the owner", ...)
  test("prompt submit suggests a handover once per step above the threshold", ...)
  test("prompt submit stays quiet below the threshold or when the transcript can't be read", ...)
  ```

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them and confirm they pass**, then run `npm test` and `npx tsc -p .`.

- [ ] **Step 5: Commit.** `git commit -m "engine: context measurement, PreCompact handover, auto-resume hints"`

---

### Task 4: Slash commands, docs, plugin wiring, live check

**Files:**
- Create: `core/skills/handover/SKILL.md`, `core/skills/resume/SKILL.md`
- Modify: `core/skills/poteto-mode/SKILL.md`, `core/skills/setup/SKILL.md`, `README.md`, `core/scripts/selftest.py` (if its hook check lists events)
- Regenerate: `adapters/claude-code/`

**Interfaces:**
- **`/estack:handover [task]`.** Follow the frontmatter and manual-only conventions of the other estack skills; read `core/scripts/selftest.py` first. The skill tells the agent:
  1. As the CTO with no task id: stop dispatching new work and wait for running workers to report. Review what they returned.
  2. Call `handover` with:
     - the owner's goal
     - the remaining plan (work not yet started as a task)
     - its decisions and why
     - its open questions
     - any files that matter beyond the changed ones
  3. If it's refused for busy workers, either wait for them, or set `workers_done` only if those workers are really finished.
  4. Tell the owner in one line to run `/clear`.

  It must not summarise code in prose. With a task id, it does the same for one task.
- **`/estack:resume [task]`.** The skill tells the agent:
  1. Call `resume`, with the task id if given.
  2. Read every file listed.
  3. State the goal, the remaining plan and each task's next step, briefly.
  4. Continue under poteto-mode's rules.
- **`poteto-mode/SKILL.md`.** Add one short paragraph:
  - Keep the CTO's context small by delegating reading and implementation to worker subagents.
  - When the engine says context is filling: finish the step, collect workers, hand over, and ask the owner to `/clear`. Never hand over mid-step.
  - After compaction or `/clear`, trust the recorded state and re-read files.
- **`setup/SKILL.md`.** Document the optional `handover:` keys. Owners on a 1M-token context model should set `window_tokens: 1000000`.
- **`README.md`:**
  - a short "Handover" subsection under Engine, including when to use `/clear` vs `/compact`
  - `PreCompact` in the Hooks table
  - phase 4 marked "Done" in the roadmap

- [ ] **Step 1: Make the selftest fail first.** If the selftest's hook check lists events, extend it to require `PreCompact`. Then run `npm run build:claude && (cd adapters/claude-code && bash scripts/selftest.sh)`. Expected: FAIL before the new pieces exist.

- [ ] **Step 2: Implement** the two skills and the doc changes, then regenerate.

- [ ] **Step 3: Run every check.** `npm run build:claude && npm test && npx tsc -p . && npm run check:claude && (cd adapters/claude-code && bash scripts/selftest.sh)`. Expected: all pass.

- [ ] **Step 4: Live check.** The controller runs this, because it installs the plugin. In a scratch repo with the plugin installed and `.estack/` committed by the owner:
  1. In session A (`claude -p`), start two feature tasks, complete `plan` on one, then run `/estack:handover` with a goal and a remaining-plan item.
  2. Run `estack handovers` and check that it lists the session handover.
  3. Start a fresh session B (`claude -p`) with a plain prompt such as "continue". Expected: B resumes on its own from the SessionStart hint, states the goal and both tasks' next steps, and a code edit on either task is allowed. Bindings show B's real session id.
  4. Remove the marketplace.

  Record the results in the commit message.

- [ ] **Step 5: Commit.** `git commit -m "Handover and resume slash commands; docs"`
