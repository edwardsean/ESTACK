---
name: setup-models
description: Configure which model each estack and enterprise seat runs on, and at what reasoning effort. Writes {{estack:models_file}}, one line per seat, which the orchestrator reads to pass model and effort on every Agent call that dispatches a seat. Use for /setup-models, "configure estack models", "estack budget", "configure enterprise seats", or changing estack's model choices.
---
# Setup estack

estack routes work to seats, and a seat is a plugin subagent registered as `{{estack:ns}}:<seat>`. Each seat's agent file carries a default `model` and `effort`. Claude Code's `Agent` tool also takes `model` and `effort` per call, and a per-call value wins over the frontmatter. So changing a seat's model means writing a line the dispatcher reads, not editing the plugin.

Twenty-eight seats ship with this plugin. Ten are estack's, routed by skills. Eighteen more are the enterprise roster, routed by the `/{{estack:ns}}:poteto-mode` orchestration loop. Both kinds are configured the same way here, and a repository that never runs an enterprise chain can skip those five family questions entirely.

This skill writes one file, `{{estack:models_file}}`. Claude Code loads every `.md` file in `~/.claude/rules/` into each new session, so the seat lines are already in context when a skill dispatches. Every dispatching skill follows the same rule: find the seat's line, pass its `model` and `effort` on the `Agent` call, and when there is no line, pass neither and let the frontmatter decide.

## Seats

| Role | Seat agent | Plugin default model | Default effort |
|---|---|---|---|
| Implementation | `{{estack:ns}}:poteto-agent` | `opus` | high |
| Architecture and planning | `{{estack:ns}}:estack-architect` | `opus` | xhigh |
| Review and design panel, seat 1 | `{{estack:ns}}:estack-panel-1` | `opus` | high |
| Review and design panel, seat 2 | `{{estack:ns}}:estack-panel-2` | `sonnet` | high |
| Review and design panel, seat 3 | `{{estack:ns}}:estack-panel-3` | `inherit` | high |
| Independent judgment | `{{estack:ns}}:estack-judge` | `inherit` | high |
| Verification and swarm workers | `{{estack:ns}}:estack-verifier` | `sonnet` | high |
| Read-only understanding | `{{estack:ns}}:estack-explorer` | `haiku` | medium |
| Mechanical bulk edits | `{{estack:ns}}:estack-mechanic` | `sonnet` | medium |
| Comment review | `{{estack:ns}}:comment-sicko` | `sonnet` | high |

### Enterprise roster

Eighteen more seats in five families, dispatched by the `/poteto-mode` orchestration loop rather than by a skill of their own. The roster and its invariants live in the **enterprise-seats** skill. Ask about these once per family, not once per seat, because a family shares a responsibility boundary and a user routing one of them almost always routes the rest the same way.

| Role | Seat agent | Plugin default model | Default effort |
|---|---|---|---|
| Requirements | `{{estack:ns}}:ent-product-analyst` | `sonnet` | high |
| Business rules | `{{estack:ns}}:ent-business-analyst` | `sonnet` | high |
| PRD authoring | `{{estack:ns}}:ent-prd-agent` | `sonnet` | high |
| System shape | `{{estack:ns}}:ent-system-architect` | `opus` | xhigh |
| API contracts | `{{estack:ns}}:ent-api-architect` | `opus` | xhigh |
| Schema and migrations | `{{estack:ns}}:ent-database-architect` | `opus` | xhigh |
| Service implementation | `{{estack:ns}}:ent-backend-engineer` | `opus` | high |
| Web surface | `{{estack:ns}}:ent-frontend-engineer` | `opus` | high |
| Mobile client | `{{estack:ns}}:ent-mobile-engineer` | `opus` | high |
| Data access layer | `{{estack:ns}}:ent-database-engineer` | `opus` | high |
| Cross-service glue | `{{estack:ns}}:ent-integration-engineer` | `opus` | high |
| Test design and execution | `{{estack:ns}}:ent-qa-engineer` | `opus` | xhigh |
| Security assessment, read-only | `{{estack:ns}}:ent-security-engineer` | `opus` | xhigh |
| Independent code review, read-only | `{{estack:ns}}:ent-code-reviewer` | `opus` | xhigh |
| Measurement and budgets | `{{estack:ns}}:ent-performance-engineer` | `opus` | xhigh |
| Pipeline and infrastructure | `{{estack:ns}}:ent-devops-engineer` | `sonnet` | high |
| Incident system view | `{{estack:ns}}:ent-sre` | `sonnet` | high |
| Logs, metrics, traces | `{{estack:ns}}:ent-observability` | `sonnet` | high |

