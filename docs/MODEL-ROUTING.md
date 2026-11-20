# Model routing

How to put a specific model behind a specific role in this plugin, what Qoder
lets you change, and what it does not.

## Why routing is per-agent here

Upstream Cursor pstack names a model at dispatch time. Its orchestrator holds a
routing table of model slugs and passes one when it spawns a subagent.

Qoder has no such parameter. The `Agent` tool takes a description, a prompt, a
`subagent_type`, and an optional review scope. Model and reasoning effort live in
the agent's own frontmatter:

```yaml
---
name: pstack-judge
model: auto
effort: high
---
```

So a role that upstream expressed as "spawn a subagent on model X" is expressed
here as "dispatch seat X", where a seat is one Custom Agent file carrying one
model. That is the whole reason this plugin ships ten pstack seats where upstream
ships two agents, and it is why the eighteen-seat enterprise roster has to be
eighteen files rather than one roster table.

One consequence worth stating up front: **panel width is the number of agent
files.** Upstream widened a review panel by appending a model to a list on one
agent. Here you author another `pstack-panel-N.md`. This port ships three.

## The seats

| Seat | Role | Default `model` | Default `effort` | Write access | Isolation |
|---|---|---|---|---|---|
| `pstack:pstack-architect` | Architecture and planning | `opus` | `xhigh` | yes | workspace |
| `pstack:poteto-agent` | Implementation | `opus` | `high` | yes | workspace |
| `pstack:pstack-panel-1` | Review panel, first arm | `opus` | `high` | yes | worktree |
| `pstack:pstack-panel-2` | Review panel, second arm | `sonnet` | `high` | yes | worktree |
| `pstack:pstack-panel-3` | Review panel, third arm | `inherit` | `high` | yes | worktree |
| `pstack:pstack-judge` | Independent judgment | `inherit` | `high` | no | workspace |
| `pstack:pstack-verifier` | Verification | `sonnet` | `high` | repros only | worktree |
| `pstack:pstack-explorer` | Read-only understanding | `haiku` | `medium` | no | workspace |
| `pstack:pstack-mechanic` | Mechanical bulk edits | `sonnet` | `medium` | yes | workspace |
| `pstack:comment-sicko` | Comment review | `sonnet` | `high` | no | workspace |

The three read-only seats have no `Write` or `Edit` in their `tools` list. Qoder
has no per-call readonly flag, so the restriction lives in the agent definition
and cannot be relaxed at dispatch time. That is stronger than what it replaces.

`pstack:pstack-verifier` does carry `Write` and `Edit`, because a verifier that cannot
build a repro cannot prove much. It runs under `isolation: worktree`, so those
writes land in its own checkout and the verdict stays attributable. Its contract
forbids editing the code under review.

### The enterprise roster

Eighteen more seats ship for the enterprise extension, grouped in five families.
The `/poteto-mode` orchestration loop dispatches them rather than a skill of their
own, and they are bound per family rather than per seat, so one override decision
covers a whole family.

| Family | Seats | Default `model` | Default `effort` | Write access | Isolation |
|---|---|---|---|---|---|
| Product and requirements | `pstack:ent-product-analyst`, `pstack:ent-business-analyst`, `pstack:ent-prd-agent` | `sonnet` | `high` | yes | workspace |
| Architecture and design | `pstack:ent-system-architect`, `pstack:ent-api-architect`, `pstack:ent-database-architect` | `opus` | `xhigh` | yes | workspace |
| Engineering | `pstack:ent-backend-engineer`, `pstack:ent-frontend-engineer`, `pstack:ent-mobile-engineer`, `pstack:ent-database-engineer`, `pstack:ent-integration-engineer` | `opus` | `high` | yes | worktree |
| Quality and governance | `pstack:ent-qa-engineer`, `pstack:ent-security-engineer`, `pstack:ent-code-reviewer`, `pstack:ent-performance-engineer` | `opus` | `xhigh` | two of the four are read-only | worktree for `pstack:ent-performance-engineer`, workspace for the rest |
| Infra and operations | `pstack:ent-devops-engineer`, `pstack:ent-sre`, `pstack:ent-observability` | `sonnet` | `high` | yes | workspace |

The two read-only seats are `pstack:ent-security-engineer` and `pstack:ent-code-reviewer`.
Neither carries `Write` or `Edit`, because a reviewer that can edit the code it
is reviewing is not a reviewer. All eighteen carry `disallowedTools: [Agent]`,
which is the frontmatter form of the invariant that an agent never controls the
overall workflow and never self-approves.

