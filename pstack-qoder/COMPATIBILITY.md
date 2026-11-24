# Feature compatibility

This is the honest accounting of what survived the port from Cursor pstack to
Qoder, what changed shape, and what does not work at all. It exists because a
port that quietly drops a feature is worse than one that says the feature is
gone.

Read this before you trust any instruction in this plugin that mentions a
model, a subagent, a loop, or a reviewer from another vendor.

## What this was checked against

Qoder documentation, retrieved for this port:

- https://docs.qoder.com/extensions/subagent (Custom Agent, IDE)
- https://docs.qoder.com/cli/subagent (Subagent field reference, built-ins, sources and priority, plugin safety policy)
- https://docs.qoder.com/cli/settings (configuration files, merge precedence, restart-required items)
- https://docs.qoder.com/user-guide/rules (rules, triggers, 100,000-character limit)

Plus the Qoder plugin manifest rules shipped with the `create-plugin` skill, and
the `Agent` tool schema exposed to the session that performed the port.

Upstream source: https://github.com/cursor/plugins/tree/main/pstack/ at version
0.15.43, read from a pinned snapshot under `upstream/pstack`. The upstream
tree was never written to.

## Summary

| | Count |
|---|---|
| Upstream skills | 58 |
| Skills in this port | 60 |
| Skills lost | 0 |
| Skills written for this port | 2 |
| Upstream agents | 2 |
| Agents in this port | 28 |
| Playbooks routed by the orchestrator | 34 |
| Principle leaf skills | 24 |
| Hook entry points shipped | 3 |
| Upstream files excluded from the package | 377 |
| Files adapted by mechanical substitution | 65 |
| Files rewritten by hand | 24 |
| Port-authored files under a copy root | 14 |

No skill was dropped. Two skills were written for this port, `/prd-rules` and
`/setup-enterprise`, and the count of 60 is 58 carried over plus those two. Two
upstream agents were ported and twenty-six seat agents were added: eight because
the routing model changed, and eighteen for the enterprise extension. See "Model
routing" below for the first group and "Added by this port" for the second.

Twelve of the 34 routed playbooks were written for this port. The other 22 are
upstream's.

## The one structural difference

Upstream pstack picks a model per subagent call. Its routing table names model
slugs such as `claude-opus-5-5` and passes one at dispatch time.

Qoder binds `model` and `effort` in the agent's own frontmatter. The `Agent`
tool takes a description, a prompt, and a `subagent_type`. It has no model
parameter. There is no way to ask for a model at call time.

So every role that upstream expressed as "call a subagent on model X" is
expressed here as "dispatch seat X", where a seat is one Custom Agent carrying
one model. That single change is the reason this port ships ten pstack agents
where upstream ships two, and it is the reason `/setup-pstack` writes
`agents.overrides` instead of a routing table. It is also why the eighteen-seat
enterprise roster costs eighteen files: a role is a seat, and a seat is a file.

It also means panel size is fixed by how many agent files exist. Upstream could
widen a panel by appending a model to a list on one agent. Here, widening a
panel means authoring another agent under `agents/`.

## Model routing

| Role bucket the port was asked to keep separate | Seat | Default `model` | Default `effort` |
|---|---|---|---|
| Architecture and planning | `pstack-architect` | `performance` | `xhigh` |
| Implementation | `poteto-agent` | `performance` | `high` |
| Code review and design panel | `pstack-panel-1` | `performance` | `high` |
| Code review and design panel | `pstack-panel-2` | `efficient` | `high` |
| Code review and design panel | `pstack-panel-3` | `auto` | `high` |
| Independent judgment | `pstack-judge` | `auto` | `high` |
| Verification | `pstack-verifier` | `efficient` | `high` |
| Read-only understanding | `pstack-explorer` | `lite` | `medium` |
| Mechanical bulk edits | `pstack-mechanic` | `efficient` | `medium` |
| Comment review | `comment-sicko` | `efficient` | `high` |

