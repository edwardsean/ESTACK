# pstack for Qoder

The pstack engineering workflow system, ported from Cursor to a native Qoder
plugin. A playbook-routing orchestrator, three-seat review panels, parallel
arenas and swarms, independent verification, and 24 engineering principles, with
each role bound to its own configurable model.

On top of that sits an enterprise SDLC extension built from a six-layer
architecture diagram: a scoped knowledge index, a governance policy that resolves
into named review steps, twelve more playbooks, and eighteen specialist seats in
five families. It runs inside `/poteto-mode` rather than beside it, so there is
still exactly one orchestration loop and one owner of the plan.
[docs/ENTERPRISE-ARCHITECTURE.md](./docs/ENTERPRISE-ARCHITECTURE.md) records the
diagram layer by layer.

pstack's premise is that an agent produces better work when the work is routed
through a named process instead of answered straight from the prompt, and when
the process separates the seat that writes code from the seat that judges it.
That premise survives the port intact. The implementation underneath it did not,
because Qoder routes models differently than Cursor does.

**Read [COMPATIBILITY.md](./COMPATIBILITY.md) before you rely on this.** It
lists what works, what changed shape, and the features that do not work here and
are not pretended to. The short version is that Qoder has no timer that
re-enters a run, no cloud agents, and no per-skill persistent mode, so unattended
overnight runs and cross-vendor judge guarantees are out of reach.

## Install

From Qoder's plugin marketplace, or locally:

```bash
qodercli plugin install --scope local /path/to/pstack-qoder
```

Then start a new chat. Nothing changes until you invoke a skill.

## Use it

Run setup once per project. It asks which models your account can reach, asks
for a reasoning budget, and writes the per-seat configuration:

```text
/setup-pstack
```

Then start real work with a goal and a check that can pass or fail:

```text
/poteto-mode migrate every caller off the legacy parser. done means zero old
callers and the parser fixtures pass.
```

`/poteto-mode` matches the task to one of 34 playbooks, copies its steps into the
todo list, and dispatches seats as the playbook requires. It does the work in the
chat that receives it rather than delegating the whole run.

### The workflows the port was asked to preserve

| Skill | What it does | Seats it dispatches |
|---|---|---|
| `/poteto-mode` | Main orchestrator. Routes a task to a playbook and drives it | `poteto-agent` and whatever the playbook names |
| `/architect` | Types, signatures, and module boundaries before code | `pstack-architect` |
| `/arena` | Independent parallel solutions, then a scored bakeoff | `pstack-panel-1`, `-2`, `-3`, then `pstack-judge` |
| `/swarm` | Parallel task delegation with verified slices | `pstack-verifier`, `pstack-explorer`, `poteto-agent` |
| `/interrogate` | Independent adversarial review of an implementation | `pstack-panel-1`, `-2`, `-3` |
| `/tdd` | Test-driven development | Runs inline |
| `/how`, `/why` | Codebase understanding, from code and from history | `/how` uses `pstack-explorer`; `/why` runs inline |
| `/unslop` | Cuts AI tells from writing | Runs inline |
| `/no-comments` | The comment pass | `comment-sicko` |
| `/poteto-help` | The skill index. Maps a question to the right skill | None |

`/poteto-help` is the entry point when you do not know what to run.

## The enterprise layer

Twelve more playbooks and eighteen more seats, for work that crosses services,
teams, or a production boundary. None of it has a loop of its own. The
orchestrator classifies the task, retrieves only the knowledge that matches it,
resolves the governance policy into named gates on the plan, picks a composition
chain, and dispatches one seat per step.

| Layer | What ships | Where |
|---|---|---|
| Orchestration | The 13-step loop, six delegation modes, six composition chains, and the context-packet rule | `skills/poteto-mode/SKILL.md` |
| Knowledge and governance | A scoped index of where each kind of knowledge lives, and a policy saying which change type needs which review | `.qoder/enterprise/`, seeded by `/setup-enterprise` |
| Playbooks | Requirements analysis, PRD creation, architecture design and review, database migration, API contract design, security assessment, enterprise feature development and bug fix, integration testing, release management, incident management | `skills/poteto-mode/playbooks/` |
| Specialist seats | 18 agents in five families: product and requirements, architecture and design, engineering, quality and governance, infra and operations | `agents/ent-*.md`, catalogued in `rules/enterprise-seats.md` |
| Delivery | A 14-step pipeline from implementation to production monitoring, ending at a protected boundary no agent can cross | `skills/poteto-mode/SKILL.md` |

