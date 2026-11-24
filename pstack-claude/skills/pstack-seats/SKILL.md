---
name: pstack-seats
description: Use when a pstack skill dispatches a subagent, when choosing which pstack seat or plugin subagent to delegate to, when running /arena, /swarm, /interrogate, or /setup-pstack, or when reporting which model actually ran.
---
# pstack seats

pstack routes work to plugin subagents by role. Each role is a seat, each seat is one agent file under the plugin's `agents/`, and Claude Code registers each as `pstack:<seat>`. Pick the seat by the job, then dispatch it with the `Agent` tool and `subagent_type: "pstack:<seat>"`. A bare seat name does not resolve.

This skill loads on demand by its description, so the catalog costs nothing on turns that do not delegate. Copy it into `~/.claude/rules/` if you want the catalog in context on every turn.

| Seat | Agent | Use it for | Default model | Effort |
|---|---|---|---|---|
| Implementation | `pstack:poteto-agent` | code writing, bug fixes, features, refactors, any delegate inside a playbook | `opus` | high |
| Architecture and planning | `pstack:pstack-architect` | types, signatures, module boundaries, before code crosses a function boundary | `opus` | xhigh |
| Review and design panel | `pstack:pstack-panel-1`, `pstack:pstack-panel-2`, `pstack:pstack-panel-3` | arena bakeoffs and interrogate adversaries. Dispatch all three in one message or there is no panel | `opus`, `sonnet`, `inherit` | high |
| Independent judgment | `pstack:pstack-judge` | scoring candidates against a rubric it did not write, re-running claimed findings | `inherit` | high |
| Verification | `pstack:pstack-verifier` | swarm workers, proving a PR before it lands, checking a claimed fix | `sonnet` | high |
| Read-only understanding | `pstack:pstack-explorer` | how does X work, why was X built this way, investigation playbooks | `haiku` | medium |
| Mechanical bulk edits | `pstack:pstack-mechanic` | renames, codemod sweeps, edits that need no design judgment | `sonnet` | medium |
| Comment review | `pstack:comment-sicko` | the comment pass behind `/no-comments` | `sonnet` | high |

## Rules for picking a seat

- The chat that receives `/poteto-mode` runs the playbook itself. It never dispatches `pstack:poteto-agent` to run the playbook.
- A panel is three seats dispatched in one message. One seat is not a panel and gives no diversity.
- The verifier is never the author. A seat that wrote the change does not prove it.
- `pstack:pstack-judge` and `pstack:pstack-explorer` and `pstack:comment-sicko` are read-only. Do not ask them to fix anything.
- Every seat reports the model it ran on in its first line. Cite that in your summary rather than the configured default.

## Dispatching a seat

Every `Agent` call that dispatches a seat follows the same three steps.

1. Find the seat's line in `~/.claude/rules/pstack-models.md`, written by `/pstack:setup-pstack` as `<seat>: <model> <effort>`. Claude Code loads that file into every new session, so the line is usually already in context. If it is not, read the file.
2. With a line, pass its model as `model` and its effort as `effort` on the call. `inherit` means the chat's model: pass the alias of the model this chat runs on, or omit `model` when you do not know it and say so. With no line, pass neither, and the seat's frontmatter decides.
3. Add `isolation: "worktree"` on the call when the work writes and the seat does not already carry `isolation: worktree` in its frontmatter.

Subagents run in the background by default and notify the dispatcher when they finish. Dispatch independent seats in one message so they run concurrently, then wait for every notification before reading results.

## Changing a seat's model

A seat's defaults live in its agent frontmatter. A line in `~/.claude/rules/pstack-models.md` overrides both on each call. Run `/pstack:setup-pstack` to write the lines, or edit one by hand:

```
pstack-judge: sonnet high
```

The `Agent` tool takes `opus`, `sonnet`, `haiku`, or `fable` as `model`, and `low`, `medium`, `high`, `xhigh`, or `max` as `effort`. It takes no full model id and no `inherit`. Two environment variables beat this file: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` ignores both the frontmatter and the per-call model, and `CLAUDE_CODE_EFFORT_LEVEL` overrides every per-call effort. The per-call `effort` parameter needs Claude Code v2.1.292 or later.

Copying a seat to `~/.claude/agents/` creates a second agent with the bare name rather than replacing `pstack:<seat>`, so it changes nothing pstack dispatches. Use the rule file.

Every seat still reports the model it ran on in its first line. Cite that report, not this file, because a dispatch that skipped the lookup ran on the frontmatter default.