Those ten are the pstack seats. Eighteen enterprise seats ship beside them, bound
per family rather than per seat: product and infra on `efficient` at `high`,
engineering on `performance` at `high`, architecture and quality on `performance`
at `xhigh`. `rules/enterprise-seats.md` holds the full roster and the two
invariants that shape it, and `/setup-pstack` asks one question per family rather
than eighteen questions.

`inherit`, `auto`, `lite`, `efficient`, and `performance` are documented Qoder
aliases. They resolve to whatever model Qoder maps them to on your account. This
document deliberately does not name concrete models behind them, because that
mapping is account-specific and a page that states it will go stale.

Configuration guide: [docs/MODEL-ROUTING.md](./docs/MODEL-ROUTING.md).

## Works as upstream intended

| Feature | Status | Note |
|---|---|---|
| `/poteto-mode` orchestrator | Works | Runs in the receiving chat, routes to playbooks, dispatches seats |
| 22 upstream playbooks | Works | Enumerated by title in `skills/poteto-mode/SKILL.md`, kebab-cased to `playbooks/<title>.md` |
| 24 `principle-*` leaf skills | Works | Copied verbatim, no Cursor coupling |
| `/architect` | Works | Now also delegates to the `pstack-architect` seat, which upstream did not need |
| `/arena` parallel bakeoff | Works | Three panel seats dispatched in one message run concurrently; Qoder dispatches independent subagents in parallel |
| `/swarm` fan-out | Works | Workers are seats, not cloud agents |
| `/interrogate` adversarial review | Works | Three panel seats as adversaries |
| `/tdd`, `/how`, `/why`, `/unslop` | Work | Run inline, dispatch no seat |
| `/no-comments` | Works | `comment-sicko` is read-only here, so the caller owns the edits |
| Concurrent subagent dispatch | Works | Documented capability |
| `general-purpose` fallback dispatch | Works | Documented Qoder built-in, and the default when a dispatch omits the subagent type |
| Worktree isolation | Works | `isolation: worktree`, preserved by the plugin safety policy |
| Git worktrees as isolated working copies | Works | Created by the orchestrator, not by a cloud environment |
| `/setup-pstack` model configuration | Works | Writes `agents.overrides`, which is the documented override mechanism |
| `settings.json` per-seat model override | Works | Documented; cannot create new subagents, only override discovered ones |
| Rules injected as context | Works | `rules/pstack-seats.md` ships with `trigger: model_decision` |
| Background subagent execution | Partially | A per-agent `background: true` default that needs background subagent sessions enabled in settings. Not a per-call flag |

## Changed shape

| Upstream | This port | Why |
|---|---|---|
| Model slug per call | One seat agent per model | No per-call model parameter exists |
| `inherit-parent` alias | `inherit` | Qoder's documented spelling |
| `auto` meaning "follow the user" | `inherit` means follow the session; `auto` lets Qoder pick per turn | Qoder's `auto` is a real alias with different semantics. The two are not interchangeable the way they were upstream |
| Panel width set by a list of models on one agent | Panel width is the count of `pstack-panel-*` agent files | One model binds to one agent |
| `Task` tool | `Agent` tool | Qoder's name for it |
| `readonly: true` per call | The seat's `tools` list omits write tools | No per-call readonly flag; the restriction lives in the agent definition |
| `run_in_background` per call | `background: true` in agent frontmatter | A per-agent default, not a per-call flag |
| `environment: "cloud"` plus `cloud_base_branch` | `isolation: worktree` or a worktree the orchestrator creates | No cloud environment exists |
| `generalPurpose` | `general-purpose` | Qoder's spelling |
| Custom Mode keeping a skill loaded | `.qoder/rules/` with `trigger: always_on` | No per-skill persistent mode; a rule is the nearest mechanism |
| Bugbot triage reference (`bugbot-triage.md`) | `bot-triage.md`, retitled and rewritten | Cursor Bugbot does not exist in Qoder. The file now describes triaging a report from whatever bot the project actually uses |
| `/deslop` from `cursor-team-kit` before commit | Plain words naming what to strip | See "Does not work" below |
| Subagent named only by `subagent_type` | Same, plus `@name` and natural-language naming both work | Qoder documents all three invocation styles |
| "Restart Qoder" after an override change | "Start a new chat, and restart if the seat still reports the old model" | Qoder documents no reload path for `agents.overrides` in the IDE. `/agents reload` is documented for the CLI. Claiming a restart was required would have been a guess |