Only `pstack:ent-integration-engineer` gets `WebFetch` and `WebSearch`, because its
responsibility is defined by a surface that lives outside the repository.

`/setup-pstack` asks one question per family rather than eighteen questions and
writes the answer per agent. `skills/enterprise-seats/SKILL.md` is the catalog the model
reads at dispatch time.

## The model aliases

`inherit`, `auto`, `haiku`, `sonnet`, and `opus` are documented Qoder
aliases. Qoder also accepts any concrete model name your account can reach.

Two of them are easy to confuse, and the confusion is inherited from upstream:

- `inherit` follows the session model. This is what upstream meant by "use
  whatever the user picked", and upstream spelled it `inherit-parent`.
- `auto` lets Qoder pick per turn. It is a real alias with its own behavior, not
  a synonym for "follow the user".

Upstream used `auto` where this port uses `inherit`, in the sense of "the parent's
model". Where a seat here is set to `auto`, that is deliberate: the panel and the
judge want Qoder choosing, not the session model echoed back.

This guide does not name the concrete models behind the aliases. That mapping is
account-specific, and a page that states it goes stale. Read the names off your
own model picker, or run `/model`, which is Qoder's documented model wizard.

## Changing a seat's model

### The supported way

Run `/setup-pstack`. It asks which models your account can reach, asks for a
reasoning budget, shows you each seat, and writes two files:

1. `agents.overrides` in `settings.json`, which is what actually changes the
   model.
2. `~/.claude/rules/pstack-models.md`, a rule that records the mapping so the
   orchestrator and every seat can report the truth about what ran.

The second file matters. Without it, a skill can only tell you the configured
default, which stops being true the moment an override exists.

### By hand

`settings.json` cannot create new subagents. It only overrides ones Qoder has
already discovered. The documented shape:

```json
{
  "agents": {
    "overrides": {
      "pstack-judge": {
        "modelConfig": {
          "model": "performance",
          "generateContentConfig": { "temperature": 0.2 }
        }
      },
      "pstack-architect": {
        "modelConfig": { "model": "inherit" },
        "runConfig": { "maxTurns": 40, "maxTimeMinutes": 20 }
      },
      "pstack-explorer": { "enabled": false }
    }
  }
}
```

The documented override fields are enablement, `tools`, `modelConfig`,
`runConfig`, and appended `mcpServers`. Note that `mcpServers` appended to a
plugin agent is stripped by the plugin safety policy, so that one does nothing
here.

### Where to put it

Qoder merges three levels, lowest precedence first:

| Level | Path | Shared with the team |
|---|---|---|
| User | `~/.qoder/settings.json` | No, personal, all projects |
| Project | `<project>/.qoder/settings.json` | Yes, commit it |
| Local | `<project>/.qoder/settings.local.json` | No, personal, one project |
| Flag | `--settings` | No, one invocation, highest |

Deep merge, field by field, so you only write the seats you want to change.

Project and local levels apply only when the working directory is trusted. In an
untrusted folder Qoder loads the user level alone and ignores both project files.
That is worth knowing when a shared team override silently does not take.

### Making it take effect

Qoder documents no reload path for `agents.overrides` in the IDE. Start a new
chat, and if the seat still reports its old model, restart Qoder. In the CLI,
`/agents reload` reloads agent definitions.

The earlier version of this guide said a restart was required. That was a guess,
and it has been corrected to what the documentation actually supports.

## What you cannot override

### Effort

`effort` is not among the documented `agents.overrides` fields. `model.reasoningEffort`
exists in `settings.json`, but it is a session-level key that sets the
conversation's reasoning effort, not a per-agent one.

So there is no supported way to change one seat's effort from outside its agent
file. `/setup-pstack` says this plainly rather than pretending, and offers two
honest options: accept the shipped effort, or keep your own copy of the agent
file and accept the shadowing problem below.

### By copying the agent file

This does not work, and it fails silently. Qoder discovers subagents from five
sources and resolves same-name conflicts by priority, lowest to highest:

```text
Built-in  <  User  <  Project  <  Plugin  <  Flag
```

