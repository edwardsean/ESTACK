# Model routing

How to put a specific model and effort behind a specific seat in the Claude Code
edition of pstack, what Claude Code lets you change, and what it does not.

## How routing works here

Upstream pstack names a model at dispatch time. Its orchestrator holds a routing
table of model slugs and passes one when it spawns a subagent.

Claude Code can do the same. The `Agent` tool takes `model` and `effort` on each
call, and a per-call value wins over the subagent's frontmatter. So this edition
routes in two layers:

1. **The seat** picks the brief, the tool list, the isolation, and a default
   `model` and `effort`, from its file under `agents/`. Claude Code registers each
   one as `estack:<seat>`.
2. **The call** picks the model and effort that actually run, from the seat's line
   in `~/.claude/rules/estack-models.md`. With no line, the call passes neither and
   the frontmatter decides.

```yaml
---
name: estack-judge
model: inherit
effort: high
---
```

```text
# ~/.claude/rules/estack-models.md
estack-judge: sonnet high
```

The seats survive from the Qoder edition, which needed one agent per model,
because each one also carries a contract: read-only tools for a reviewer,
`isolation: worktree` for a panel arm, `disallowedTools: [Agent]` for every
enterprise seat. Panel width is still three seats, and because the model is a
call parameter a dispatcher can also run one seat twice on two models.

## The seats

| Seat | Role | Default `model` | Default `effort` | Write access | Isolation |
|---|---|---|---|---|---|
| `estack:estack-architect` | Architecture and planning | `opus` | `xhigh` | yes | workspace |
| `estack:poteto-agent` | Implementation | `opus` | `high` | yes | workspace |
| `estack:estack-panel-1` | Review panel, first arm | `opus` | `high` | yes | worktree |
| `estack:estack-panel-2` | Review panel, second arm | `sonnet` | `high` | yes | worktree |
| `estack:estack-panel-3` | Review panel, third arm | `inherit` | `high` | yes | worktree |
| `estack:estack-judge` | Independent judgment | `inherit` | `high` | no | workspace |
| `estack:estack-verifier` | Verification | `sonnet` | `high` | repros only | worktree |
| `estack:estack-explorer` | Read-only understanding | `haiku` | `medium` | no | workspace |
| `estack:estack-mechanic` | Mechanical bulk edits | `sonnet` | `medium` | yes | workspace |
| `estack:comment-sicko` | Comment review | `sonnet` | `high` | no | workspace |

The three read-only seats have no `Write` or `Edit` in their `tools` list, and
the `Agent` tool has no per-call readonly flag, so the restriction lives in the
agent definition and cannot be relaxed at dispatch time.

`estack:estack-verifier` does carry `Write` and `Edit`, because a verifier that
cannot build a repro cannot prove much. It runs under `isolation: worktree`, so
Claude Code gives it a temporary git worktree and the verdict stays attributable.
Its contract forbids editing the code under review.

### The enterprise roster

Eighteen more seats ship for the enterprise extension, grouped in five families.
The `/estack:poteto-mode` orchestration loop dispatches them, and
`/estack:setup-models` asks one question per family and writes one line per seat.

| Family | Seats | Default `model` | Default `effort` | Write access | Isolation |
|---|---|---|---|---|---|
| Product and requirements | `estack:ent-product-analyst`, `estack:ent-business-analyst`, `estack:ent-prd-agent` | `sonnet` | `high` | yes | workspace |
| Architecture and design | `estack:ent-system-architect`, `estack:ent-api-architect`, `estack:ent-database-architect` | `opus` | `xhigh` | yes | workspace |
| Engineering | `estack:ent-backend-engineer`, `estack:ent-frontend-engineer`, `estack:ent-mobile-engineer`, `estack:ent-database-engineer`, `estack:ent-integration-engineer` | `opus` | `high` | yes | worktree |
| Quality and governance | `estack:ent-qa-engineer`, `estack:ent-security-engineer`, `estack:ent-code-reviewer`, `estack:ent-performance-engineer` | `opus` | `xhigh` | two of the four are read-only | worktree for `estack:ent-performance-engineer`, workspace for the rest |
| Infra and operations | `estack:ent-devops-engineer`, `estack:ent-sre`, `estack:ent-observability` | `sonnet` | `high` | yes | workspace |

The two read-only seats are `estack:ent-security-engineer` and
`estack:ent-code-reviewer`. All eighteen carry `disallowedTools: [Agent]`, which
is the frontmatter form of the invariant that an agent never controls the overall
workflow. Only `estack:ent-integration-engineer` gets `WebFetch` and `WebSearch`.
The **enterprise-seats** skill is the catalog the model reads at dispatch time.

## The model values

Agent frontmatter takes `opus`, `sonnet`, `haiku`, `fable`, a full model id, or
`inherit`. The `Agent` tool's `model` parameter takes only the four aliases, not
a full id and not `inherit`. So a line reading `inherit` means "this chat's
model", and the dispatcher passes the chat's alias, or omits `model` and says so
when it does not know it.

The Qoder edition's aliases map as follows. This is what the port's lever applied
to every agent file:

| Qoder alias | Claude Code |
|---|---|
| `performance` | `opus` |
| `efficient` | `sonnet` |
| `lite` | `haiku` |
| `auto` | `inherit` |
| `inherit` | `inherit` |

Qoder's `auto` let Qoder pick per turn. Claude Code has no such alias, so the
two seats that shipped on it, `estack:estack-panel-3` and `estack:estack-judge`,
now follow the chat's model. Pin both in `~/.claude/rules/estack-models.md` if
you want them to differ from it, which the judge almost always should.

Effort takes `low`, `medium`, `high`, `xhigh`, or `max`, and the levels a model
accepts depend on the model. The per-call `effort` parameter needs Claude Code
v2.1.292 or later.

## Changing a seat's model

### The supported way

Run `/estack:setup-models`. It reads the values the `Agent` tool schema accepts,
asks for a reasoning budget, shows you each seat, and writes
`~/.claude/rules/estack-models.md` with one `<seat>: <model> <effort>` line per
seat you changed. Claude Code loads every file in `~/.claude/rules/` into each
new session, so the lines are in context whenever a skill dispatches.

### By hand

Write the line yourself. The seat name is the agent file's name, without the
`estack:` prefix:

```text
estack-architect: opus xhigh
estack-judge: sonnet high
ent-code-reviewer: opus xhigh
```

Delete a line to fall back to the seat's frontmatter. Do not put these lines in
`CLAUDE.md`, which is committed and shared.

### What beats the file

Claude Code resolves a subagent's model in this order: the per-call `model`
parameter, then the subagent's frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`,
then the parent's model. Two settings override everything this file does:

- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` ignores both the frontmatter and the
  per-call model.
- `CLAUDE_CODE_EFFORT_LEVEL` takes precedence over both the frontmatter and the
  per-call effort.

`/estack:setup-models` checks both and says when the file will be read and not
obeyed.

### Making it take effect

A new session reads `~/.claude/rules/` at start. In an open session, ask the
agent to read the file, and the next dispatch uses it. No restart is needed,
because the lookup happens at dispatch time rather than at plugin load.

### What does not work

Copying a seat to `~/.claude/agents/estack-judge.md` creates a second agent named
`estack-judge`, beside the plugin's `estack:estack-judge`. estack dispatches the
scoped name, so the copy is never reached. Editing the plugin's own agent file
works until the next plugin update overwrites it. Use the rule file.

## The judge independence caveat

Upstream pstack requires the cross-judge in `/arena` Phase C to come from a
different model vendor than the one that produced the candidates, on the sound
principle that a model grades its own output generously.

**This edition cannot deliver that.** Every model Claude Code runs is
Anthropic's. What it can deliver is a different model: pass a `model` on the
judge's call that differs from the panel's and from the chat's. That is a second
reading by a different model of the same vendor, not a cross-vendor opinion.

`estack:estack-judge` reports the model it ran on in the first line of its reply.
The caller compares that to the models that produced the candidates. When they
match, it says the independence check did not hold. When they differ, it still
says the judge is the same vendor, rather than presenting the verdict as
cross-vendor.

This affects four places in the plugin: `/arena` Phase C, the eval playbook,
`show-me-your-work`, and the design page of the guide.

## Cost

estack spends extra tokens on subagents and review panels. To spend fewer:

- Move a seat down a tier. `opus` to `sonnet` to `haiku` is the direct saving,
  and it does not change which seat answers.
- Drop an effort. `xhigh` to `medium` cuts reasoning tokens without changing the
  model, and it is now a one-line change per seat.
- Set a seat to `inherit` and let the chat's model absorb the work.
- Dispatch two panel seats instead of three. `/arena` narrows the panel when you
  ask it to, and says the panel lost diversity.
- Reserve `/estack:poteto-mode` for work that needs rigor.

## Adding a seat

Author a fourth panel agent under `agents/`, copying `agents/estack-panel-3.md`
as the template. It needs `name`, `description`, `model`, and `effort` at
minimum. Then:

- Add it to the panel dispatch list in `skills/arena/SKILL.md` and
  `skills/interrogate/SKILL.md`, as `estack:<name>`, or it will never be reached.
- Add a row to the seat table in `skills/estack-seats/SKILL.md`.
- Add it to the `expected` map in `check_workflow()` in `scripts/selftest.py`.
- Give it `isolation: worktree` if it writes, and `disallowedTools: [Agent]`
  unless it genuinely needs to fan out.

Do not set `hooks`, `mcpServers`, `permissionMode`, or `initialPrompt`. Claude
Code ignores all four on plugin subagents, so they would be dead weight that
looks like configuration. `scripts/selftest.py` fails on any of them.

## Related

- [COMPATIBILITY.md](../COMPATIBILITY.md) for the full feature matrix
- [Setup walkthrough](./guide/01-setup.md) for the guided version of all this
- [skills/estack-seats/SKILL.md](../skills/estack-seats/SKILL.md) for the seat catalog and the dispatch rule
- [skills/enterprise-seats/SKILL.md](../skills/enterprise-seats/SKILL.md) for the enterprise roster and its two invariants
- [ENTERPRISE-ARCHITECTURE.md](./ENTERPRISE-ARCHITECTURE.md) for the six-layer design the roster came from