## Does not work, and is not pretended to

These are the honest gaps. Every instruction in this plugin that used to depend
on one of them now says so at the point of use.

| Upstream feature | Status here | What the port does instead |
|---|---|---|
| The `/loop` wake mechanism | **Not supported.** Qoder documents no timer and no scheduled re-entry. Every hook event is a lifecycle or filesystem event, so none can start a run from nothing. `asyncRewake` is a genuine wake, in that a background hook exiting 2 has the CLI inject a system reminder and wake the model, but a lifecycle event still has to launch that hook. Agents cannot carry hooks at all, only the plugin manifest can | Drive the iterations inside one run, or hand the user a resume note and ask them to re-invoke. `docs/guide/07-overnight.md` was retitled and rewritten around this |
| Unattended overnight runs | **Not supported.** No timer re-enters a run once the turn that started it ends | One long bounded pass with a ceiling the user chooses, plus a resume note that survives the turn |
| Cursor Automations and inbound webhooks | **Not supported.** `automations/` is excluded from the package | `skills/automate-me/SKILL.md` says so. Wiring an external cron job to drive the IDE is explicitly not recommended, since nothing here was tested against it and a headless trigger has no session to run in |
| Cloud agents on a second machine | **Not supported.** No remote execution environment is documented | Local git worktrees. Nothing continues with the laptop closed |
| Cursor Projects | **Not supported** | A chat plus a worktree, with the same limitation |
| Cursor Bugbot | **Not supported** | `bot-triage.md` covers triaging a report from whatever reviewer the project does have |
| `cursor-team-kit` skills: `/deslop`, `control-ui`, `control-cli` | **Not ported.** A separate vendor plugin, out of scope | `/deslop` stripped dead guards, unsupported branches, and compatibility shims from code. Nothing in this port does that. The instruction is now plain words naming what to strip. Do not substitute `/unslop`, which edits prose and would leave the dead guards in the code while reporting the strip as done. `control-ui` and `control-cli` have no equivalent, and the features that needed them say so |
| A judge from a different model vendor | **Cannot be guaranteed.** Qoder publishes no vendor behind a model alias, and the `Agent` tool takes no model parameter, so independence cannot be arranged or checked at dispatch time | `pstack-judge` reports the model it ran on in its first line. The caller compares it to the model that produced the candidates and says plainly when the independence check did not hold, rather than presenting the verdict as cross-vendor. This affects `/arena` Phase C, the eval playbook, `show-me-your-work`, and the design guide page |
| Per-skill persistent mode (Custom Mode, Option+Enter) | **Not supported** | A rule with `trigger: always_on`, or re-invoking the skill |
| Per-call model, effort, readonly, or background flags | **Not supported** | Fixed per seat in agent frontmatter, overridable only through `settings.json` |
| Overriding a plugin seat by copying it to `~/.qoder/agents/` | **Does not work.** Source priority is Built-in < User < Project < Plugin < Flag, so a plugin agent shadows a same-name user or project agent | `settings.json` `agents.overrides`, which is the documented override path |
| Overriding a seat's `effort` at all | **Not documented.** The documented `agents.overrides` fields are enablement, tools, model config, and run limits. `model.reasoningEffort` is a session-level key, not a per-agent override | `/setup-pstack` says this plainly and offers two honest options: accept the shipped effort, or keep a project-level copy of the agent and accept that the plugin version shadows it |

## Added by this port

Not upstream features. They exist because a Qoder plugin can declare hooks in its
manifest, which is the one enforcement point that does not depend on a model
choosing to comply.

