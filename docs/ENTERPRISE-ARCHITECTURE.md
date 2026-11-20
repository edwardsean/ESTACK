# Enterprise architecture

The record of the six-layer architecture this plugin's enterprise extension was
built from, kept inside the workspace so a reader can check the port against its
source without going back to an image file.

## Source

The source of truth is section A of a six-tab architecture artifact, supplied as
`arch 1.webp`. A companion one-page PDF summarizes the same architecture at a
lower resolution and adds nothing that section A does not already state.

Four views in the artifact were not supplied. They are named here so the gaps are
visible rather than silently absent, and each one is recorded in
[COMPATIBILITY.md](../COMPATIBILITY.md) as an open item.

| View | What it would have shown | Status |
|---|---|---|
| A | The six layers, in full detail | Supplied. Everything below comes from it |
| B | A decision flowchart | Not supplied |
| C | An order-cancellation sequence | Not supplied |
| D | A responsibility matrix | Not supplied |
| Design checks | The checks the design was held against | Not supplied |

Section A's prose states the delegation and concurrency rules that B would have
drawn, and the responsibility split that D would have tabulated, so the port is
built from what was supplied rather than from a guess about what was not. Where a
rule below traces to A's prose it is marked as such.

## Two locked decisions

Both were settled before implementation and both shaped the file count.

**The five families hold 18 roles, not 20.** An early reading of the diagram
counted twenty specialist agents. Counting the five families one role at a time
gives eighteen, and the port ships eighteen literal agent files under `agents/`,
prefixed `ent-`. The cost is 28 model bindings to configure instead of 10, which
is why `/setup-pstack` asks one question per family rather than one per seat.

**The approval gates, `/prd-rules`, and `/setup-enterprise` were extended, not
rebuilt.** Those three shipped earlier in this program and already covered Layer 2
gate enforcement, Layer 3 business rules, and steps 11 and 13 of the Layer 6
pipeline. This work adds to them. Nothing was duplicated, and no second gate
mechanism exists.

## Layer 1, the developer surface

A developer works in Claude Code and invokes a skill, `/poteto-mode` for real
work, with a task stated in natural language. Nothing in this layer is
enterprise-specific, and the port changes nothing here.

## Layer 2, the orchestration brain

`/poteto-mode` is the single owner of the workflow. The enterprise SDLC extension
sits inside it and has no loop of its own, which is the load-bearing constraint in
the whole design. Two loops would mean two owners of the plan and two answers
about what step comes next.

The extension adds task classification, knowledge retrieval, a policy and rule
loader, an enterprise playbook registry, the specialist agent roster, a
context-packet builder, approval-gate enforcement, and tool integrations.

**The 13-step loop**, implemented in `skills/poteto-mode/SKILL.md`: understand the
request, classify the task, retrieve knowledge, load rules and principles, select
playbooks, pick specialist agents, decide sequential versus parallel, decide the
shape of the fan-out, delegate, maintain plan and state, evaluate results, enforce
verification and gates, decide the next step.

**Six delegation modes**, escalating left to right: Direct, Single agent,
Sequential, Parallel, Swarm, and Multi-phase. Section A's prose is explicit that
escalation happens only when complexity, coupling, or scale justify it, that
delegation is a decision rather than a default, and that most bug fixes and most
refactors never leave the first two modes. Parallel dispatch is allowed only when
tasks are independent, which A defines as different services, contracts already
fixed, and no shared migration. The port renders the six modes as a table rather
than as prose, because a comma-separated line of capitalized names is exactly the
shape the orchestrator's own playbook-title parser matches on, and putting one in
the file would hijack routing.

Tool integrations from this layer are documented rather than built. Claude Code ignores
`mcpServers` from plugin-shipped agent definitions, so MCP and CLI configuration
has to live at user or project level. `skills/enterprise-seats/SKILL.md` says so.

## Layer 3, knowledge, rules, and governance

Three stores, all opt-in per repository, all seeded by `/setup-enterprise`.

**Knowledge** covers ten kinds: architecture docs, microservice catalog, service
ownership map, API documentation, database schemas, ADRs, business requirements,
business rules, integration docs, and existing workflows. A's rule is scoped
retrieval rather than bulk loading. The port implements that as
`.claude/enterprise/knowledge/index.md`, one line per kind pointing at where it
actually lives. The orchestrator derives a query from the task class plus the
touched services and reads only the matching entries. The index points; it does
not import a company wiki.

**Rules and principles** are the 24 leaf principle skills the port already shipped,
plus per-domain business rule cards at `.claude/skills/enterprise-<domain>/SKILL.md`
written by `/prd-rules`. The cards are project skills, loaded by description, which is what makes
them load only on a turn in their domain. That trigger type is the scoped
retrieval mechanic at the rules layer.

**Governance** is `.claude/enterprise/governance.json`: which change types require
architecture review, security approval, or DBA review, and which of those are
advisory plan steps versus hook-enforced gates. A's rule is that governance
policies are resolved into gates on the plan before delegation, and the loop does
that at step 4 rather than at step 12.

