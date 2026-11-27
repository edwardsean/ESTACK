# Phase 3: Hooks that enforce the engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents unable to skip the engine at the moments that matter. That means no code edits without a task, no push without `verify` evidence and the owner's approval, trustworthy agent ids, and the same checks in git for any agent. The old Python approval gates are replaced.

**Architecture:** All hook logic lives in the engine as `estack hook <event>`. It reads Claude Code's hook JSON on stdin and writes the hook's JSON answer on stdout. A tiny shell wrapper exits immediately in repositories that aren't opted in, so they never start Node. Git hooks are short shell scripts that call `estack git-hook <name>`, and they only act when an agent runs git (`CLAUDECODE=1`). Command and path rules come from `.estack/policy.yaml`. A few rules are hard-coded so policy can't switch them off: engine-state access, owner-only commands, and hook bypasses.

**Tech Stack:** Existing engine (TypeScript, `node:sqlite`, vitest), POSIX `sh` for wrappers and git hooks. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-estack-engine-design.md`, section 7 (Policy file, Hook table, Roles, Git hooks, Overrides, Threat model) and section 13 phase 3.

## Global Constraints

- **No new dependencies.** Don't run `npm install`; `package-lock.json` must not change. It holds hand-restored platform bindings. Write glob matching by hand.
- **Edit `core/` and `engine/`, never `adapters/claude-code/`.** Regenerate with `npm run build:claude`; `npm run check:claude` must pass.
- **Repos that aren't opted in pay nothing.** Every Claude Code hook goes through `core/hooks/scripts/estack-hook.sh`, which exits 0 with no output, without starting Node, when `.estack/policy.yaml` is missing in both `$CLAUDE_PROJECT_DIR` and the event's `cwd`.
- **Gates fail closed.** In an opted-in repo, if the engine throws inside a `PreToolUse` gate (edit or Bash), the answer is `deny` with `estack: <message>`, never a silent allow. Context hooks (`SessionStart`, `UserPromptSubmit`) and `PostToolUse` fail open, silently.
- **Agents:** a hook event with `agent_id` set comes from a subagent (worker). Without `agent_id` it comes from the main (CTO) session.
- **Roles (spec section 7):** workers never run an `ask` action (push, merge, deploy, migration): it is denied, not asked. Only the main session gets the owner's `ask` prompt.
- **Hard-coded denials, not in policy, can't be disabled:**
  - any Bash command that mentions `.estack/state.db`
  - `estack skip|cancel|override`, or `estack.mjs skip|cancel|override`
  - `--no-verify`
  - `core.hooksPath`
  - `git config` writing `hooks`
- **Stop and SubagentStop never block twice:** when the event has `stop_hook_active: true`, answer with no output.
- **Hook outputs (Claude Code):**
  - `PreToolUse`: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"ask"|"deny","permissionDecisionReason":"...","updatedInput":{...}?}}`
  - `SessionStart` / `UserPromptSubmit`: `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"..."}}`
  - `Stop` / `SubagentStop`: `{"decision":"block","reason":"..."}`
  - No decision means no output, exit 0.
- **MCP tool names:** the plugin's tools arrive as `mcp__plugin_estack_estack__<tool>`. This was observed in the phase 2 live check.
- **No em or en dashes** in `core/` text files.

## Review Focus

1. **Bypass attempts.** All of these are denied:
   - `cd sub && git push origin main` without verify evidence
   - `git push --no-verify`
   - `git -c core.hooksPath=/dev/null commit`
   - `sqlite3 .estack/state.db 'update steps…'`
   - `estack override push --reason x` run by an agent
   Owner: Tasks 1 and 2.
2. **Things that must stay friction-free.** These are allowed with no output:
   - edits to exempt paths (`README.md`, `docs/x.md`)
   - edits to files outside the repo (`~/.claude/...`)
   - all reads
   - `git status`, `npm test`
   - any hook in a repo that isn't opted in
   Owner: Tasks 1, 2 and 5.