Delegation is a decision rather than a default, and it escalates only when
complexity, coupling, or scale justify it. Most bug fixes and most refactors
never leave the first two of the six modes. Parallel dispatch happens only when
tasks are genuinely independent, meaning different services, contracts already
fixed, and no shared migration.

Two invariants hold across all 18 seats. An agent never controls the overall
workflow and never self-approves, so every seat carries `disallowedTools:
[Agent]` and the reviewing seats carry no write tools at all. And concurrency is
the orchestrator's decision, never the agent's.

The knowledge index and the governance policy are opt-in per repository, the same
way the gates are. A repository with neither gets the playbooks and the seats and
no scoped retrieval, and the orchestrator says so rather than inventing a store
from the file tree.

## Approval gates and business rules

Two skills and a hook set that upstream does not have. All of it stays dormant
until a repository opts in, so installing the plugin changes nothing elsewhere.

| Skill | What it does | Seats it dispatches |
|---|---|---|
| `/prd-rules` | Reads a PRD, extracts candidate business rules, and asks a human to settle the contested ones. Writes `.qoder/rules/enterprise-<domain>.md`, which the orchestrator loads only for tasks in that domain | `pstack-panel-1`, `-2`, `-3` |
| `/setup-enterprise` | Turns the enterprise layer on for one repository: the gate policy, the knowledge index, and the governance policy | None |

The orchestrator is prose, and prose is a request a model can decline under
pressure. The gates are not prose. They are hooks, which run outside the model.

A repository opts in by writing `.qoder/enterprise/gates.json`, which
`/setup-enterprise` does. Until that file exists the hook exits on a single file
test and never prompts. Three classes are gated.

| Class | Catches by default |
|---|---|
| `push` | `git push`, `gh pr create`, `gh pr merge` |
| `deploy` | anything containing `deploy`, plus `kubectl apply`, `kubectl delete`, `kubectl rollout`, `terraform apply`, `terraform destroy`, `helm install`, `helm upgrade`, `helm uninstall` |
| `migration` | anything containing `migrate`, `migration`, or `seed`, plus `alembic upgrade`, `prisma migrate`, `flyway migrate`, and `psql` or `mysql` called with an inline command |

Read-only commands are deliberately absent. `kubectl get`, `git status`, and
`terraform plan` are not gated, because a gate that fires on reading is a gate
people turn off within a week.

When a gated command matches, the hook returns `permissionDecision: "ask"` and
the human in the session decides. An approved command runs and is appended to
`.qoder/enterprise/approvals.jsonl`. A `SubagentStop` hook then reports any gated
action that ran with no ask behind it, which is how a delegated push that skipped
the gate gets noticed. That backstop detects rather than prevents, since by the
time a seat stops the push has already happened.

Patterns live in the project's own policy file and never in the plugin, because
deploy and migration commands are the least portable part of this design. The
plugin declares no `if` pre-filter for the same reason: a filter baked into the
manifest would silently kill any pattern a project added.

**Not proven at runtime.** `qodercli` is absent on the machine this port was built
on, so hook firing has never been observed here. The decision logic is covered by
32 offline assertions that drive the real entry points with recorded hook events.
[COMPATIBILITY.md](./COMPATIBILITY.md) records what remains unverified, including
whether `PreToolUse` reaches inside a subagent at all.

## Multi-model routing

Qoder binds `model` and `effort` in an agent's frontmatter. The `Agent` tool
takes a `subagent_type` and a prompt, and has no model parameter. So each role is
a **seat**, each seat is one Custom Agent, and you pick a seat instead of picking
a model.

The five role buckets this port keeps separate:

| Bucket | Seat | Default model | Effort |
|---|---|---|---|
| Architecture and planning | `pstack-architect` | `performance` | `xhigh` |
| Implementation | `poteto-agent` | `performance` | `high` |
| Code review | `pstack-panel-1`, `-2`, `-3` | `performance`, `efficient`, `auto` | `high` |
| Independent judgment | `pstack-judge` | `auto` | `high` |
| Verification | `pstack-verifier` | `efficient` | `high` |

Three support seats ship alongside them: `pstack-explorer` for read-only
understanding, `pstack-mechanic` for bulk mechanical edits, and `comment-sicko`
for the comment pass.

