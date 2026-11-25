# estack engine: design

Date: 2026-11-25
Status: draft, owner decisions folded in, awaiting approval

## 1. Intent

estack is a personal harness for running coding agents. Today it is pstack plus an
enterprise SDLC layer, packaged as a Claude Code plugin. Almost all of its control is
prose: playbooks, principles and role briefs that tell the model what to do. Prose is
a request. Under pressure a model forgets a step, skips it, or reports work as done
that it never did.

The owner wants three things from the next version:

1. **Agents follow the workflow without skipping steps or hallucinating progress.**
   The required steps, the evidence that each step happened, and the human approvals
   live outside the model, in a store the model cannot rewrite by talking.
2. **Agents reuse code that already exists.** The motivating failure: one session was
   told to put a helper in `utils.ts` for a service, and a later session wrote the same
   function again inside that service. A new session must see what already exists near
   the code it is about to touch, before it writes anything.
3. **Work survives a full context window.** When a session's context gets large, the
   work moves to a fresh session that picks it up quickly and correctly, from recorded
   state rather than from a prose summary.

And two longer-term properties:

4. **Coding-agent agnostic.** The owner uses Claude Code first, and wants the same harness
   to work later in other agents (Cursor, OpenCode, T3 Code).
5. **Fast SDLC with guardrails.** Agents do reversible work on their own, and stop for
   the human only on actions that cross into shared systems.

### How the owner works

The owner opens one Claude Code session per project and treats it as the **CTO**. The
CTO session is the orchestrator: it takes goals from the owner, splits them into tasks,
starts worker agents (subagents) that each work in their own git worktree on a
different feature, reviews their results, and asks the owner for approval on risky
actions. Several workers run at the same time on the same repository. The owner is the
only human in the loop.

## 2. Goals, non-goals, anti-goals

**Goals**

- A local **engine** that holds workflow state: tasks, their required steps, evidence
  per step, human approvals, claims on shared code, a code map, and handovers.
- **Enforcement by Claude Code hooks and git hooks**, so the model cannot skip the
  engine at the moments that matter: editing code, committing, pushing, finishing a turn.
- A **code map** generated from the code, queried by agents through a few tools, shown
  automatically when work starts on an area.
- **Claims**, so two parallel workers do not build the same shared thing or edit the
  same file at once.
- **Handover** between sessions from engine state.
- A repository layout of **core content plus generated adapters**, starting with Claude Code.

**Non-goals (for this version)**

- Adapters for Cursor, OpenCode or T3 Code. The layout must allow them; building them is later.
- A shared server, multiple machines, multiple humans, a web dashboard.
- Replacing the interactive CTO session with a program that drives agents (approach C below).
- Trimming pstack's skills, seats and playbooks. Worth doing, but separate work.

**Anti-goals: things that would make this a failure even if it works**

- **A harness that slows the owner down more than it protects.** If every edit needs a
  ceremony, the owner will turn it off. Reversible work must stay friction-free.
- **A code map that is wrong.** A stale or agent-written map is worse than none: agents
  will confidently reuse things that no longer exist. The map is only ever generated
  from code.
- **Enforcement that can be routed around quietly.** A gate an agent can avoid by
  rephrasing a command is theatre. Where a check can't be enforced, the doc says so.
- **Silent failure.** If the engine is missing or broken in an opted-in repo, gated
  actions stop with a clear message; they do not pass silently.

## 3. Constraints

- Runs locally on macOS, no service to deploy. One SQLite file per repository.
- Claude Code is the first and only adapter in this version.
- The existing pstack content (playbooks, principles, seats) and its build levers keep
  working; the engine is added, not a rewrite.
- Hooks must be fast (target under 200 ms) because they run on every edit and every command.
- Repository is public on GitHub. No secrets, no customer data, no local absolute paths.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Extend the harness with more skills and hooks; engine later or never | Cheapest. Does not solve the problem: steps remain prose, there is no place for the code map, claims need shared state. Rejected. |
| **B** | **Engine is the backbone; the CTO stays an interactive Claude Code session; hooks enforce** | Real enforcement at the risky moments, keeps the owner's way of working, agnostic later via MCP. The model still decides *when* to call the engine between hook points. **Chosen.** |
| C | The orchestrator is a program (for example the Claude Agent SDK, or LangGraph) that drives each agent step by step | Strongest guarantee: the code owns the order. Loses the interactive CTO, much more to build, tied to one SDK, rigid for tasks that don't fit the script. Rejected for now. |