3. **An engine error during a gate** (for example a corrupt `policy.yaml`) denies with a one-line reason. It doesn't allow and doesn't crash. Owner: Task 2.
4. **Stop loops.** With `stop_hook_active: true`, Stop and SubagentStop never block. Owner: Task 3.
5. **Git hooks for the owner.** The owner's own `git commit` and `git push` from a normal terminal (no `CLAUDECODE`) pass untouched, even with no task. An existing hook the repo already had still runs. Owner: Task 4.

---

## File structure

| Path | Responsibility |
|---|---|
| `engine/src/match.ts` | Glob matching for commands and paths; classify a command into a policy action; hard-coded denials |
| `engine/src/hooks.ts` | One handler per Claude Code hook event, pure over (Engine, event) → output |
| `engine/src/githooks.ts` | Install and chain git hooks; `pre-commit` and `pre-push` checks |
| `engine/src/cli.ts` | Modified: `hook <event>`, `git-hook <name>`, and `init` also installs git hooks |
| `engine/src/policy.ts` | Modified: richer default patterns |
| `engine/test/match.test.ts`, `hooks.test.ts`, `githooks.test.ts` | Tests |
| `core/hooks/hooks.json` | Every event goes to `estack-hook.sh` |
| `core/hooks/scripts/estack-hook.sh` | Fast exit when not opted in, else runs the bundled engine |
| `core/hooks/scripts/{gate-check.sh,audit-write.sh,seat-backstop.sh,enterprise_hooks.py}`, `core/scripts/test-gates.py` | Deleted |
| `core/scripts/selftest.{py,sh}` | Updated for the new hooks |
| `core/skills/{setup,enterprise-gates,poteto-mode}/SKILL.md`, `README.md` | Updated text |

---

### Task 1: Policy matching

**Files:**
- Create: `engine/src/match.ts`, `engine/test/match.test.ts`
- Modify: `engine/src/policy.ts` (default patterns only)

**Interfaces:**
- Produces:
  ```ts
  export function globToRegExp(glob: string, mode: "command" | "path"): RegExp;
  export function commandMatches(command: string, pattern: string): boolean;
  export type CommandVerdict =
    | { kind: "none" }
    | { kind: "deny"; action: string; pattern: string; hardcoded: boolean }
    | { kind: "ask"; action: string; pattern: string };
  export function classifyCommand(command: string, policy: Policy): CommandVerdict;
  export function pathMatches(relPath: string, pattern: string): boolean;
  export function isProtected(relPath: string, policy: Policy): boolean;
  export function isExempt(relPath: string, policy: Policy): boolean;
  export const HARDCODED_DENY: ReadonlyArray<{ action: string; pattern: string }>;
  ```
  **Command glob rules.** `*` matches any characters, including `/` and spaces, and `?` matches one character. A pattern matches the whole command, or the whole command with `*` prepended, so it catches the command after a shell prefix such as `cd x && …`. This is the old gate's rule, kept so commands behave the same.

  **Path glob rules.** Paths are relative to the worktree root, using `/`. `**` matches any number of segments, `*` matches within one segment, and `?` matches one character. A pattern with no `/` matches the basename at any depth, the way gitignore does: `.env*` matches `api/.env.local`.

  **`classifyCommand` order:**
  1. `HARDCODED_DENY` (deny, `hardcoded: true`)
  2. each action in `policy.actions.deny` with its patterns (deny)
  3. each action in `policy.actions.ask` (ask)
  4. otherwise `none`

  `HARDCODED_DENY`:
  ```ts
  [ { action: "engine_state", pattern: "*.estack/state.db*" },
    { action: "owner_only", pattern: "estack skip*" }, { action: "owner_only", pattern: "estack cancel*" },
    { action: "owner_only", pattern: "estack override*" }, { action: "owner_only", pattern: "*estack.mjs skip*" },
    { action: "owner_only", pattern: "*estack.mjs cancel*" }, { action: "owner_only", pattern: "*estack.mjs override*" },
    { action: "disable_hooks", pattern: "*--no-verify*" }, { action: "disable_hooks", pattern: "*core.hooksPath*" },
    { action: "disable_hooks", pattern: "git config*hooks*" } ]
  ```

  New `patterns` block in `DEFAULT_POLICY_YAML`. Everything else stays as it is:
  ```yaml
  patterns:                 # how shell commands map to actions
    git_push:      ["git push*", "gh pr create*"]
    merge:         ["gh pr merge*"]
    deploy:        ["*deploy*", "kubectl apply*", "kubectl delete*", "kubectl rollout*", "terraform apply*", "terraform destroy*", "helm install*", "helm upgrade*", "helm uninstall*"]
    db_migration:  ["*migrate*", "*migration*", "alembic upgrade*", "prisma migrate*", "flyway migrate*", "psql * -c *", "mysql * -e *"]
    force_push_protected: ["git push --force* origin main", "git push -f* origin main", "git push --force* origin master", "git push -f* origin master"]
  ```

