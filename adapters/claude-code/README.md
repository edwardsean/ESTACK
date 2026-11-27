# estack for Claude Code

The estack engineering workflow system by Lauren Tan, as a native Claude Code
plugin. A playbook-routing orchestrator, three-seat review panels, parallel
arenas and swarms, independent verification, and 24 engineering principles,
with each seat's model and effort chosen per call.

On top of that sits an enterprise SDLC layer: a scoped knowledge index, a
governance policy that resolves into named review steps, twelve more playbooks,
eighteen specialist seats in five families, PRD-to-business-rule cards, and
opt-in approval-gate hooks on push, deploy, and migration commands. It runs
inside `/estack:poteto-mode` rather than beside it, so there is still exactly one
orchestration loop and one owner of the plan.
[docs/ENTERPRISE-ARCHITECTURE.md](./docs/ENTERPRISE-ARCHITECTURE.md) records the
design layer by layer.

This edition was ported from the Qoder edition of pstack (which carries the
enterprise layer) by a re-runnable lever, `scripts/port-from-qoder.py`. Upstream
is Cursor pstack 0.15.43. **Read [COMPATIBILITY.md](./COMPATIBILITY.md) before
you rely on it.** The short version: Claude Code gives back several things the
Qoder edition had to give up (per-call model and effort, background subagents,
`/loop`, real manual-only skills), and one thing is still out of reach, a judge
from a different model vendor.

## How it works

![How estack works: your goal goes to one orchestrator, which picks a playbook and a delegation mode, dispatches seats, verifies the result, and stops at a human approval gate before push, deploy, or migration](../../docs/images/how-it-works.png)

The [estack README](../../README.md) explains each part of this diagram in plain words.

## Install

The estack repository root is a marketplace named `estack`. Inside a Claude
Code session:

```text
/plugin marketplace add edwardsean/ESTACK
/plugin install estack@estack
```

Or from a shell:

```bash
claude plugin marketplace add edwardsean/ESTACK
claude plugin install estack@estack
claude plugin list            # shows estack@estack, enabled
```

To work on a local clone instead, add the clone's root folder in place of
`edwardsean/ESTACK`. This folder is generated from `core/` by
`npm run build:claude`; edit `core/`, never this folder.

Then start a new session, or run `/reload-plugins`. Nothing changes until you
invoke a skill. Edits to a locally added marketplace take effect at the next
session start or on `/reload-plugins`.

To try it for one session without installing anything:

```bash
claude --plugin-dir ./adapters/claude-code     # from the estack root
```

To remove it: `claude plugin marketplace remove estack`, which also
uninstalls the plugin.

## Use it

Claude Code prefixes plugin skills and agents with the plugin name, so every
command below is `/estack:<name>`, and every seat is `estack:<seat>`. The bare
`/<name>` also works unless another plugin claims it.

Configure models once. It reads which models the `Agent` tool accepts, asks for
a reasoning budget, and writes `~/.claude/rules/estack-models.md`, one
`<seat>: <model> <effort>` line per seat you changed:

```text
/estack:setup-models
```

Start real work with a goal and a check that can pass or fail:

```text
/estack:poteto-mode migrate every caller off the legacy parser. done means zero old
callers and the parser fixtures pass.
```

`/estack:poteto-mode` matches the task to one of 34 playbooks, copies its steps
into the todo list, and dispatches seats as the playbook requires. It does the
work in the chat that receives it rather than delegating the whole run.

Turn the enterprise layer on for one repository (gates, knowledge index,
governance policy):

```text
/estack:setup
```

### The workflows

| Skill | What it does | Seats it dispatches |
|---|---|---|
| `/estack:poteto-mode` | Main orchestrator. Routes a task to a playbook and drives it | `estack:poteto-agent` and whatever the playbook names |
| `/estack:architect` | Types, signatures, and module boundaries before code | `estack:estack-architect` |
| `/estack:arena` | Independent parallel solutions, then a scored bakeoff | `estack:estack-panel-1`, `-2`, `-3`, then `estack:estack-judge` |
| `/estack:swarm` | Parallel task delegation with verified slices | `estack:estack-verifier`, `estack:estack-explorer`, `estack:poteto-agent` |
| `/estack:interrogate` | Independent adversarial review | `estack:estack-panel-1`, `-2`, `-3` |
| `/estack:how`, `/estack:why` | Codebase understanding, from code and from history | `/how` uses `estack:estack-explorer`, `/why` runs inline |
| `/estack:no-comments` | The comment pass | `estack:comment-sicko` |
| `/estack:prd-rules` | PRD to confirmed business-rule cards | the three panel seats |
| `/estack:setup` | Per-repo opt-in for gates, knowledge, governance | None |
| `/estack:poteto-help` | The skill index | None |