**On LangGraph specifically.** LangGraph is a library for writing agent workflows as
code that calls model APIs. Using it is approach C: it cannot reach into a Claude Code
session to enforce anything, so it would replace the CTO session. The engine's state is
a checklist with evidence, which needs a few tables and rules, not a graph runtime.

**Why B is enough.** The owner's worry is that the CTO might not use the engine. In B
the model does not need to remember it: hooks consult the engine on every edit, commit,
push and turn end (section 7). If B proves too loose, an approach-C runner can be added
later on top of the same engine, so nothing is wasted.

## 5. Architecture

```text
Owner  (sets goals, approves push / merge / deploy / migration)
  │
  ▼
CTO session (Claude Code, runs the orchestrator)
  │  reads project brief + engine status; plans; builds shared pieces first;
  │  starts workers; reviews; asks the owner
  ├── worker A   subagent, own worktree, task 12
  ├── worker B   subagent, own worktree, task 13
  └── verifier   subagent, checks claims of A and B
          │
          │  MCP tools (start_task, complete_step, find_existing, claim, ...)
          ▼
  ┌──────────────────────── engine ─────────────────────────┐
  │  MCP server  +  CLI (used by hooks)  →  SQLite state.db │
  │  tasks · steps · evidence · approvals · claims ·        │
  │  code map · handovers · events                          │
  └─────────────────────────────────────────────────────────┘
          ▲                       ▲
  Claude Code hooks          git hooks / CI
  (edit, bash, stop,         (pre-commit, pre-push,
   session start, compact)    post-commit reindex)
```

The engine is **one TypeScript package** with two entry points over the same library
and database:

- an **MCP server** that agents call (stdio, registered in the project's `.mcp.json`);
- a **CLI** (`estack ...`) that hooks and git hooks call. Hooks call the CLI, not the
  MCP server, because a hook is a short-lived process that needs an answer fast.

## 6. Repository layout

```text
estack/
  core/                      the source of truth for content, agent-neutral
    playbooks/ principles/ roles/ skills/
    policy.schema.json       schema for a project's policy file
  adapters/
    claude-code/             generated Claude Code plugin (what pstack-claude is today)
    build-claude-code.ts     the generator
  engine/                    TypeScript package: library, MCP server, CLI, indexer
  docs/
```

Migration from today: `pstack-claude/` content moves into `core/` (agent-neutral text)
and the Claude Code specifics (frontmatter, hooks.json, plugin manifest) move into the
generator. `pstack-qoder/` and `upstream/` stay as they are, as reference, until the
generator replaces the old levers; the doc does not require deleting them.

**Done when:** the generated `adapters/claude-code/` installs and passes the existing
selftest, and behaves like `pstack-claude` does today.

### Per-project files (in the repository being worked on)

```text
.estack/
  policy.yaml     committed. What runs automatically, what asks, what is denied, required steps
  brief.md        committed. The project brief the CTO reads: goals, architecture, conventions
  state.db        gitignored. The engine's SQLite database
```

`state.db` lives at the **main checkout's** `.estack/`, found through
`git rev-parse --git-common-dir`, so every worktree of the repository shares one database.
`/estack:setup` (replacing `/pstack:setup-enterprise`) writes these files and installs
the git hooks. A repository without `.estack/policy.yaml` is not opted in, and every
hook exits immediately and silently, as the current gates do.

## 7. Enforcement

### Policy file

```yaml
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
```

The existing `.claude/enterprise/gates.json` and `governance.json` concepts fold into
this one file. Default values ship with `/estack:setup`; the owner edits them.

### Hook table (Claude Code)

| Moment | Hook | Engine check | Outcome |
|---|---|---|---|
| Session starts | `SessionStart` | `estack status --for-session` | Injects active tasks, next step per task, pending approvals, and any handover waiting for this session |
| Owner sends a message | `UserPromptSubmit` | `estack status --brief` | Re-injects the current task and next step (a few lines) |
| Edit / Write / MultiEdit / NotebookEdit | `PreToolUse` | Path in `exempt_paths`? Allow. Otherwise: is there an open task bound to this session or worktree? Is the path protected? Is the file claimed by another task? | **Deny** with a message saying what to do (`start_task`, or wait for the claim). Allow otherwise |
| Bash | `PreToolUse` | Map command to an action via `patterns`. `deny` → deny. `ask` → check required steps for the task first (e.g. `verify` evidence exists before `git_push`), then return `ask` to the owner | Deny, ask, or allow |
| Bash after an `ask` | `PostToolUse` | Record the approval and the command in `approvals` and `events` | Audit trail |
| Main session ends its turn | `Stop` | Engine state only: a step left `in_progress` with no evidence, or a claim with no task progress. No reading of the transcript for "tests pass" claims (too many false positives); faked progress is prevented by evidence rules instead | **Block** the stop with the missing item named. Allowed through after one block per turn to avoid loops |
| Worker finishes | `SubagentStop` | Worker's steps up to `test` have evidence; it ran no gated command (workers never push; see Roles below) |
| Any engine MCP tool call | `PreToolUse` on `mcp__estack__*` | Stamp the real `session_id` and `agent_id` from the hook input onto the call (`updatedInput`), so the engine never trusts ids the agent typed | Ids are trustworthy for `recorded_by` and "reviewer is not author" | Block finishing with the missing item named |
| Before compaction | `PreCompact` | Write a handover for each active task of this session | Handover saved (section 10) |

### Roles (decided after review)

- **Workers** edit, commit, and record evidence up to `test` in their worktree. They
  never push, open PRs or merge: background subagents can't reliably show the owner an
  `ask` prompt, so `git_push` and other `ask` actions are denied for workers.
- **The verifier** (a different agent) records `verify` and `review` evidence.
- **The CTO** pushes, opens PRs and merges, each through the owner's `ask` prompt.

### Git hooks (agent-agnostic backstop)

Git hooks enforce only when the command comes from an agent. Claude Code sets
`CLAUDECODE=1` in the environment of commands it runs (the builder confirms this, or an
equivalent marker, on the installed version); other adapters set their own marker. The
owner's own commits and pushes from a normal terminal pass untouched.

- `pre-commit`: protected paths untouched; the commit's worktree has an open task.
- `pre-push`: the task's required steps up to `verify` have evidence. A push from a
  branch with no task is refused unless the owner runs `estack override push` (logged).
- `post-commit`: reindex the changed files into the code map (section 9).

CI is out of scope for the engine, but the same `estack check` command can run there.

### Evidence

A step is complete only with evidence the engine can check, not a sentence:

| Kind | What is stored | How the engine checks it |
|---|---|---|
| `command` | the command, exit code, tail of output, timestamp | The engine runs the command **fixed in `policy.yaml` `commands`** (`estack run --step test`); the agent cannot choose a weaker one. `test` is the fast suite; `verify` is the fuller check (build, e2e) plus a `review` by the verifier |
| `commit` | commit sha | The sha exists and is on the task's branch |
| `pr` | PR URL | `gh pr view` succeeds |
| `review` | reviewer seat, verdict, findings | Written by a different agent than the task's author (agent ids differ) |
| `reuse_check` | queries made and what they returned | The queries were run through the engine's tools in this task (they are logged) |
| `note` | free text | Allowed only for steps the policy marks as `note_ok`, such as `plan` |

The key rule: for `test` and `verify`, the engine runs the command and records the
result itself. The agent cannot report a passing test that the engine did not see pass.

### Overrides

The owner can always proceed: `estack override <action> --reason "..."` and
`estack skip <task> <step> --reason "..."`, run in a normal terminal. Both refuse to run
when the agent marker (`CLAUDECODE=1` or equivalent) is set, so an agent's Bash call
can't use them. Overrides are logged. `disable_hooks` is in `deny`.

### Threat model (decided after review)

The agent is assumed to be **careless and prone to shortcuts under pressure, not
adversarial**. Cheap protections against shortcuts are in scope:

- `PreToolUse` on Bash denies direct access to `.estack/state.db` (e.g. `sqlite3`) and
  the owner-only CLI commands.
- Engine ids come from hook input, never from the agent (hook table).
- Test and verify commands come from policy, not from the agent.

A determined adversarial agent (for example one that writes a script to edit the
database indirectly) is out of scope; that would need approach C or OS-level sandboxing.

### What this does not enforce

Between hook points, the CTO still decides what to do next. The engine cannot force a
good plan, only that the plan's steps are recorded and evidenced before code is
committed, pushed or reported done. That limit is accepted for approach B.

## 8. Engine data model

Tables (SQLite, WAL mode so parallel workers can write safely):

```text
tasks        id, title, type, goal, done_check, status, parent_id, branch, worktree_path,
             created_by, created_at
task_bindings task_id, session_id, agent_id, role(cto|worker|verifier), bound_at
steps        task_id, name, ordinal, status(pending|in_progress|done|skipped), done_at
evidence     id, task_id, step_name, kind, payload_json, recorded_by, recorded_at
approvals    id, task_id, action, command, decision(approved|refused|override), by, at
claims       id, task_id, kind(file|symbol|new_symbol), target, status(active|released), at
handovers    id, task_id, from_session, created_at, body_json, consumed_by, consumed_at
code_files   path, lang, hash, indexed_at, branch
code_symbols id, file_path, name, kind, signature, description, start_line, end_line,
             exported, branch, task_id(nullable, set when created inside a task)
code_edges   from_symbol, to_symbol, kind(imports|calls|extends)
code_fts     full-text index over symbol name, signature, description, file path
events       id, at, actor, kind, task_id, payload_json   (append-only log of everything)
```

A session or worker is bound to a task by `task_bindings`. Hooks find the task from
the hook input's `session_id` and `agent_id`, falling back to the worktree path in `cwd`.

**Skipping a step.** A step can be marked `skipped` only by the owner (`estack skip
<task> <step> --reason`) or when the policy marks it optional for that task type.

## 9. Code map

Purpose: let any session find what already exists, near the code it is about to touch
and anywhere in the repo, so it reuses instead of rewriting.

**Built only from code.** An indexer parses source files and writes `code_files`,
`code_symbols`, `code_edges` and `code_fts`. Agents never write to these tables.

- **Languages:** TypeScript and JavaScript first (the owner's main stack), then Python.
- **Description per symbol:** its doc comment if present, otherwise its signature. An
  optional later step can generate one-line descriptions with a cheap model, marked as
  generated and refreshed when the symbol's hash changes.
- **When it runs:** full index at `/estack:setup`; incremental on `post-commit` for
  changed files; on `start_task` for the task's worktree, so uncommitted work in progress
  is visible. Each row carries the branch, so results can say "on main" or "in progress
  in task 14".

**Agent tools (MCP):**

| Tool | Returns |
|---|---|
| `context_for(path or area)` | The area's imports and the helpers it uses, with signatures and descriptions; what calls into it; active claims in it |
| `find_existing(description)` | Top 10 symbols by full-text match over name, signature, description, path; each with file, line, branch, and owning task if in progress |
| `who_uses(symbol)` | Callers and importers |

Queries are indexed lookups and a full-text search; they return small results and
never load the whole map into the agent's context.

**How it stops the `utils.ts` failure:**

1. When a worker starts a task on a service, `start_task` returns `context_for` that
   service automatically, so `utils.ts` and its functions are in front of the agent
   before it writes anything.
2. Every code task type has a `reuse_check` step before `implement`. Its evidence is
   the `find_existing` and `context_for` calls the agent actually made.
3. When a commit adds a new exported or top-level function, the `post-commit` reindex
   compares it with existing symbols (same or similar name; same signature shape) and
   records a `possible_duplicate` event. The `review` step must address any such event
   before it can be completed.

Search by meaning (embeddings) is a later addition if keyword search misses too often.
A graph database is not used; the two tables above are the graph, and the storage sits
behind the tools so it can be replaced without changing agents.

## 10. Parallel work and claims

- **Shared pieces first.** When the CTO plans several tasks, the engine's `plan_tasks`
  tool asks for each task's expected touched areas. If two tasks touch the same
  module or both expect to add something shared, the engine returns the overlap and
  the CTO must either create a separate foundation task that the others depend on, or
  record why the overlap is acceptable. Tasks with an unfinished dependency cannot start.
  **"Finished" means merged into `main`** (owner's decision): dependent tasks start only
  after the foundation task's PR is merged, so every task branches from approved code.
  Stacked branches may be added later if waiting proves too slow. The engine learns of a
  merge by checking `gh pr view` / `git branch --merged main` when `status` or
  `start_task` runs; no background polling. GitHub is assumed as the host for now.
- **Claims.** Before editing a file another active task has claimed, the `PreToolUse`
  edit hook denies with "claimed by task 14". Before adding a new symbol to a shared
  file, the worker calls `claim(new_symbol, "utils.ts#formatInvoiceDate")`; if it exists
  or is claimed, the tool returns the existing one instead. Claims are released when the
  task's PR merges or the task is cancelled.
- **Worktrees.** Each worker task gets a worktree and branch created by `start_task`.
  The engine records the path, so hooks can map `cwd` to a task.

## 11. Handover

**When.** At a step boundary, when the session's context is large (the owner's threshold
is 50%), the CTO or worker calls `handover(task)` and the owner continues in a fresh
session. `PreCompact` also writes one automatically. Handing over in the middle of a
step is avoided: the `UserPromptSubmit` hook mentions that a handover is due only once
the current step is done.

**What it holds: state and pointers, not explanations.**

```json
{
  "goal": "...", "done_check": "...",
  "steps": [{"name": "implement", "status": "done", "evidence": ["commit 3f2a..."]}, ...],
  "next_step": "verify",
  "decisions": [{"what": "use existing formatDate from utils.ts", "why": "..."}],
  "files": ["services/orders/invoice.ts", "utils.ts"],
  "open_questions": [],
  "claims": ["utils.ts#formatInvoiceDate"]
}
```

Most of it is assembled from the engine's tables. The agent adds `decisions` and
`open_questions`, the parts only it knows.

**Context size.** See Risks: the builder confirms which signal is reliable.

**Resume.** In the new session, `SessionStart` shows waiting handovers; `/estack:resume
<task>` binds the session to the task, prints the handover, and the agent re-reads only
the listed files. The new session does not trust a summary of code; it reads the code.

## 12. The CTO session

- It is the one Claude Code session the owner works in per project. There is no
  separate agent above the orchestrator; one loop, one owner of the plan.
- On start it gets `.estack/brief.md` and engine status (via `SessionStart`).
- It plans with `plan_tasks`, starts workers with `start_task` plus a subagent dispatch,
  reviews results, and asks the owner for approvals. For small tasks it may do the work
  itself (pstack's "direct" mode), still inside an engine task, so every hook applies.
- Existing pstack playbooks, principles and seats remain its content. Playbook steps map
  to `task_types` in the policy; the orchestrator skill is updated to call engine tools
  at each step instead of only writing todos.

## 13. Build order

Each phase is usable on its own and ends in a check.

| # | Phase | Done when |
|---|---|---|
| 1 | Restructure into `core/` + generated `adapters/claude-code/`, and **rename the plugin `pstack` → `estack`** (owner's decision): `/estack:<skill>`, seats `estack:<seat>`, `~/.claude/rules/estack-models.md`, marketplace `estack` | Generated plugin passes the selftest (updated for the new name); behaviour otherwise unchanged. `/estack:setup` replaces `/pstack:setup-enterprise`; existing `.claude/enterprise/gates.json` is not read any more, repos re-run setup |
| 2 | Engine core: tasks, steps, evidence (incl. `estack run`), approvals, events; MCP server + CLI; `/estack:setup` | Tests cover the step state machine and evidence rules; a task can be driven end to end through MCP tools |
| 3 | Claude Code hooks + git hooks wired to the engine, replacing the current gate scripts | Recorded-event tests (like today's `test-gates.py`) for every row of the hook table; a live session check that an edit with no task is denied |
| 4 | Handover | A task interrupted mid-run is resumed in a fresh session from the handover alone |
| 5 | Code map: indexer (TS/JS), `context_for`, `find_existing`, `who_uses`, `reuse_check` step, duplicate events | On a fixture repo reproducing the `utils.ts` failure, the second task is shown the helper and the duplicate is flagged if written anyway |
| 6 | Parallel: `plan_tasks` overlap detection, claims, worktree creation | Two workers on overlapping tasks: the shared helper is built once; a claimed file edit is denied |
| 7 | Second adapter (Cursor or OpenCode) | Same engine, same policy, the core flows work in that agent |

## 14. Left to the builder

- TypeScript project structure, test framework, the SQLite driver, the MCP SDK version.
- The indexer's parser (TypeScript compiler API or tree-sitter), provided it can add
  Python later.
- Exact CLI command names and MCP tool parameter shapes, within the meaning above.
- The default contents of `policy.yaml` and `brief.md` templates.
- How the generator in phase 1 maps current pstack files into `core/`.

## 15. Risks

- **Friction.** Too many denials will push the owner to disable the harness. Mitigation:
  `auto` covers all reversible work; denials always say exactly what to do next.
- **Hook coverage.** Claude Code hook events and fields can change between versions.
  Each phase verifies the needed fields against the installed version; recorded-event
  tests make breakage visible.
- **Context size detection.** Hooks may not receive context-window usage directly. The
  builder must confirm what Claude Code exposes (status line input, transcript size) and
  pick the most reliable signal; if none is reliable, handover stays owner-triggered plus
  `PreCompact`.
- **Concurrency.** Several workers writing to SQLite at once: WAL mode and short
  transactions; claims use a unique constraint so two workers can't both win.