- [ ] **Step 1: Write the failing tests** in `engine/test/match.test.ts`. Use `parsePolicy(DEFAULT_POLICY_YAML)`.
  ```ts
  test("plain commands are none", ...)   // "git status", "npm test", "ls -la", "kubectl get pods", "cat README.md"
  test("git push is ask git_push", ...)  // "git push origin feat" -> {kind:"ask", action:"git_push"}
  test("a push behind a shell prefix is still caught", ...)  // "cd api && git push origin feat" -> ask git_push
  test("force push to main is deny, not ask", ...)  // "git push --force origin main" -> deny force_push_protected
  test("hard-coded denials win over policy and are flagged", ...)
      // "sqlite3 .estack/state.db 'select 1'" -> deny engine_state, hardcoded true
      // "estack override push --reason x" -> deny owner_only
      // "git push --no-verify origin feat" -> deny disable_hooks (not ask)
      // "git -c core.hooksPath=/dev/null commit -m x" -> deny disable_hooks
  test("a policy with an empty deny list still applies hard-coded denials", ...)
  test("path globs: ** spans dirs, * stays in a segment, no-slash matches basename", ...)
      // pathMatches("docs/a/b.md","docs/**") true; pathMatches("src/a.ts","src/*.ts") true; pathMatches("src/x/a.ts","src/*.ts") false;
      // pathMatches("api/.env.local",".env*") true; pathMatches("secrets/k","**/secrets/**") true
  test("exempt and protected use the policy", ...)
      // isExempt("README.md") true; isExempt("src/a.ts") false; isProtected(".estack/policy.yaml") true; isProtected("api/.env") true
  ```

- [ ] **Step 2: Run and see them fail.** `npx vitest run engine/test/match.test.ts`. Expected: FAIL, `../src/match` not found.

- [ ] **Step 3: Implement `engine/src/match.ts`** and update the default `patterns` in `policy.ts`.

- [ ] **Step 4: Run and see them pass.** `npx vitest run engine/test/match.test.ts` (7 passed), then `npm test` (all pass).

- [ ] **Step 5: Commit.** `git commit -m "engine: policy matching for commands and paths, hard-coded denials"`

---

### Task 2: PreToolUse and PostToolUse handlers

**Files:**
- Create: `engine/src/hooks.ts`, `engine/test/hooks.test.ts`
- Modify: `engine/src/cli.ts` (`hook <event>`)

