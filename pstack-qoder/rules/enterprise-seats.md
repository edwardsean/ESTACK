---
trigger: model_decision
description: Use when an enterprise playbook or the /poteto-mode orchestration loop picks a specialist seat, when deciding whether a step needs a product, architecture, engineering, quality, or operations agent, or when reporting which enterprise seat ran. Holds the 18 ent- seats and the two invariants that keep an agent out of the workflow's driver seat.
---

# Enterprise seats

The pstack seats in `rules/pstack-seats.md` still own the work they already own. These 18 are the enterprise extension, one per role in the architecture's five families, and they are dispatched by the orchestration loop in `/poteto-mode` rather than by a skill of their own.

Pick the seat by the responsibility, then dispatch it with the `Agent` tool. Every seat name starts with `ent-`, so the group greps cleanly and cannot collide with a user or project agent.

## Product and requirements

| Seat | Responsibility | Model | Effort |
|---|---|---|---|
| `ent-product-analyst` | Turns a stated need into requirements that can fail a test | `efficient` | high |
| `ent-business-analyst` | States the business rule a change depends on, and flags every rule nobody confirmed | `efficient` | high |
| `ent-prd-agent` | Writes the PRD a stranger could build from, implementation left out | `efficient` | high |

## Architecture and design

| Seat | Responsibility | Model | Effort |
|---|---|---|---|
| `ent-system-architect` | Traces every touched service and picks a shape across the boundaries | `performance` | xhigh |
| `ent-api-architect` | Fixes a contract, its version, and a compatibility rule per field | `performance` | xhigh |
| `ent-database-architect` | Designs a schema change as a forward migration and a rollback together | `performance` | xhigh |

## Engineering

| Seat | Responsibility | Model | Effort |
|---|---|---|---|
| `ent-backend-engineer` | Implements one service's slice against a fixed contract | `performance` | high |
| `ent-frontend-engineer` | Implements the web surface, including its loading, empty, and error states | `performance` | high |
| `ent-mobile-engineer` | Implements the client, accounting for released versions still in the field | `performance` | high |
| `ent-database-engineer` | Implements the data access layer against a settled schema | `performance` | high |
| `ent-integration-engineer` | Implements the glue between services, adapters, queues, and outbound calls | `performance` | high |

## Quality and governance

| Seat | Responsibility | Model | Effort |
|---|---|---|---|
| `ent-qa-engineer` | Writes and runs the coverage, asserting behavior against the contract | `performance` | xhigh |
| `ent-security-engineer` | Enumerates the new attack surface and classifies findings by exploitability and blast radius | `performance` | xhigh |
| `ent-code-reviewer` | Reviews a diff against the binding constraints, read-only | `performance` | xhigh |
| `ent-performance-engineer` | Measures against a budget and finds what actually limits it | `performance` | xhigh |

## Infra and operations

| Seat | Responsibility | Model | Effort |
|---|---|---|---|
| `ent-devops-engineer` | Writes the pipeline and infrastructure config, and names which commands will prompt | `efficient` | high |
| `ent-sre` | Holds the system view under a clock and prepares the rollback | `efficient` | high |
| `ent-observability` | Produces the evidence from logs, metrics, and traces, and the instrumentation behind it | `efficient` | high |

## Invariants

These hold for all 18 and are the reason the roster is shaped this way.

**An agent never controls the overall workflow.** The chat that receives `/poteto-mode` owns the plan, the todo list, the sequencing, and the state. A seat receives a brief, does the work, and returns a structured result with evidence. Every seat carries `disallowedTools: [Agent]`, so it cannot dispatch further seats and cannot fan work out behind the orchestrator's back.

**An agent never self-approves.** Every seat reports the model it ran on in its first line so the orchestrator can tell whether an independence check actually held. The read-only seats, `ent-code-reviewer`, `ent-security-engineer`, and the read-only parts of `ent-observability` and `ent-sre`, carry no `Write` or `Edit` at all. `ent-qa-engineer` and `ent-performance-engineer` may write tests and harnesses but never the code under test. Approval of a change belongs to the human gate the governance policy names.

**Concurrency is the orchestrator's decision and never the agent's.** The five engineering seats carry `isolation: worktree`, so a parallel dispatch cannot clobber a sibling's writes, and the orchestrator collects the worktrees afterwards. Nothing inside a seat decides what else runs at the same time.

## Tools and integrations

Tools are least-privilege per responsibility, not uniform across the roster. Only `ent-integration-engineer` gets `WebFetch` and `WebSearch`, because its job is defined by an external surface that lives outside the repository. No seat gets a tool its responsibility does not need.

MCP servers and CLI tool integrations cannot be declared on a plugin agent, since Qoder strips `mcpServers` from plugin-shipped definitions along with `hooks` and `permissionMode`. Configure those at user or project level instead, and a seat that needs one says so in its report rather than silently working without it.

## Colors

Color reads as family within this roster, one color per family, so a reply naming several seats is legible at a glance. The palette has eight colors and this plugin has 28 agents, so a family color is shared with the pstack seats listed beside it in `scripts/selftest.py`'s aggregate warning. That is arithmetic, not an oversight, and it is why the family name appears in every seat's description rather than relying on color alone.

## Changing a seat's model

Same mechanism as the pstack seats. A seat's model lives in its agent frontmatter and `settings.json` overrides it. Run `/setup-pstack` to write the overrides, which asks once per family, or edit them by hand:

```json
{
  "agents": {
    "overrides": {
      "ent-code-reviewer": { "modelConfig": { "model": "<your model name>" } }
    }
  }
}
```

Effort cannot be overridden and stays frontmatter-only. Start a new chat after editing, since Qoder documents no reload path for `agents.overrides` in the IDE. When `.qoder/rules/pstack-models.md` exists it records what `/setup-pstack` wrote and takes precedence over the tables above for reporting.