A's context-packet rule also lives here. A delegated brief carries only the
knowledge slice and the rules relevant to that agent's responsibility, never the
whole store.

## Layer 4, playbooks and composition chains

Thirteen existing pstack playbooks plus twelve new enterprise ones, taking the
routed total to 34. The twelve are requirements analysis, PRD creation,
architecture design, architecture review, database migration, API contract design,
security assessment, enterprise feature development, enterprise bug fix,
integration testing, enterprise release management, and production incident
management.

**Six composition chains** route a task class to an ordered set of playbooks:
cross-service feature, enterprise bug fix, small refactor, investigation only,
production incident, and schema change. Two rules from A govern them. Workflow
length matches the task, so a chain is the longest one the task needs rather than
the longest one available. And a review step joins a chain only when the
governance policy requires it for that change type.

`scripts/selftest.py` asserts that every playbook a chain names folds to a real
file, so a chain cannot rot into a route to nowhere.

## Layer 5, the specialist agents

Eighteen seats in five families, each a literal agent file under `agents/`.

| Family | Seats | Model and effort |
|---|---|---|
| Product and requirements | `pstack:ent-product-analyst`, `pstack:ent-business-analyst`, `pstack:ent-prd-agent` | `sonnet`, high |
| Architecture and design | `pstack:ent-system-architect`, `pstack:ent-api-architect`, `pstack:ent-database-architect` | `opus`, xhigh |
| Engineering | `pstack:ent-backend-engineer`, `pstack:ent-frontend-engineer`, `pstack:ent-mobile-engineer`, `pstack:ent-database-engineer`, `pstack:ent-integration-engineer` | `opus`, high |
| Quality and governance | `pstack:ent-qa-engineer`, `pstack:ent-security-engineer`, `pstack:ent-code-reviewer`, `pstack:ent-performance-engineer` | `opus`, xhigh |
| Infra and operations | `pstack:ent-devops-engineer`, `pstack:ent-sre`, `pstack:ent-observability` | `sonnet`, high |

**Two invariants from A**, restated in `skills/enterprise-seats/SKILL.md` and enforced in
frontmatter. An agent never controls the overall workflow and never self-approves,
so every seat carries `disallowedTools: [Agent]`, the reviewing seats carry no
`Write` or `Edit`, and every seat reports the model it ran on so an independence
check can be verified after the fact. And concurrency is the orchestrator's
decision, never the agent's, which is why the five engineering seats carry
`isolation: worktree` and nothing inside a seat decides what runs beside it.

Tools are least-privilege per responsibility rather than uniform. Only
`pstack:ent-integration-engineer` gets `WebFetch` and `WebSearch`, because its job is
defined by a surface that lives outside the repository.

A also names a skills library and engineering tool integrations at this layer. The
skills library is the 60 skills this plugin already ships. The tool integrations
are documented rather than built, for the `mcpServers` reason given under Layer 2.

## Layer 6, the delivery pipeline

Fourteen steps, implemented as a numbered section in
`skills/poteto-mode/SKILL.md`.

Steps 1 to 8 are verification and belong to the run: implementation, unit,
integration, contract, end to end, security scans, agent code review, and
independent verification. Steps 9 to 14 cross into shared systems and each has a
human in it: open the PR, babysit, the human merge gate, ship under explicit
authorization, the deployment gate, and production monitoring.

Steps 9, 10, and 12 map to playbooks that already shipped, and the section names
them as `opening-a-pr`, `babysit`, and `shipping` rather than restating them.
Steps 11 and 13 are the two gates the earlier approval-gate work already covered.

A's rule on failure is that it loops back to implementation or investigation
rather than being retried in place. The section says so, and the loop's step 13
says it again.

**The protected boundary.** A marks the merge gate and the deployment gate as
human or CI/CD approvals an AI cannot bypass. The port states the boundary
plainly in both `skills/poteto-mode/SKILL.md` and `skills/enterprise-gates/SKILL.md`, so
a seat that never loads the orchestrator still sees it. Agent credentials cannot
merge to a protected branch and cannot approve a deployment. Branch protection,
required reviewers, CODEOWNERS enforcement, and CI quality gates are
platform-enforced and out of this plugin's reach, and nothing here pretends
otherwise.

## What is verified and what is not

`scripts/selftest.py` asserts statically that all 34 playbooks resolve, that all
18 `ent-` seats are reachable from a playbook or the seat rule, that every
playbook a composition chain names exists, and that every agent's frontmatter is
conformant. `scripts/test-gates.py` drives the real gate entry points against
recorded hook events.

Nothing here proves that Claude Code dispatches an `ent-` seat at runtime. A live session is
absent on the machine this was built on, so the enterprise roster has never been
observed running. That gap is recorded in [COMPATIBILITY.md](../COMPATIBILITY.md)
alongside the four missing views.