Eighteen enterprise seats ship in five more families, dispatched by the
orchestration loop rather than by a skill of their own. They are bound per
family: product and infra on `efficient` at `high`, engineering on `performance`
at `high`, architecture and quality on `performance` at `xhigh`. Color reads as
family within that roster. The full table and the two invariants that shape it
are in `rules/enterprise-seats.md`.

`/setup-pstack` asks about all 28. It groups the enterprise seats into one
question per family, so a repository that never runs an enterprise chain skips
five questions rather than answering eighteen.

Every seat reports the model it actually ran on in the first line of its reply.
Cite that rather than the configured default, because `agents.overrides` can
repin a seat.

Full configuration guide, including how to change a seat's model and what cannot
be overridden: [docs/MODEL-ROUTING.md](./docs/MODEL-ROUTING.md).

## What is in the package

```text
pstack-qoder/
  .qoder-plugin/plugin.json    manifest
  README.md                    this file
  COMPATIBILITY.md             feature compatibility matrix
  PORTING-NOTES.md             how the port was built, and how to rebuild it
  CONNECTORS.md                external accounts and services, and what needs none
  LICENSE                      MIT, carried from upstream
  assets/logo.png              upstream logo
  agents/                      28 Custom Agents, one per model seat
    pstack-*, poteto-agent,    10 pstack seats, routed by skills
    comment-sicko
    ent-*                      18 enterprise seats in five families
  rules/pstack-seats.md        the pstack seat catalog, injected on turns that delegate
  rules/enterprise-seats.md    the enterprise roster and its two invariants
  rules/enterprise-gates.md    the gate contract, for seats that skip poteto-mode
  hooks/enterprise-gates.json  approval gate hooks, declared from the manifest
  hooks/scripts/               the gate, audit, and backstop entry points
  skills/                      60 skills, 58 from upstream and 2 port-authored
    poteto-mode/playbooks/     34 playbooks the orchestrator routes to
    poteto-mode/references/    bot triage, worker contract
    principle-*/               24 leaf principles the seats read in full
  docs/
    guide/                     the 10-page user guide, adapted
    MODEL-ROUTING.md           model routing configuration guide
    ENTERPRISE-ARCHITECTURE.md the six-layer diagram, recorded layer by layer
  scripts/
    port-from-upstream.py      the lever that rebuilds this plugin from upstream
    selftest.py                static conformance test
    test-gates.py              drives the gate scripts with recorded hook events
    selftest.sh                runs all three, plus qodercli checks when available
    port-report.json           substitutions applied on the last run
```

58 skills in, 58 skills out. No skill was dropped. Two more were written for this
port, `/prd-rules` and `/setup-enterprise`, which is why the folder holds 60.

## Provenance

Upstream: https://github.com/cursor/plugins/tree/main/pstack/ at version
0.15.43, by Lauren Tan, MIT licensed. `LICENSE` is carried through unchanged.

`assets/logo.png` is the upstream logo, also MIT. It was not redrawn, because the
port is a derivative work and the mark belongs to the original.

The upstream tree was read from a pinned snapshot at `upstream/pstack` and
was never written to. Everything in this plugin is either copied verbatim from
upstream, adapted by a recorded mechanical substitution, or hand-rewritten and
listed as such. `scripts/port-report.json` says which files fall in which bucket
and how many substitutions each rule made.

This port is not endorsed by or affiliated with the upstream author.

## Omitted from upstream, and why

| Path | Reason |
|---|---|
| `automations/` | Cursor Automations runtime. Qoder has no scheduler and no inbound webhook trigger, so shipping it would imply a capability that is not there |
| `.cursor-plugin/`, `plugin.json` | Cursor manifests. Qoder reads `.qoder-plugin/plugin.json` |
| `README.md` | Described Cursor installation. Replaced by this file |
| `docs/harness/` | Claude Code harness adapter. Not relevant to Qoder |
| `skills/statechart/scripts/test/` | 3.7 MB of TLA+ test fixtures, useful only when developing the statechart skill itself. The skill works without them |
| `.gitignore` | Repo hygiene, not plugin content |

The `statechart` skill still ships with its full pipeline, backends, frontends,
and passes. Only its own test fixtures were trimmed.

Two links in the upstream guide pointed into `automations/`. Both were removed
during the rewrite of `docs/guide/07-overnight.md`.

## Verifying it actually runs