## Steps

### 1. Establish what the user can actually run

The `Agent` tool's `model` parameter takes an alias: `opus`, `sonnet`, `haiku`, or `fable`. It does not take `inherit` or a full model id. The `effort` parameter takes `low`, `medium`, `high`, `xhigh`, or `max`, and the levels a model accepts depend on the model. Read the two enums from the `Agent` tool schema this session exposes, since that is the dependable source, and offer only values it lists.

`inherit` is always valid as a line value and means "run on the chat's model". The `Agent` tool cannot take it, so a dispatcher resolves it to the alias of the model the chat is running on, and omits `model` when it does not know that. Say so when you offer it.

Check two environment variables before promising anything. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` makes Claude Code ignore both the frontmatter and the per-call model, and `CLAUDE_CODE_EFFORT_LEVEL` overrides every per-call effort. When either is set, say that this file will be read and not obeyed. The per-call `effort` parameter needs Claude Code v2.1.292 or later, so check `claude --version` and say so when it is older.

### 2. Load current state

Read `{{estack:models_file}}` when it exists. Treat its seat lines as prior choices and its `# budget` line as the current budget.

A file without a `# defaults: 3` line came from an older run or was written by hand. Read each value as `<model> <effort>`, take the seat's frontmatter effort where the effort token is missing, and drop any value whose model token is not `inherit` or a listed alias. Tell the user which values you kept, filled in, or dropped, then rewrite the file whole.

### 3. Ask, per role bucket

Prefer `AskUserQuestion` over free text. Ask the estack seats in the buckets below, one question per bucket the user cares about routing separately:

- Architecture and planning (`{{estack:ns}}:estack-architect`)
- Implementation (`{{estack:ns}}:poteto-agent`)
- Code review and design (the three panel seats)
- Independent judgment (`{{estack:ns}}:estack-judge`)
- Verification (`{{estack:ns}}:estack-verifier`)

Offer the aliases the schema lists, plus `inherit` for "follow the chat's model". Ask the three support seats (`{{estack:ns}}:estack-explorer`, `{{estack:ns}}:estack-mechanic`, `{{estack:ns}}:comment-sicko`) in one follow-up question rather than three.

For the panel bucket, explain the tradeoff before asking. Three seats on three different models give the widest panel Claude Code can field. Three seats on one model give three samples of the same judgment, which still catches nondeterminism but not blind spots. Every model here is Anthropic's, so even three different models are one vendor. Let the user pick, and record which they picked.

For the judge, recommend a model that differs from the one the user usually chats on, since the judge defaults to `inherit` and an `inherit` judge is the parent model grading its own panel.

Then five more questions, one per enterprise family:

- Product and requirements (`{{estack:ns}}:ent-product-analyst`, `{{estack:ns}}:ent-business-analyst`, `{{estack:ns}}:ent-prd-agent`)
- Architecture and design (`{{estack:ns}}:ent-system-architect`, `{{estack:ns}}:ent-api-architect`, `{{estack:ns}}:ent-database-architect`)
- Engineering (`{{estack:ns}}:ent-backend-engineer`, `{{estack:ns}}:ent-frontend-engineer`, `{{estack:ns}}:ent-mobile-engineer`, `{{estack:ns}}:ent-database-engineer`, `{{estack:ns}}:ent-integration-engineer`)
- Quality and governance (`{{estack:ns}}:ent-qa-engineer`, `{{estack:ns}}:ent-security-engineer`, `{{estack:ns}}:ent-code-reviewer`, `{{estack:ns}}:ent-performance-engineer`)
- Infra and operations (`{{estack:ns}}:ent-devops-engineer`, `{{estack:ns}}:ent-sre`, `{{estack:ns}}:ent-observability`)

Ask each family as one question with one answer applied to every seat in it, and offer "split this family" as an option so a user who wants `{{estack:ns}}:ent-code-reviewer` on a different model than `{{estack:ns}}:ent-qa-engineer` can say so instead of editing the file afterwards. Skip a family the repository will never dispatch, and say which ones you skipped.

One independence note matters more than the rest. Where the governance policy requires a review, `{{estack:ns}}:ent-code-reviewer` and `{{estack:ns}}:ent-security-engineer` should not sit on the same model as the engineering seats whose work they review, because a model grades its own output generously. Say that before asking the quality family, and record what the user chose.