### How a seat gets its model

Every dispatching skill follows one rule, written down in the `estack-seats`
skill: find the seat's line in `~/.claude/rules/estack-models.md`, pass its
`model` and `effort` on the `Agent` call, and pass neither when there is no line
so the seat's frontmatter decides. Claude Code loads `~/.claude/rules/` into
every session, so the lines are already in context. Every seat reports the model
it ran on in its first line, and the orchestrator cites that report rather than
the configured default.

| Seat | Default model | Default effort |
|---|---|---|
| `estack:estack-architect` | `opus` | `xhigh` |
| `estack:poteto-agent` | `opus` | `high` |
| `estack:estack-panel-1`, `-2`, `-3` | `opus`, `sonnet`, `inherit` | `high` |
| `estack:estack-judge` | `inherit` | `high` |
| `estack:estack-verifier` | `sonnet` | `high` |
| `estack:estack-explorer` | `haiku` | `medium` |
| `estack:estack-mechanic`, `estack:comment-sicko` | `sonnet` | `medium`, `high` |
| 18 `estack:ent-*` seats | product and infra `sonnet`, engineering `opus` | `high`, architecture and quality `xhigh` |

Full guide: [docs/MODEL-ROUTING.md](./docs/MODEL-ROUTING.md).

### Approval gates

A repository opts in by creating `.estack/policy.yaml`, which
`/estack:setup` does through `estack init`. Until that file exists every
hook exits through `estack-hook.sh` on a single file test and never prompts.
Once it exists, the bundled engine decides: an edit needs an open task, a push
needs verify evidence and the owner's approval, and workers never push. Claude
Code fires tool hooks inside subagents with `agent_id` set, so seats are gated
too. `estack init` also installs git `pre-commit` and `pre-push` hooks.

## What is in the package

```text
adapters/claude-code/               generated from core/, never edited by hand
  .claude-plugin/plugin.json        manifest (name estack, version 0.1.0)
  agents/                           28 subagents: 10 estack seats, 18 ent-* seats
  skills/                           63 skills
    poteto-mode/playbooks/          34 playbooks, 12 of them enterprise
    principle-*/                    24 principle leaves
    estack-seats/, enterprise-seats/, enterprise-gates/
                                    the three Qoder rules, now on-demand skills
  hooks/hooks.json                  PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop, SubagentStop
  hooks/scripts/estack-hook.sh      the one entry point for every hook; runs engine/estack.mjs
  docs/guide/                       the 10-page user guide
  docs/MODEL-ROUTING.md             per-seat model and effort
  docs/ENTERPRISE-ARCHITECTURE.md   the six-layer enterprise design
  assets/logo.png                   upstream logo, MIT
  scripts/content_gate.py           the dash and vendor-coupling gate
  scripts/selftest.py               static conformance
  scripts/selftest.sh               all of the above, plus claude plugin validate
  README.md COMPATIBILITY.md CONNECTORS.md LICENSE
```

## Rebuilding

From the estack repository root:

```bash
npm install
npm run build:claude                       # regenerate this folder from core/
npm run check:claude                       # fails if this folder differs from core/
```

## Verifying it

```bash
scripts/selftest.sh
```

That runs the static conformance check, the 46 gate assertions, a hook smoke test
(a `git push` PreToolUse event against an opted-in repo and a dormant one),
`claude plugin validate .`, and the generator check (`npm run check:claude`). None of it installs the plugin
or touches `~/.claude`.

What only a live session proves, and has not been observed here:

1. `/agents` lists the 28 `estack:` seats, and `/hooks` lists the three hooks.
2. `Use the estack:estack-explorer subagent to explain how this project parses input.`
   returns a reply whose first line names a model.
3. In a repo after `/estack:setup`, `git push --dry-run` prompts.

## Provenance

Upstream: https://github.com/cursor/plugins/tree/main/pstack/ at version 0.15.43,
by Lauren Tan, MIT licensed. `LICENSE` is carried through unchanged, and so is
`assets/logo.png`. The Qoder edition and its enterprise layer were read from
`../pstack-qoder`, and upstream's own Claude Code edition from
`../upstream/claude-code`, for the skill frontmatter switches
and the transcript layout. Neither tree was written to. This port is not endorsed
by or affiliated with the upstream author.