| Addition | Status |
|---|---|
| Approval gates on push, deploy, and migration commands | **Wired and proven offline, firing never observed.** `hooks/enterprise-gates.json` declares three hooks and the manifest points at it. `scripts/test-gates.py` drives the real entry points with recorded hook events and passes 32 assertions. No live session has confirmed Qoder fires them |
| `/prd-rules`, the PRD to business rule loop | **Unverified.** Dispatches three panel seats and writes `.qoder/rules/enterprise-<domain>.md`. No run has produced a card yet |
| `/setup-enterprise`, the per repo opt-in | **Unverified.** Writes the policy file the gate reads. Step 6 of that skill is the check that proves the hooks are live, and it has not been run |
| The 12 enterprise playbooks | **Statically proven, never routed in a live session.** `scripts/selftest.py` asserts the title list and the files on disk agree at 34, so each one is reachable by the kebab-fold the orchestrator does. No session has routed a task to one |
| The 18 `ent-*` specialist seats | **Statically proven, never dispatched.** Frontmatter is schema-conformant, every seat is named by at least one playbook or by `rules/enterprise-seats.md`, and no seat holds the `Agent` tool. Whether Qoder dispatches one is the same open question as the ten pstack seats |
| The 13-step loop, six delegation modes, six composition chains, and the 14-step delivery pipeline | **Prose only.** All four live in `skills/poteto-mode/SKILL.md` and are instructions a model reads, so they are a request a model can decline under pressure. The one enforced part is the gate hooks above. `selftest.py` does check that every playbook a chain names folds to a real file |
| The knowledge index and the governance policy | **Unverified, and opt-in.** `/setup-enterprise` writes `.qoder/enterprise/knowledge/index.md` and `.qoder/enterprise/governance.json`. Neither has been written by a real run, so no orchestrator has yet derived a query from one |
| `docs/ENTERPRISE-ARCHITECTURE.md` | **A record, not a feature.** It exists so the port can be checked against its source diagram without going back to an image file |

The gates stay dormant until a repository writes `.qoder/enterprise/gates.json`,
so none of this reaches a project that never opted in. The knowledge index and
the governance policy are dormant the same way: a repository with neither gets
the playbooks and the seats and no scoped retrieval, and the orchestrator says so
rather than inventing a store from the file tree.

### Four views of the source diagram were never supplied

The enterprise extension was built from section A of a six-tab architecture
artifact. The other tabs exist in that artifact and were not provided.

| View | What it would have settled | What the port did instead |
|---|---|---|
| B, a decision flowchart | The branching behind the delegation rules | Encoded from section A's prose, which states the escalation rule and the independence conditions for parallel dispatch explicitly. `docs/ENTERPRISE-ARCHITECTURE.md` marks the passages that trace to it |
| C, an order-cancellation sequence | A worked example of one chain end to end | The six composition chains are built from A's playbook list. No sequence diagram was available to check them against, so they are unvalidated against a real order flow |
| D, a responsibility matrix | Which seat owns which decision | Approximated by the per-seat responsibility line in `rules/enterprise-seats.md` and by the two invariants. A matrix would have drawn boundaries this port infers |
| Design checks | The criteria the design was held against | None were available, so the acceptance criteria here are the ones in the test plan: selftest green, gates 32 of 32, validator clean |

If those four views surface later, the place to reconcile them is
`docs/ENTERPRISE-ARCHITECTURE.md`, which records the gaps as a table rather than
leaving them implicit.

### The gates are the only enforcement, and they reach only so far

Branch protection, required reviewers, CODEOWNERS enforcement, and CI quality
gates are platform-side. Nothing in this plugin can install or verify them, and
the merge gate and deployment gate in the delivery pipeline are human or CI/CD
approvals an agent cannot bypass and cannot stand in for. `rules/enterprise-gates.md`
says so in terms a seat sees without loading the orchestrator.

### The open question that matters most