**Interfaces:**
- Consumes: Task 1's `classifyCommand`, `isExempt`, `isProtected`. From phase 2: `openEngine`, `listOpen`, `getTask`, the `task_bindings(task_id, session_id, agent_id, role, bound_at)` table, and `events`.
- Produces:
  ```ts
  export interface HookEvent { hook_event_name: string; session_id: string; cwd: string; agent_id?: string;
    agent_type?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string;
    stop_hook_active?: boolean; prompt?: string; source?: string }
  export type HookOutput = Record<string, unknown> | null;      // null = no output
  export function preToolUse(e: Engine, ev: HookEvent): HookOutput;
  export function postToolUse(e: Engine, ev: HookEvent): HookOutput;
  export function runHook(name: string, ev: HookEvent, deps?: { exec?: Exec; now?: () => Date }): HookOutput;
  // runHook opens the engine at ev.cwd. If the repo isn't opted in it returns null.
  // Any other error: for "pre-tool-use" it returns deny with `estack: <message>`; for other hooks it returns null.
  ```
  CLI: `estack hook <pre-tool-use|post-tool-use|session-start|user-prompt-submit|stop|subagent-stop>` reads stdin JSON, calls `runHook`, prints `JSON.stringify(output)` when it isn't null, and exits 0. Invalid JSON on stdin exits 0 with nothing printed for non-gate events, and prints deny for `pre-tool-use`.

  `preToolUse` rules, by tool:
  - **`Edit`, `Write`, `MultiEdit`, `NotebookEdit`.** The path is `tool_input.file_path`, or `notebook_path`, resolved against `ev.cwd`. Its worktree is the `git rev-parse --show-toplevel` of the file's directory, or of the nearest existing parent. Then:
    1. Outside any worktree of this repo (the worktree's common dir isn't the engine's repo) → `null`.
    2. `isProtected(rel)` → deny: "`<rel>` is protected by .estack/policy.yaml".
    3. `isExempt(rel)` → `null`.
    4. An open task exists whose `cwd` equals the worktree and which has a binding with `session_id === ev.session_id` → `null`.
    5. Otherwise deny: "No open estack task for this session in `<worktree>`. Start one with the start_task tool (title, type, goal, done_check) before editing `<rel>`."
  - **`Bash`.** `classifyCommand(tool_input.command)`:
    - `none` → `null`.
    - `deny` → deny: "`<action>`: blocked by `<'estack' if hardcoded else '.estack/policy.yaml'>` (pattern `<p>`)".
    - `ask`, with `ev.agent_id` set → deny: "`<action>` runs only from the main session, with the owner's approval; report back to the orchestrator instead".
    - `ask` with action `git_push` from the main session:
      - The branch is `git branch --show-current` in `ev.cwd`.
      - The task is the newest open-or-done task with that branch.
      - No task → deny: "no estack task for branch `<b>`; start one, or the owner can run `estack override git_push --reason …` in a terminal".
      - Its `verify` step isn't `done` → deny: "task #N has no verify evidence; run run_check with step verify first".
      - Otherwise, record an `ask` event with `{tool_use_id, action, command}` and answer `ask` with a reason naming the action, pattern and task.
    - **Owner override.** Before denying a push for a missing task or missing verify, look for an `approvals` row with `decision "override"`, `action "git_push"`, from the last 30 minutes, with no `override_used` event pointing at its id. If one exists, log `override_used` (payload `{approval_id, tool_use_id}`) and answer `ask` instead. One override allows exactly one push.
    - Other `ask` actions from the main session → record the `ask` event and answer `ask`.
  - **`mcp__plugin_estack_estack__*`** → `allow`, with `updatedInput` equal to `tool_input` plus `actor: { session_id: ev.session_id, agent_id: ev.agent_id }`. Leave `agent_id` out when there isn't one. This overwrites any `actor` the agent typed.
  - **Any other tool** → `null`.

  `postToolUse`: for `Bash`, if an `ask` event with this `tool_use_id` exists, insert an `approvals` row with `decision "approved"`, `by` set to the actor id, and the command and action, plus an `approved` event. Otherwise `null`. It never outputs anything.

- [ ] **Step 1: Write the failing tests** in `engine/test/hooks.test.ts`. Use a real temp repo (`makeRepo`, `initRepo`, commit `.estack`) and `runHook` with handcrafted events. `estack.test` and `verify` are set to `"true"`, and `gh` is faked.
  ```ts
  test("not opted in: every hook returns null", ...)
  test("edit to an exempt path is allowed with no output", ...)          // README.md, docs/x.md
  test("edit outside the repo is allowed with no output", ...)           // a mkdtemp file
  test("edit to a protected path is denied", ...)                        // .estack/policy.yaml, api/.env
  test("code edit with no task is denied and says start_task", ...)
  test("code edit with an open task bound to this session is allowed", ...)
  test("a task bound to another session doesn't count", ...)
  test("plain bash is allowed with no output", ...)
  test("hard-coded denials apply to bash", ...)                          // state.db, estack override, --no-verify
  test("push from a worker is denied, not asked", ...)                   // agent_id set
  test("push with no task for the branch is denied", ...)
  test("push before verify is denied and names run_check", ...)
  test("push after verify asks and records an ask event", ...)
  test("an owner override lets exactly one push through to the ask prompt", ...)  // estack override git_push from a normal env, then two pushes: first asks, second is denied
  test("post-tool-use after an ask records an approval", ...)            // approvals row decision approved
  test("estack MCP calls get the real actor stamped over a typed one", ...)
      // tool_input {title:"x", actor:{session_id:"fake"}} -> updatedInput.actor deep-equals {session_id: ev.session_id, agent_id: "A"}
  test("a broken policy denies gates with a one-line reason", ...)      // write invalid yaml -> pre-tool-use edit -> deny, reason starts "estack: "
  ```
  Also add a CLI test in `engine/test/cli.test.ts`: `estack hook pre-tool-use` with a JSON event on stdin prints a deny for a code edit with no task. Give `main` a way to read stdin in tests; adding `stdin?: string` to `Io` is fine.

- [ ] **Step 2: Run and see them fail.** `npx vitest run engine/test/hooks.test.ts`. Expected: FAIL, `../src/hooks` not found.

- [ ] **Step 3: Implement** `hooks.ts` (`preToolUse`, `postToolUse`, `runHook`) and the CLI `hook` command.

- [ ] **Step 4: Run and see them pass.** `npx vitest run engine/test/hooks.test.ts engine/test/cli.test.ts`, then `npm test`.

- [ ] **Step 5: Commit.** `git commit -m "engine: PreToolUse and PostToolUse hook handlers"`

---

### Task 3: Context and stop handlers

**Files:**
- Modify: `engine/src/hooks.ts`, `engine/test/hooks.test.ts`

**Interfaces:**
- Consumes: Task 2's `HookEvent`, `HookOutput`, `runHook`.
- Produces:
  ```ts
  export function sessionStart(e: Engine, ev: HookEvent): HookOutput;
  export function userPromptSubmit(e: Engine, ev: HookEvent): HookOutput;
  export function stop(e: Engine, ev: HookEvent): HookOutput;          // also used for SubagentStop
  ```
  Rules:
  - **`sessionStart`.** `additionalContext` is:
    - a header line, `estack: this repository is opted in; code edits need an open task (start_task), pushes need verify evidence.`
    - then one line per open task: `#N [type] title (branch) next: <step>`
    - or `no open tasks`
    It is capped at 20 tasks.
  - **`userPromptSubmit`.** If this session has an open bound task, one line: `estack: task #N next step: <step>`. Otherwise `null`.
  - **`stop`, for both Stop and SubagentStop.**
    - `stop_hook_active` → `null`.
    - Take the open tasks bound to this session. For SubagentStop, only those bound with `agent_id === ev.agent_id`.
    - For each one, find **unrecorded work**: commits on the task branch after `base_sha` (`git rev-list --count <base_sha>..<branch>` in `task.cwd`) while the task's `implement` or `fix` step isn't done.
    - Block once, naming every such task: "task #N has N new commit(s) on <branch> but its <implement|fix> step has no evidence; record it with complete_step (kind commit) or say why not."
    - **SubagentStop only:** also block when the worker's task has `implement`/`fix` done but `test` not done, with "run run_check with step test before finishing".
    - Otherwise `null`.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  test("session start lists open tasks and their next step", ...)
  test("session start with no tasks still states the rules", ...)
  test("prompt submit shows the bound task's next step, else nothing", ...)
  test("stop blocks when commits exist but implement has no evidence", ...)
  test("stop allows once implement is recorded", ...)
  test("stop never blocks when stop_hook_active", ...)
  test("subagent stop blocks a worker that implemented but never ran test", ...)
  test("subagent stop ignores tasks bound to other agents", ...)
  ```

- [ ] **Step 2: Run and see them fail.** `npx vitest run engine/test/hooks.test.ts`. Expected: the new tests fail.

- [ ] **Step 3: Implement**, and route the four events in `runHook`.

- [ ] **Step 4: Run and see them pass**, then `npm test`.

- [ ] **Step 5: Commit.** `git commit -m "engine: session context and stop hooks"`

---

### Task 4: Git hooks

**Files:**
- Create: `engine/src/githooks.ts`, `engine/test/githooks.test.ts`
- Modify: `engine/src/cli.ts` (`git-hook <name>`; `init` also installs hooks), `engine/src/policy.ts` (`initRepo` reports installed hooks)

**Interfaces:**
- Consumes: Task 1's `isProtected` and `isExempt`; phase 2's tasks and steps.
- Produces:
  ```ts
  export const MANAGED_MARK = "# estack-managed-hook";
  export function installGitHooks(repoRoot: string, enginePath: string): { installed: string[]; chained: string[] };
  export function preCommit(e: Engine, cwd: string): string | null;          // null = ok, else the refusal message
  export function prePush(e: Engine, cwd: string, stdin: string): string | null;
  ```
  - **`installGitHooks`:**
    - Writes `pre-commit` and `pre-push` into `git rev-parse --git-path hooks` (shared by every worktree), with mode 0755.
    - An existing hook without `MANAGED_MARK` is renamed to `<name>.estack-prev` and run first. If it fails, the hook fails.
    - Re-running is idempotent.
    - Script body, with the engine path absolute and fixed at install time:
    ```sh
    #!/bin/sh
    # estack-managed-hook
    prev="$(dirname "$0")/<name>.estack-prev"
    if [ -x "$prev" ]; then "$prev" "$@" || exit $?; fi
    [ "$CLAUDECODE" = "1" ] || exit 0
    engine='<enginePath>'
    if [ ! -f "$engine" ]; then echo "estack: engine not found at $engine; re-run /estack:setup" >&2; exit 1; fi
    exec node --no-warnings "$engine" git-hook <name> "$@"
    ```
    For `pre-push`, the stdin ref list must reach both the previous hook and the engine. Capture it once into a variable and feed it to each.
  - **`preCommit`.** Staged paths come from `git diff --cached --name-only`, relative to `git rev-parse --show-toplevel` in `cwd`.
    - Any staged path is protected → "commit touches protected `<path>`".
    - All staged paths are exempt → `null`.
    - No open task has `cwd` equal to this toplevel → "no open estack task for `<toplevel>`".
    - Otherwise `null`.
  - **`prePush`.** For each stdin line `<local ref> <local sha> <remote ref> <remote sha>`, where the local sha isn't all zeros and the local ref is `refs/heads/<b>`:
    - The newest task with branch `b` must have its `verify` step `done`.
    - Otherwise refuse with "branch `<b>` has no verify evidence (task #N)", or "no estack task for branch `<b>`".
    - An unused owner override for `git_push` from the last 30 minutes satisfies the check, using the same rule as Task 2 and consuming it.
  - **CLI `git-hook <pre-commit|pre-push>`:** run the check and print the message to stderr with exit 1 on refusal, exit 0 otherwise. A repo that isn't opted in exits 0.
  - **`init`:** after writing the files, call `installGitHooks(root, realpath(process.argv[1]))` and print the installed and chained hooks. When the CLI isn't running from the bundle, as in tests, the engine path is an argument the test passes.

- [ ] **Step 1: Write the failing tests** with real git. Run `git commit` and `git push` to a bare remote in a temp dir, with env `CLAUDECODE=1` or without it. Use a small JS shim as the engine path, so the test runs the TS CLI through `tsx`.
  ```ts
  test("install writes both hooks, executable, and is idempotent", ...)
  test("an existing hook is chained and still runs", ...)          // prev hook writes a marker file; marker exists after commit
  test("owner commit without a task passes (no CLAUDECODE)", ...)
  test("agent commit of code without a task is refused", ...)      // CLAUDECODE=1
  test("agent commit of only exempt files passes", ...)
  test("agent commit touching a protected path is refused", ...)
  test("agent push without verify is refused; with verify it passes", ...)
  test("owner push without a task passes", ...)
  ```

- [ ] **Step 2: Run and see them fail.** `npx vitest run engine/test/githooks.test.ts`. Expected: FAIL, `../src/githooks` not found.

- [ ] **Step 3: Implement** `githooks.ts`, the CLI command, and `init` installing hooks.

- [ ] **Step 4: Run and see them pass**, then `npm test`.

- [ ] **Step 5: Commit.** `git commit -m "engine: git hooks for agent commits and pushes"`

---

### Task 5: Wire the plugin, retire the old gates, run it live

**Files:**
- Create: `core/hooks/scripts/estack-hook.sh` (mode 0755)
- Modify: `core/hooks/hooks.json`, `core/scripts/selftest.py`, `core/scripts/selftest.sh`, `core/skills/setup/SKILL.md`, `core/skills/enterprise-gates/SKILL.md`, `core/skills/poteto-mode/SKILL.md` (Gates section), `README.md`
- Delete: `core/hooks/scripts/gate-check.sh`, `audit-write.sh`, `seat-backstop.sh`, `enterprise_hooks.py`, `core/scripts/test-gates.py`
- Regenerate: `adapters/claude-code/`

**Interfaces:**
- `estack-hook.sh <event>`:
  ```sh
  #!/bin/sh
  input="$(cat)"
  dir="${CLAUDE_PROJECT_DIR:-}"
  cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ ! -f "$dir/.estack/policy.yaml" ] && [ ! -f "$cwd/.estack/policy.yaml" ]; then exit 0; fi
  if ! command -v node >/dev/null 2>&1; then
    case "$1" in pre-tool-use) printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"estack: node is not on PATH, so this repository'"'"'s gates cannot run"}}';; esac
    exit 0
  fi
  printf '%s' "$input" | exec node --no-warnings "$(dirname "$0")/../../engine/estack.mjs" hook "$1"
  ```
- `hooks.json`: `PreToolUse` with matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__plugin_estack_estack__.*`; `PostToolUse` with matcher `Bash`; plus `SessionStart`, `UserPromptSubmit`, `Stop` and `SubagentStop`. Each is `"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/estack-hook.sh" <event>`, with timeout 10 (30 for Stop, which may run git). The description says the hooks are dormant until `.estack/policy.yaml` exists.