A plugin agent sits at priority 4. A file you write to `~/.qoder/agents/pstack-judge.md`
(priority 2) or `<project>/.qoder/agents/pstack-judge.md` (priority 3) is
**shadowed by the plugin's own copy**, not the other way around. `qoder agents
list` marks the loser as `shadowed`, which is how you can confirm this if you do
not believe it.

The two things that outrank a plugin agent are `settings.json` overrides and the
`--agents` flag. Use the first.

Qoder's own guidance is that plugin subagents are not meant to be edited
directly, which lines up: an edit to `agents/pstack-judge.md` is overwritten the
next time the plugin updates.

## The judge independence caveat

Upstream pstack requires the cross-judge in `/arena` Phase C to come from a
different model vendor than the one that produced the candidates, on the sound
principle that a model grades its own output generously.

**This port cannot guarantee that.** Two reasons:

- Every model Claude Code can run comes from one vendor, so `auto` on the judge might
  resolve to the same family that wrote the candidates.
- There is no per-call model parameter, so the dispatcher cannot request a
  different vendor even if it knew which one to name.

What the port does instead is make the gap visible. `pstack:pstack-judge` reports the
model it ran on in the first line of its reply. The caller compares that to the
model that produced the candidates, and when they match it says the independence
check did not hold rather than presenting the verdict as cross-vendor.

If you want a genuine second opinion, pin the judge to a model you know differs
from your panel seats:

```json
{
  "agents": {
    "overrides": {
      "pstack-judge": { "modelConfig": { "model": "<a model from another family>" } }
    }
  }
}
```

You have to supply the knowledge that the two differ. Nothing in Qoder can check
it for you.

This affects four places in the plugin: `/arena` Phase C, the eval playbook,
`show-me-your-work`, and the design page of the guide. All four now carry the
caveat at the point of use.

## Cost

pstack spends extra tokens on subagents and review panels. That is the price of
the rigor. To spend fewer:

- Move a seat down the alias ladder. `opus` to `sonnet` to `haiku` is
  the direct saving, and it does not change which seat answers.
- Drop an effort. `xhigh` to `medium` cuts reasoning tokens without changing the
  model. Only `pstack:pstack-architect` ships above `high`, so this mostly means editing
  its file.
- Set a seat to `inherit` and let the chat's model absorb the work. Useful for
  seats whose judgment you already trust the main chat to make.
- Dispatch two panel seats instead of three. `/arena` narrows the panel when you
  ask it to. The panel loses diversity, and it will say so.
- Reserve `/poteto-mode` for work that needs rigor. A one-line question does not
  need a playbook and three reviewers.

A strong model in the main chat with cheaper, faster models in the code seats is
a good default split, and roughly what the shipped aliases already encode.

## Adding a seat

Author a fourth panel agent under `agents/`, copying `agents/pstack-panel-3.md`
as the template and giving it the next free panel name. It needs `name`,
`description`, `model`, and `effort` at minimum. Then:

- Add it to the panel dispatch list in `skills/arena/SKILL.md` and
  `skills/interrogate/SKILL.md`, or it will never be reached.
- Add a row to the seat table in `skills/pstack-seats/SKILL.md`.
- Add it to the `expected` map in `check_workflow()` in `scripts/selftest.py`, so
  the test proves it is reachable.
- Give it `isolation: worktree` if it writes, and `disallowedTools: [Agent]`
  unless it genuinely needs to fan out.

Do not set `hooks`, `mcpServers`, or `permissionMode`. The plugin safety policy
strips all three from plugin-provided agents, so they would be dead weight that
looks like configuration.

The color palette has eight entries and 28 seats already use them, so a
twenty-ninth agent will share a color. That is cosmetic, and inside the
enterprise roster it is deliberate, since color reads as family there.

Do not name the new seat anything matching `pstack-*` or `ent-*` until its agent
file exists. `scripts/selftest.py` treats a backticked token with either prefix
as a dispatch target and fails when no file backs it, which is the check that
keeps a typo in a skill from becoming a runtime dispatch failure. An `ent-` seat
that no playbook and no rule names fails the same check from the other direction,
as an orphan.

## Related

- [COMPATIBILITY.md](../COMPATIBILITY.md) for the full feature matrix
- [Setup walkthrough](./guide/01-setup.md) for the guided version of all this
- [rules/pstack-seats.md](../rules/pstack-seats.md) for the seat catalog the model reads at dispatch time
- [rules/enterprise-seats.md](../rules/enterprise-seats.md) for the enterprise roster and its two invariants
- [ENTERPRISE-ARCHITECTURE.md](./ENTERPRISE-ARCHITECTURE.md) for the six-layer design the roster came from