The hooks documentation defines `PreToolUse` and `SubagentStop` but never says
whether `PreToolUse` fires inside a subagent session. The seats do the pushing, so
if it does not fire there, every delegated push bypasses the ask.

The `SubagentStop` backstop is the mitigation. It correlates audit records by
`tool_use_id` and blocks a seat that ran a gated command with no ask behind it.
That covers the case where `PostToolUse` fires inside a subagent but `PreToolUse`
does not. If neither fires in a subagent, no record is written either and the
backstop finds nothing. That is a real limit, not a solved problem.

Settle it in a live session by delegating a `git push --dry-run` to a seat and
then reading `.qoder/enterprise/approvals.jsonl`. An `ask` line means `PreToolUse`
reached the subagent. An `exec` line with no `ask` behind it means it did not, and
the backstop is the only thing holding. No lines at all means neither event fires
inside a seat, so the gates cover the root chat only.

## Excluded from the package

| Upstream path | Reason |
|---|---|
| `automations/` | Cursor Automations runtime. No Qoder equivalent, and shipping it would imply one |
| `.cursor-plugin/`, `plugin.json` | Cursor manifests. Qoder uses `.qoder-plugin/plugin.json` |
| `README.md` | Described Cursor installation. Replaced by a Qoder one |
| `docs/harness/` | Claude Code harness adapter. Not relevant to Qoder |
| `skills/statechart/scripts/test/` | 3.7 MB of TLA+ test fixtures, only useful when developing the statechart skill itself |
| `.gitignore` | Repo hygiene, not plugin content |

Two links in the upstream guide pointed into `automations/`. Both were removed
during the rewrite of `docs/guide/07-overnight.md`, because a link to an
excluded file is a broken instruction.

## Frontmatter fields this port does not use

Qoder's plugin safety policy strips `hooks`, `mcpServers`, and `permissionMode`
from plugin-provided agents, and preserves `isolation` only when it is
`worktree`. No agent in this plugin sets the first three. `scripts/selftest.py`
fails if one ever does.

Qoder skill frontmatter documents only `name` and `description`. Upstream's
`disable-model-invocation` (47 occurrences) and `paths` (1) were dropped. Skills
that upstream pinned to slash-command-only invocation now say so in their
`description` text instead, which is where Qoder reads invocation intent from.

## Agent colors

The documented palette is eight entries: red, blue, green, yellow, purple,
orange, pink, cyan. This port ships 28 agents, so sharing is arithmetic rather
than oversight, and six of the eight colors are shared.

Within the 18 enterprise seats the sharing is also deliberate: color reads as
family rather than as seat, so cyan is product and requirements, purple is
architecture and design, blue is engineering, red is quality and governance, and
orange is infra and operations. `scripts/selftest.py` reports the sharing as one
aggregate warning naming every family that shares, which replaced a
per-pair warning that was tolerable at ten agents and became noise at twenty-eight.

Color is cosmetic and affects only the TUI indicator.

## How to re-verify any of this

```bash
python3 scripts/port-from-upstream.py   # rebuild from upstream, then gate the tree
python3 scripts/selftest.py             # static conformance, links, paths, workflow trace, hook shape
python3 scripts/test-gates.py           # drives the gate scripts with recorded hook events
scripts/selftest.sh                     # all three, plus qodercli checks when the CLI is present
```

`scripts/port-report.json` records the substitutions the lever actually made on
its last run, with hit counts per rule. `scripts/selftest.py` imports the lever's
own gate function rather than keeping a second copy, so the two checks cannot
drift apart.

## What no static test can prove

`scripts/selftest.py` proves the plugin is wired correctly. It does not prove
Qoder dispatches a seat at runtime, because that needs a live session.
`qodercli` was not installed on the machine that performed this port, so no
runtime smoke test was run, and the approval gates have never been observed to
fire. The enterprise roster inherits the same gap: 18 seats whose frontmatter is
conformant and whose reachability is asserted statically, none of them observed
running. To do that half yourself, see
[README.md](./README.md#verifying-it-actually-runs).