Two halves. The static half runs anywhere with Python 3.

```bash
python3 scripts/selftest.py
```

It checks the manifest against what exists on disk, the frontmatter of every
skill and agent against the documented schema, the plugin safety policy, every
relative link and every backticked path in the shipped prose, that every seat a
skill names has an agent file, that all 34 playbooks resolve, that every `ent-`
seat is reachable from a playbook or the seat rule, that every playbook a
composition chain names exists, and that no Cursor-only construct survived
anywhere in the tree. It ends by printing the workflow trace from each
orchestrator skill to the seats it dispatches.

The runtime half needs the Qoder CLI. `selftest.sh` runs it when the CLI is
present and skips it with a message when it is not.

```bash
scripts/selftest.sh
```

To confirm dispatch by hand in a live session:

1. `/agents reload`, or start a new chat.
2. Confirm the ten `pstack-*` seats, the eighteen `ent-*` seats, plus
   `poteto-agent` and `comment-sicko` appear under the Plugin source in
   `/agents`, or in `qoder agents list`.
3. Dispatch one by name and check the first line of its reply names a model:

   ```text
   Use the pstack-explorer subagent to explain how this project parses input.
   ```

4. Run `/poteto-mode` on a small real task and check that it copies playbook
   steps into the todo list before writing code.

`qodercli` was not installed on the machine that performed this port, so step 2
onward was not executed here. That is a gap in the evidence, not a claim that it
works. The static half passes.

## Validation evidence

Quoted from the last run on this machine. The substitution list and the workflow
trace are elided.

```text
$ python3 scripts/port-from-upstream.py
copied 131 files (377 excluded), adapted 65 markdown files
hand-owned: 0 seeded, 24 left untouched

substitution counts:
    47  frontmatter-drop:disable-model-invocation
    47  frontmatter:disable-model-invocation
    14  dash-fix
     9  R32
    ... 28 further rules ...
hand-owned files: 24
port-authored files: 14
gate: clean, no Cursor-only constructs outside hand-rewrites

$ python3 scripts/selftest.py
enterprise roster
  ent- agents  18
  reachable    18
  chain steps  14 playbooks named by a composition chain

counts
  manifest   pstack-qoder v0.15.43
  skills     60
  agents     28
  playbooks  34 routed
  hook scripts 3
PASS: the port is internally consistent and statically conformant

$ python3 scripts/test-gates.py
passed 32, failed 0
PASS: the gate scripts behave correctly against recorded hook events

$ ./scripts/selftest.sh --rebuild
passed 7, failed 0, skipped 1
PASS

$ python3 .../create-plugin/scripts/validate_qoder_plugin.py pstack-qoder
OK: no issues found
```

The one skip is `qodercli`, which is absent here, so the runtime half described
above under **Verifying it actually runs** never ran. The wrapper reports it as a
skip rather than a pass. The same absence is why the approval gates are proven by
offline assertions rather than by an observed prompt, and why no `ent-` seat has
ever been observed running.

One warning remains, and it is arithmetic rather than a defect. The documented
agent color palette has eight entries and this plugin ships 28 agents, so six
colors are shared. Inside the enterprise roster the sharing is deliberate, since
color reads as family there rather than as seat. `selftest.py` reports it once
and names every family that shares, which replaced a per-pair warning that was
tolerable at ten agents and became noise at twenty-eight.

## Rebuilding from upstream

The port is reproducible rather than a one-off copy.

```bash
python3 scripts/port-from-upstream.py ../upstream/pstack
```

The lever copies upstream, applies 54 recorded mechanical substitutions, and
then gates the whole tree, failing loudly if any Cursor-only construct survives
outside a file it knows is hand-owned. It never writes the 24 hand-owned files or
the 14 port-authored ones. It is idempotent, so re-running it after an upstream
update produces a reviewable diff instead of clobbering hand work.

[PORTING-NOTES.md](./PORTING-NOTES.md) covers the lever's design, the rule
catalog, and the two classes of mistranslation it caught.

## Guide

The adapted 10-page guide is under `docs/guide/`, starting with
[setup](./docs/guide/01-setup.md). Page 7 was retitled
[Run long work you review later](./docs/guide/07-overnight.md), because the
upstream premise of an unattended hourly wake loop is not available in Qoder and
the page now teaches the bounded alternative.

## License

MIT. See [LICENSE](./LICENSE).
