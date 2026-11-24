# estack

My agentic engineering harness for Claude Code. It starts from
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan, a
disciplined workflow system for coding agents, and adds an enterprise SDLC layer
on top: specialist roles, governance, business-rule cards, and approval gates on
risky commands.

The short version: you give it a goal and a way to check it's done. One
orchestrator picks the right playbook, hands pieces of work to specialist
subagents, makes independent reviewers check the result, and stops for a human
before anything that touches shared systems (push, deploy, migration).

## Install

Inside a Claude Code session:

```text
/plugin marketplace add edwardsean/ESTACK
/plugin install pstack@estack
/pstack:setup-pstack          # pick a model and effort for each seat, once
```

In a repository where you want the enterprise layer (gates, knowledge index,
governance policy), run once:

```text
/pstack:setup-enterprise
```

Then start real work:

```text
/pstack:poteto-mode add CSV export to the orders page. done means the export
test passes and the file opens in Excel.
```

## How it works

```mermaid
flowchart TD
    dev(["You: /pstack:poteto-mode + goal + done check"])

    subgraph brain["Orchestrator: poteto-mode, the only loop and the only owner of the plan"]
        direction TB
        understand["1. Restate the goal and the smallest change that meets it"]
        classify["2. Classify the task"]
        context["3. Pull only the relevant knowledge, business-rule cards, principles, governance"]
        playbook["4. Pick a playbook (34) or a composition chain"]
        mode{"5. How much delegation?"}
        understand --> classify --> context --> playbook --> mode
    end

    dev --> understand

    mode -->|simple| direct["Direct or single seat"]
    mode -->|ordered steps| seq["Sequential seats"]
    mode -->|independent pieces| par["Parallel / swarm"]
    mode -->|contested design| arena["Arena or interrogate: 3 panel seats + judge"]

    subgraph seats["Seats: subagents, each with its own model, effort, and tools"]
        core["pstack core: architect, poteto-agent, mechanic, explorer, comment-sicko"]
        ent["Enterprise, 18 seats in 5 families: product, architecture, engineering, quality, infra"]
    end

    direct --> seats
    seq --> seats
    par --> seats
    arena --> seats

    seats --> verify["Verify: tests, contract, e2e, security scan, code review, independent pstack-verifier"]
    verify -->|fails| understand
    verify -->|passes| pr["Open PR, babysit CI and review comments"]

    pr --> gate{{"Approval gate hook: push, deploy, migration"}}
    gate -->|human approves| ship["Merge and deploy, by a human or CI/CD"]
    gate -->|human refuses| stop["Stop and report, never route around it"]
    ship --> monitor["Production monitoring"]
```

### The pieces, in plain words

**One orchestrator.** `/pstack:poteto-mode` is the brain. It reads your goal,
classifies the task, and matches it to a playbook, a written recipe for that kind
of work (bug fix, feature, refactor, migration, incident, release, and so on).
The enterprise layer runs inside this same loop, so there is never a second
planner arguing about what happens next.

**Playbooks.** 34 of them: 22 from pstack and 12 enterprise ones (requirements
analysis, PRD creation, architecture design and review, database migration, API
contract design, security assessment, enterprise feature and bug fix,
integration testing, release management, production incident). Composition
chains string several together for bigger jobs, and are only as long as the task
needs.

**Seats.** A seat is a subagent with one job, its own tools, and its own model
and effort. Ten come from pstack (architect, three review panels, judge,
verifier, explorer, mechanic, comment pass, general worker). Eighteen enterprise
seats sit in five families:

| Family | Seats |
|---|---|
| Product and requirements | product analyst, business analyst, PRD agent |
| Architecture and design | system architect, API architect, database architect |
| Engineering | backend, frontend, mobile, database, integration engineer |
| Quality and governance | QA, security, code reviewer, performance engineer |
| Infra and operations | DevOps, SRE, observability |

Two rules hold for every seat: a seat never runs the workflow and never approves
its own work, and the orchestrator alone decides what runs in parallel.
Reviewing seats can't edit files, and engineering seats work in their own git
worktree.

**Independent checking.** Nothing is "done" because it compiles. Arena runs three
independent attempts on different models and a judge scores them. Interrogate
runs three adversarial reviewers. A separate verifier re-checks every claimed fix
against the real artifact. Failures loop back to implementation, not a blind
retry.

**Knowledge and rules, scoped.** Per repository, `/pstack:setup-enterprise`
writes a knowledge index (pointers to architecture docs, service catalog, ADRs,
schemas), a governance policy (which change types need architecture, security, or
DBA review), and `/pstack:prd-rules` turns a PRD into business-rule cards. Each
subagent only gets the slice relevant to its job.

**Approval gates.** Claude Code hooks sit outside the model. In an opted-in repo,
a `git push`, deploy, or migration command makes Claude Code ask you first,
approvals are logged, and a seat that ran a gated command without asking can't
finish cleanly. In a repo that didn't opt in, the hooks do nothing.

**24 principles.** Short rules the agent cites when they change a decision: fix
root causes, prove it works, subtract before you add, make illegal states
unrepresentable, build the tool instead of doing it by hand, and so on.

## Repository layout

```text
estack/
  .claude-plugin/marketplace.json   the "estack" marketplace, points at pstack-claude/
  pstack-claude/                    the Claude Code plugin (what you install)
  pstack-qoder/                     the Qoder edition, source of truth for the port
  upstream/pstack/                  pinned upstream pstack 0.15.43, read only
  upstream/claude-code/             upstream's own Claude Code edition, read only
```

Each edition is generated by a re-runnable script rather than edited by hand,
except for a short list of hand-owned files:

```mermaid
flowchart LR
    up["upstream/pstack<br/>Cursor pstack 0.15.43"] -->|"pstack-qoder/scripts/port-from-upstream.py"| q["pstack-qoder<br/>+ enterprise layer"]
    q -->|"pstack-claude/scripts/port-from-qoder.py"| c["pstack-claude<br/>Claude Code plugin"]
    ucc["upstream/claude-code"] -.->|frontmatter switches| c
```

Rebuild and check everything:

```bash
(cd pstack-qoder && python3 scripts/port-from-upstream.py && scripts/selftest.sh --rebuild)
(cd pstack-claude && scripts/selftest.sh --rebuild)
```

The Claude self-test runs static conformance, 46 hook-gate assertions, a hook
smoke test, `claude plugin validate`, and proves a second lever run writes
nothing.

## More detail

- [pstack-claude/README.md](pstack-claude/README.md): every command, seat, and default model
- [pstack-claude/docs/ENTERPRISE-ARCHITECTURE.md](pstack-claude/docs/ENTERPRISE-ARCHITECTURE.md): the six-layer enterprise design
- [pstack-claude/docs/MODEL-ROUTING.md](pstack-claude/docs/MODEL-ROUTING.md): how each seat gets its model and effort
- [pstack-claude/COMPATIBILITY.md](pstack-claude/COMPATIBILITY.md): what works, what differs from upstream, what's unproven
- [pstack-claude/docs/guide/](pstack-claude/docs/guide/README.md): the 10-page user guide

## Credits

pstack is by Lauren Tan, MIT licensed, from
[cursor/plugins](https://github.com/cursor/plugins). Each edition carries the
upstream `LICENSE` unchanged. estack is a personal fork and is not endorsed by or
affiliated with the upstream author.