- [ ] **Step 1: Write the failing check.** In `selftest.sh`, replace section 2 (test-gates) and section 3 (smoke) with an **engine hook smoke test**. In a temp git repo:
  - after `estack.mjs init`, piping a `Write` event for `src/a.ts` through `hooks/scripts/estack-hook.sh pre-tool-use` prints a deny;
  - in a dormant repo the same event prints nothing, exits 0, and writes nothing.

  In `selftest.py`, change `check_hooks` to require every hooks.json command to reference `estack-hook.sh`, and that script to exist and be executable. Run `bash adapters/claude-code/scripts/selftest.sh` after `npm run build:claude`. Expected: FAIL, the script doesn't exist yet.

- [ ] **Step 2: Implement.**
  - Add `estack-hook.sh` and the new `hooks.json`. Delete the old scripts and `test-gates.py`.
  - Update `setup/SKILL.md`:
    - It no longer writes `gates.json`. `estack init` writes `.estack/` and installs git hooks, and policy edits happen in `.estack/policy.yaml`.
    - If `.claude/enterprise/gates.json` exists, tell the owner it's superseded and offer to delete it.
    - Keep the knowledge-index and governance sections.
  - Update `enterprise-gates/SKILL.md` and the poteto-mode Gates section to describe the new behaviour: edit needs a task; push needs verify plus the owner's approval; workers never push; denials are answers, not obstacles to route around.
  - Add a "Hooks" section to `README.md` listing each hook and what it blocks.

- [ ] **Step 3: Run every check.**
  ```bash
  npm run build:claude && npm test && npx tsc -p . && npm run check:claude && (cd adapters/claude-code && bash scripts/selftest.sh)
  ```
  Expected: all pass. Time the dormant path: `time (echo '{}' | adapters/claude-code/hooks/scripts/estack-hook.sh pre-tool-use)` reports real < 0.05 s.

- [ ] **Step 4: Live check.** The controller runs it, because it installs the plugin into the owner's Claude Code config.
  1. Scratch git repo; `estack.mjs init`; commit `.estack`.
  2. Add the marketplace from the worktree and `claude plugin install estack@estack`.
  3. `claude -p` asked to create `src/a.ts` with any content. Expected: the edit is denied with the start_task message.
  4. `claude -p` asked to start a feature task with the estack tools and then create `src/a.ts`. Expected: the file is created. `estack status` shows the task, and the binding's `session_id` is the real one, not "unknown".
  5. `claude -p` asked to run `git push --no-verify origin main`. Expected: denied.
  6. Remove the marketplace.

  Record the results in the commit message.

- [ ] **Step 5: Commit.** `git commit -m "Wire estack hooks into the plugin; retire the Python gates"`
