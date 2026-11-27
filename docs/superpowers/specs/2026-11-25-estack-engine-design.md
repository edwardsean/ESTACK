# estack engine: design

Date: 2026-11-25
Status: approved 2026-11-25; amendment 1 (2026-11-26, code map uses Graphify; revised
2026-11-27 after the phase 5 spike) approved 2026-11-27

**Amendment 1 (2026-11-26, revised 2026-11-27).** The code map is no longer an indexer
the engine builds. It is [Graphify](https://github.com/Graphify-Labs/graphify)
(Apache-2.0), a local tree-sitter knowledge graph, wrapped by the engine behind its own
three tools. Sections 3, 6, 7, 8, 9, 13, 14 and 15 change; nothing in phases 1 to 4
changes. The revision follows the spike on estack itself (section 9, Spike results): the
engine keeps generated and copied code out of the map, builds code-only every time,
backs `find_existing` with a text search, and replaces Graphify's strict mode with its
own "look at the map first" rule, kept per agent.

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
- The code map needs Graphify (`graphifyy` on PyPI, Python 3.11+, installed with `uv` or
  `pipx`). It runs code-only and local: the engine only ever builds with `graphify
  extract <checkout> --code-only`, always with `GRAPHIFY_BACKEND=none` and
  `GRAPHIFY_QUERY_LOG_DISABLE=1`, so no source, doc or image leaves the machine and
  docs stay out of the map. Everything except the code map works without it.

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
  engine/                    TypeScript package: library, MCP server, CLI, Graphify adapter
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
code_map:                 # section 9
  enabled: true           # setup writes false when Graphify is missing or finds no supported language
  exclude: ["dist/**", "build/**", "vendor/**"]   # generated or copied code, kept out of the map
```

The existing `.claude/enterprise/gates.json` and `governance.json` concepts fold into
this one file. Default values ship with `/estack:setup`; the owner edits them.

### Hook table (Claude Code)

| Moment | Hook | Engine check | Outcome |
|---|---|---|---|
| Session starts | `SessionStart` | `estack status --for-session` | Injects active tasks, next step per task, pending approvals, and any handover waiting for this session |
| Owner sends a message | `UserPromptSubmit` | `estack status --brief` | Re-injects the current task and next step (a few lines) |
| Edit / Write / MultiEdit / NotebookEdit | `PreToolUse` | Path in `exempt_paths`? Allow. Otherwise: is there an open task bound to this session or worktree? Is the path protected? Is the file claimed by another task? | **Deny** with a message saying what to do (`start_task`, or wait for the claim). Allow otherwise |
| Read / Grep | `PreToolUse` | Look at the map first (section 9): is the caller an agent on a task whose `reuse_check` is not done, reading a file in the map, with no code-map query of its own yet? | **Deny once** for that agent and task, naming the tool to call. Allow otherwise |
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
- `post-commit`, `post-checkout`, `post-merge` and `post-rewrite`: managed by estack
  like the two above (not `graphify hook install`, which would write the same hook files
  and run its own rebuild). Unlike the two above they run for every git command, the
  owner's own included: they enforce nothing, and the map must follow every change. Each
  starts `estack map update` in the background and returns at once, so git never waits
  and never fails because of it. That is a code-only `graphify extract` of the checkout
  under a per-checkout lock (a build that finds one running waits for it, then rebuilds
  only if files changed since), then, after a commit on a branch with an open task, the
  engine's duplicate check (section 9).

CI is out of scope for the engine, but the same `estack check` command can run there.

### Evidence

A step is complete only with evidence the engine can check, not a sentence:

| Kind | What is stored | How the engine checks it |
|---|---|---|
| `command` | the command, exit code, tail of output, timestamp | The engine runs the command **fixed in `policy.yaml` `commands`** (`estack run --step test`); the agent cannot choose a weaker one. `test` is the fast suite; `verify` is the fuller check (build, e2e) plus a `review` by the verifier |
| `commit` | commit sha | The sha exists and is on the task's branch |
| `pr` | PR URL | `gh pr view` succeeds |
| `review` | reviewer seat, verdict, findings | Written by a different agent than the task's author (agent ids differ) |
| `reuse_check` | the agent's conclusion (what it will reuse, or why nothing fits) and the `code_queries` rows it rests on | Accepted only if the agent completing the step ran at least one `find_existing` or `context_for` for this task itself (`code_queries.recorded_by`). The automatic `context_for` from `start_task` and other agents' queries don't count, and neither does a call that returned an error. The engine ran and logged the queries, so the agent can't describe a search it didn't run. With the code map off (section 9) the step takes a `note` instead |
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
code_queries id, task_id, tool(context_for|find_existing|who_uses), input, result_json,
             ok, graph_version, checkout, recorded_by, at
                                        (every code-map query the engine ran, per task and agent)
events       id, at, actor, kind, task_id, payload_json   (append-only log of everything)
```

A session or worker is bound to a task by `task_bindings`. Hooks find the task from
the hook input's `session_id` and `agent_id`, falling back to the worktree path in `cwd`.

**Skipping a step.** A step can be marked `skipped` only by the owner (`estack skip
<task> <step> --reason`) or when the policy marks it optional for that task type.

## 9. Code map

Purpose: let any session find what already exists, near the code it is about to touch
and anywhere in the repo, so it reuses instead of rewriting.

### Graphify is the map; the engine owns the rules

The graph itself comes from **Graphify**: it parses source with tree-sitter
(deterministic, no LLM, about 40 languages), resolves `calls`, `imports` and `inherits`
across files, and tags every edge `EXTRACTED` (read from the source) or `INFERRED`
(resolved by Graphify). It writes `graphify-out/graph.json` and answers `graphify
query`, `graphify explain` and `graphify path`. This meets the anti-goal "the map is
only ever generated from code": agents never write to it.

What Graphify does not do, and stays in the engine: keeping generated and copied code out
of the map, showing context automatically, sending each agent to the map before it reads
files, recording reuse searches as evidence, flagging duplicates after a commit, and
claims.

### How the engine uses it

- **Install.** `/estack:setup` checks for `graphify` on PATH at a supported version, and
  if it is missing prints the install command (`uv tool install "graphifyy>=0.9.121,<0.10"`);
  it never installs silently. Graphify's own Claude Code hooks and git hooks are not
  installed (`graphify claude install`, `graphify hook install`): estack owns both
  moments (below, and section 7). `graphify-out/` is gitignored.
- **Keep copies out of the map.** Generated and copied code (build output, a bundled
  plugin, vendored libraries, reference copies of other projects) is the same code a
  second time. Left in, it takes over the map: answers point at the copy (an agent then
  edits a file the next build overwrites), names become ambiguous, the size budget fills
  with copies, and the duplicate check matches every function against its own copy. The
  list lives in `policy.yaml` `code_map.exclude` (globs; the file is protected, so an
  agent can't hide code from the map). `/estack:setup` proposes a starting list from what
  it finds (folders named `dist`, `build`, `out`, `vendor`, `third_party`, `generated`;
  paths marked `linguist-generated` or `linguist-vendored` in `.gitattributes`; files
  whose header says they are generated) and shows it to the owner to confirm, folder by
  folder. Generated code that the project's own code calls into (a generated database
  or API client, for example) stays in the map unless the owner says otherwise: hidden,
  an agent could write its own version instead of calling it. Before
  every build the engine writes the list into a gitignored `.graphifyignore` in that
  checkout. For estack itself the list is `adapters/claude-code/**`, `upstream/**` and
  `pstack-qoder/**`.
- **Build: code-only, every time.** The engine only ever runs `graphify extract
  <checkout> --code-only`. It never runs `graphify update`, which stays code-only only
  if the checkout's first build was. The build is incremental: under a second after a
  one-file change on estack. `estack map update` runs it; the git hooks in section 7
  call that.
- **Version pin.** The engine reads `graph.schema_version` (1 today) and
  `graph.graphify_version` from `graph.json` and refuses an unsupported schema with a
  message naming the version it expects, rather than misreading the graph.
- **Worktrees.** A worker's worktree has its own working copy and, being new, no graph
  (`graphify-out/` is not committed). On `start_task` the engine builds that worktree's
  graph, code-only with the same exclude list, so uncommitted work in progress is
  visible; results say which graph they came from ("main" or "task 14's worktree").
  While a checkout has no graph, the code-map tools say so and the "map first" rule
  below does not apply there.
- **Agent tools (MCP), wrapping Graphify:**

| Tool | Runs | Returns |
|---|---|---|
| `context_for(path or area)` | The area's entries in `graph.json` and their edges | The area's imports and the helpers it uses, with file and line; what calls into it; active claims in it |
| `find_existing(description)` | A name match over the graph's functions **plus** a text search of the mapped source files for the description's words | The matching functions and modules, each with file, line, why it matched (name or code text), edge confidence, and owning task if in progress |
| `who_uses(symbol)` | The symbol's incoming edges in `graph.json` (what `graphify explain` shows) | Callers and importers with file and line; when a name exists in several files, the candidates to pick from |

**Graphify builds, the engine reads.** Graphify builds `graph.json`; the engine reads
that file itself for all three tools instead of parsing what `graphify query` and
`graphify explain` print, which is written for people and may change between versions.
It also lets the engine's tests use a small hand-written graph without Graphify
installed. (Revised 2026-11-27 while planning phase 5.)

**Why the text search.** Graphify's own `query` matches the description's words against
names, then walks outward from the matches. In the spike, "run a command with a timeout"
found nothing named "timeout" near `runBounded`, the function that does exactly that,
and missed it. A plain search of the mapped files for the same words finds it, because
its code and comment mention the timeout. The engine maps each text hit to the function
at or right after that line (using the graph's start lines), ranks functions by how many
of the words they hit, merges both lists and drops repeats. The tool's description tells
agents to describe what they need in words likely to appear in code ("format invoice
date", not "make dates look nice").

In phase 5 each call searches the caller's own checkout: a worktree's graph holds `main`
plus that task's work in progress. The "owning task" and "active claims" fields, and
searching other tasks' worktrees, arrive with claims in phase 6.

Each call runs with a time limit and a size budget, is logged in `code_queries` for the
current task and the calling agent, and returns a small result; the whole graph never enters the agent's
context. Because agents only see these three tools, Graphify can be replaced later
without changing any agent.

### Look at the map first: estack's rule, not Graphify's strict mode

Graphify's strict mode denies the first raw Read or Grep in a session until the agent
queries the graph. The spike showed two gaps for the way the owner works (one CTO
session, many workers): the denial is kept per Claude Code session, so subagents share
the main session's single one, and one query by anyone switches it off for every session
in that checkout for 30 minutes. Workers would almost never be sent to the map. estack
does not install it.

The engine's own `PreToolUse` hook on Read and Grep enforces the same idea with what the
engine knows (agent ids, tasks, `code_queries`):

- It applies to an agent bound to an open task whose `reuse_check` step is not done yet,
  the stage where the agent is working out what to build.
- That agent's first Read of a file in the map, or first Grep inside the repository, on
  that task is denied **once** unless the agent already ran a code-map tool for the task.
  The denial names what to call (`context_for` on the area, or `find_existing`). After
  one denial, reads go through whether or not the agent queried, so it is never stuck.
  The denial is logged as an event, which is how "once" is kept.
- It never applies to agents not on a task, to tasks past `reuse_check` (so the verifier
  and reviewer, who read specific changed files, are never bounced), to exempt paths, to
  files not in the map, or to a checkout with no graph.
- Bash commands that read files (`cat`, `rg`) are not checked: a shell command has no
  single target. This rule only sets the order; the reuse guarantee is the
  `reuse_check` step, whose evidence is queries the engine ran.

### When the map is off or broken

- **Off.** If Graphify isn't installed, or the repository has no language it supports,
  `/estack:setup` says so and writes `code_map: { enabled: false }` into `policy.yaml`
  (protected, so only the owner turns it back on by re-running setup). Then the
  code-map tools answer "the code map is off", the "map first" rule does nothing, there
  is no duplicate check, and `reuse_check` takes a `note` saying what was searched and
  found. Everything else works as before.
- **Broken.** With the map on, a build or query that fails or times out returns the error
  to the agent, is logged in `code_queries` with `ok` false, and does not count as
  `reuse_check` evidence. The agent tells the owner, who fixes it (`estack map update`
  shows the error) or runs `estack skip <task> reuse_check --reason`. A broken map stops
  the step with a clear message rather than letting it pass quietly.

### Spike results (2026-11-27)

Run on estack itself with Graphify 0.9.121, code-only, in a throwaway worktree.

| Question | Result |
|---|---|
| Build time | 13.5 s for the whole repo; 1.7 s with copies excluded (925 nodes, 2,490 edges); 0.8 s after a one-file change |
| Copies | About 80% of the unfiltered map was generated or copied code (`adapters/claude-code/`, `upstream/`, `pstack-qoder/`). Answers pointed at the built copy, and `explain pendingHandovers` came back ambiguous between the source and its copy |
| `who_uses` (`explain`) | Exact: every caller and importer of `pendingHandovers`, with file and line, edges marked `EXTRACTED` |
| `find_existing` (`query`) | Keyword match on names: found `runBounded` for "bounded command", missed it for "run a command with a timeout" |
| Duplicates | Found a real one by name: `iso()` is defined in both `handover.ts` and `tasks.ts`. Can't see copy-pasted lines inside functions (the same escaping line appears twice in `handover.ts`) |
| What a function entry holds | Name, file, start line, and `calls` / `imports` / `contains` edges. No end line, no parameters |
| Strict mode | Works in a live headless session: one Grep denied, the agent ran `graphify explain` and answered correctly in 5 turns. But per session, not per agent, and any query unlocks every session for 30 minutes |
| Fresh worktree | No graph (it is not committed), so nothing applies there until a build |

### How it stops the `utils.ts` failure

1. When a worker starts a task on a service, `start_task` returns `context_for` that
   service automatically, so `utils.ts` and its functions are in front of the agent
   before it writes anything.
2. The "map first" rule sends each agent, on its own task, to the map before it starts
   reading files one by one.
3. Every code task type has a `reuse_check` step before `implement`. Its evidence is the
   `code_queries` rows for this task: the engine ran them, so the agent can't claim a
   search it didn't do.
4. After a commit, the engine compares newly added top-level functions (from the updated
   graph) with existing ones in the map: same or similar name (ignoring case,
   separators and common prefixes such as `get` or `make`) and a similar parameter
   list, which the engine reads from the source line the graph points to, since the
   graph holds no parameters. Because copies are excluded, a function is never matched
   against its own built copy. A match is recorded as a `possible_duplicate` event, and
   the task's `verify` step (present in every code task type; `review` is not) can't be
   completed while it is open. It closes when a later commit removes the match (the
   next check no longer finds it), or when an agent other than the task's author (the
   agent that recorded its latest commit, as for `review`) dismisses it with a reason
   through a `dismiss_duplicate` tool. The author can't dismiss its own; the owner can
   always `estack skip`. Completing `verify` first runs any duplicate check still
   pending for the task's latest commit.

**What it does not catch.** Copy-pasted lines inside functions, and a helper rewritten
under an unrelated name. The map works on named functions. A copy-paste detector (for
example jscpd) could be added later as a separate check.

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
| 1 | Restructure into `core/` + generated `adapters/claude-code/`, and **rename the plugin `pstack` → `estack`** (owner's decision): `/estack:<skill>`, seats `estack:<seat>`, `~/.claude/rules/estack-models.md`, marketplace `estack` | Generated plugin passes the selftest (updated for the new name); behaviour otherwise unchanged. `/estack:setup` replaces `/pstack:setup-enterprise`; the gates keep reading `.claude/enterprise/gates.json` until phase 3 moves them to `.estack/policy.yaml` |
| 2 | Engine core: tasks, steps, evidence (incl. `estack run`), approvals, events; MCP server + CLI; `/estack:setup` | Tests cover the step state machine and evidence rules; a task can be driven end to end through MCP tools |
| 3 | Claude Code hooks + git hooks wired to the engine, replacing the current gate scripts | Recorded-event tests (like today's `test-gates.py`) for every row of the hook table; a live session check that an edit with no task is denied |
| 4 | Handover | A task interrupted mid-run is resumed in a fresh session from the handover alone |
| 5 | Code map. Spike done 2026-11-27 on estack itself (section 9, Spike results). Then: the engine's Graphify adapter (code-only builds, exclude list, version pin, worktree builds), `context_for` / `find_existing` (with the text search) / `who_uses`, `code_queries` as `reuse_check` evidence, the "map first" Read/Grep rule, the post-commit duplicate check, setup checking for Graphify and proposing the exclude list, estack's own post-commit/checkout/merge/rewrite git hooks | On a fixture repo reproducing the `utils.ts` failure, with a generated copy of the code in it: the second task is shown the helper, never its copy; its worker is sent to the map once and its reviewer never; the duplicate is flagged if written anyway, holds back `verify` until a different agent dismisses it, and nothing is matched against the copy; with `code_map.enabled: false` every task type still runs end to end |
| 6 | Parallel: `plan_tasks` overlap detection, claims, worktree creation | Two workers on overlapping tasks: the shared helper is built once; a claimed file edit is denied |
| 7 | Second adapter (Cursor or OpenCode) | Same engine, same policy, the core flows work in that agent |

## 14. Left to the builder

- TypeScript project structure, test framework, the SQLite driver, the MCP SDK version.
- How the engine runs Graphify's build, provided it is time-limited and code-only, and
  how it reads `graph.json`, provided every tool call is logged in `code_queries`.
- The duplicate-match heuristic's exact thresholds, and how a parameter list is read
  from the source line.
- `find_existing`'s text search: the search tool, how words are taken from the
  description (dropping common words), ranking, and how hits are merged with Graphify's.
- How `/estack:setup` detects generated and copied folders, within the signals listed
  in section 9.
- Whether a new worktree's first build is seeded from the main checkout's Graphify cache,
  if a full build proves slow on a large repository.
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
- **Graphify changes fast.** It is on version 0.9 (0.9.121 at the spike), releases
  often, and is very active. Mitigation: pin a supported range (`>=0.9.121,<0.10`),
  check `graph.schema_version`, and keep it behind the engine's three tools so a change
  touches one adapter.
- **A copy left in the map.** If the exclude list misses a generated or copied folder,
  answers point at the copy again and duplicates multiply. Mitigation: setup proposes
  the list from what it finds; `estack map status` shows how much of the map each
  top-level folder takes, so a folder that is mostly copies stands out.
- **`find_existing` misses.** Both Graphify's query and the text search match words, not
  meaning, so a helper described in different words can still be missed. Mitigation:
  `context_for` on the area being changed is shown automatically at `start_task`, and
  the post-commit duplicate check catches a same-named rewrite. A meaning-based search
  is possible later behind the same tool.
- **Graphify upsell and data.** Its README pushes a hosted product, and its semantic pass
  sends docs and media to an LLM when an API key is present. estack uses only the local
  open-source CLI, always with `GRAPHIFY_BACKEND=none`. Graphify also logs every query to
  `~/.cache/graphify-queries.log`; the engine sets `GRAPHIFY_QUERY_LOG_DISABLE=1`, since
  its own `code_queries` table is the record.
- **"Map first" friction.** One denial per agent per task, only before `reuse_check`, and
  never for the verifier or reviewer. If it still proves annoying, it can be turned into
  a reminder instead of a denial; the `reuse_check` step still enforces the part that
  matters.
