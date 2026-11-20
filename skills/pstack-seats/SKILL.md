---
name: pstack-seats
description: Use when a pstack skill dispatches a subagent, when choosing which pstack seat or Custom Agent to delegate to, when running /arena, /swarm, /interrogate, or /setup-pstack, or when reporting which model actually ran.
---
# pstack seats

pstack routes work to Custom Agents by role. Qoder binds a model to an agent, not to a call, so each role is a seat and each seat is one agent. Pick the seat by the job, then dispatch it with the `Agent` tool.

This rule is `model_decision` rather than `always_on`, because the catalog is only needed on turns that delegate. Change the trigger to `always_on` in your own copy if you want it in context every turn.

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

## Changing a seat's model

A seat's model lives in its agent frontmatter, and `settings.json` overrides it. Run `/setup-pstack` to write the overrides, or edit them by hand:

```json
{
  "agents": {
    "overrides": {
      "pstack-judge": { "modelConfig": { "model": "<your model name>" } }
    }
  }
}
```

Plugin agents outrank user and project agents of the same name, so a file at `~/.qoder/agents/poteto-agent.md` will be shadowed rather than taking effect. Use `settings.json`.

Qoder documents no reload path for `agents.overrides` in the IDE. Start a new chat after editing it, and restart Qoder if the seat still reports the old model. Qoder CLI reloads agent definitions with `/agents reload`.

When `~/.claude/rules/pstack-models.md` exists, it records the choices `/setup-pstack` wrote and takes precedence over the defaults in the table above for reporting and seat selection.