Ask about effort separately, once, as a budget:

- `large` keeps each seat's default effort
- `medium` lowers each one step on the ladder `xhigh` > `high` > `medium` > `low`
- `small` lowers each two steps

A step below `low` stays at `low`. No seat runs above `xhigh` unless the user names `max` for it explicitly.

### 4. Validate

Every model token you are about to write is `inherit` or an alias the `Agent` tool schema lists. Every effort token is a level that schema lists. Anything else stops the run and goes back to step 3.

### 5. Write the rule

Write `{{estack:models_file}}` with no frontmatter. Overwrite the whole file so re-runs stay idempotent. One line per seat, `<seat>: <model> <effort>`, with the seat name as its agent file names it, no `{{estack:ns}}:` prefix. Omit a seat the user left on its plugin default, including a whole enterprise family the repository will never dispatch. A shorter file is a truer one, and an omitted seat runs on its frontmatter.

```markdown
# estack model configuration for Claude Code
# Written by /{{estack:ns}}:setup-models. One line per seat: `<seat>: <model> <effort>`.
# Before an Agent call to `{{estack:ns}}:<seat>`, pass this line's model and effort on the call.
# `inherit` means the chat's own model: pass the chat's alias, or omit `model` when unknown.
# No line for a seat: pass neither, and the seat's frontmatter decides.
# defaults: 3
# budget: <large | medium | small>

poteto-agent: <model> <effort>
estack-architect: <model> <effort>
estack-panel-1: <model> <effort>
estack-panel-2: <model> <effort>
estack-panel-3: <model> <effort>
estack-judge: <model> <effort>
estack-verifier: <model> <effort>
estack-explorer: <model> <effort>
estack-mechanic: <model> <effort>
comment-sicko: <model> <effort>

ent-product-analyst: <model> <effort>
ent-business-analyst: <model> <effort>
ent-prd-agent: <model> <effort>
ent-system-architect: <model> <effort>
ent-api-architect: <model> <effort>
ent-database-architect: <model> <effort>
ent-backend-engineer: <model> <effort>
ent-frontend-engineer: <model> <effort>
ent-mobile-engineer: <model> <effort>
ent-database-engineer: <model> <effort>
ent-integration-engineer: <model> <effort>
ent-qa-engineer: <model> <effort>
ent-security-engineer: <model> <effort>
ent-code-reviewer: <model> <effort>
ent-performance-engineer: <model> <effort>
ent-devops-engineer: <model> <effort>
ent-sre: <model> <effort>
ent-observability: <model> <effort>

Swarm workers: <seat, default estack-verifier>
Panel diversity: <three distinct models | two distinct models | one model, three samples>
Judge independence from the parent model: <different model, same vendor | same model, does not hold | unknown>
Reviewer independence from the engineering seats: <different model, same vendor | same model, does not hold | not configured>
```

The `# defaults: 3` line marks this schema version. Version 3 is the first to carry an effort token, and the first written for Claude Code. Never put these lines in `CLAUDE.md`, which is project-scoped and committed.

### 6. Confirm

Tell the user what was written and where, and that it applies to new sessions, since Claude Code loads `~/.claude/rules/` when a session starts. In a session that is already open, the orchestrator can read the file directly, so an edit applies to the next dispatch once it is read. Name the seats left on plugin defaults, and the enterprise families skipped entirely, since a skipped family is the difference between "on its default" and "this repo will never dispatch it".

State plainly what independence holds. A judge on a different model than the parent is a different model from the same vendor, not the cross-vendor judge upstream pstack asks for, and a judge on the same model is no independence at all. Say the same about the reviewer seats, because an enterprise chain leans on that independence for every review its governance policy requires.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /{{estack:ns}}:create-verification-skill." On yes, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/create-verification-skill/SKILL.md`. On no, move on without pushing.

Claude Code resolves project skills from `.claude/skills/<name>/SKILL.md`, so that is where the generated skill goes.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill. If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /{{estack:ns}}:create-formal-verification-skill." On yes, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/create-formal-verification-skill/SKILL.md`. On no, move on without pushing.

## What this skill cannot do

It cannot make a judge independent of the vendor that trained the author, because every model Claude Code runs is Anthropic's. It cannot force a model when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set. And it writes a rule a dispatcher reads, so a dispatch that skips the lookup runs on the frontmatter default. Every seat reports the model it ran on in its first line for exactly that reason, and the orchestrator cites the report rather than this file.
