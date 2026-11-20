---
name: setup-pstack
description: Configure which model each pstack and enterprise seat runs on, and at what reasoning effort. Qoder binds models to Custom Agents rather than to calls, so this writes settings.json agent overrides plus a rule that records the mapping. Use for /setup-pstack, "configure pstack models", "pstack budget", "configure enterprise seats", or changing pstack's model choices.
---
# Setup pstack

pstack routes work to seats, and a seat is a Custom Agent. Qoder binds `model` and `effort` in agent frontmatter, and there is no per-call model parameter, so changing a seat's model means overriding the agent.

Twenty-eight seats ship with this plugin. Ten are pstack's, routed by skills. Eighteen more are the enterprise roster, routed by the `/poteto-mode` orchestration loop. Both kinds are configured the same way here, and a repository that never runs an enterprise chain can skip those five family questions entirely.

This skill writes two files:

1. `agents.overrides` in `settings.json`, which is what actually changes the model. Qoder documents no reload path for it in the IDE, so it takes a new chat to be read.
2. `~/.claude/rules/pstack-models.md`, an Always Apply rule that records the mapping so the orchestrator and every seat report the truth about what ran.

## Seats

| Role | Seat agent | Plugin default model | Default effort |
|---|---|---|---|
| Implementation | `pstack:poteto-agent` | `opus` | high |
| Architecture and planning | `pstack:pstack-architect` | `opus` | xhigh |
| Review and design panel, seat 1 | `pstack:pstack-panel-1` | `opus` | high |
| Review and design panel, seat 2 | `pstack:pstack-panel-2` | `sonnet` | high |
| Review and design panel, seat 3 | `pstack:pstack-panel-3` | `inherit` | high |
| Independent judgment | `pstack:pstack-judge` | `inherit` | high |
| Verification and swarm workers | `pstack:pstack-verifier` | `sonnet` | high |
| Read-only understanding | `pstack:pstack-explorer` | `haiku` | medium |
| Mechanical bulk edits | `pstack:pstack-mechanic` | `sonnet` | medium |
| Comment review | `pstack:comment-sicko` | `sonnet` | high |

### Enterprise roster

Eighteen more seats in five families, dispatched by the `/poteto-mode` orchestration loop rather than by a skill of their own. The roster and its invariants live in the **enterprise-seats** skill. Ask about these once per family, not once per seat, because a family shares a responsibility boundary and a user routing one of them almost always routes the rest the same way.

| Role | Seat agent | Plugin default model | Default effort |
|---|---|---|---|
| Requirements | `pstack:ent-product-analyst` | `sonnet` | high |
| Business rules | `pstack:ent-business-analyst` | `sonnet` | high |
| PRD authoring | `pstack:ent-prd-agent` | `sonnet` | high |
| System shape | `pstack:ent-system-architect` | `opus` | xhigh |
| API contracts | `pstack:ent-api-architect` | `opus` | xhigh |
| Schema and migrations | `pstack:ent-database-architect` | `opus` | xhigh |
| Service implementation | `pstack:ent-backend-engineer` | `opus` | high |
| Web surface | `pstack:ent-frontend-engineer` | `opus` | high |
| Mobile client | `pstack:ent-mobile-engineer` | `opus` | high |
| Data access layer | `pstack:ent-database-engineer` | `opus` | high |
| Cross-service glue | `pstack:ent-integration-engineer` | `opus` | high |
| Test design and execution | `pstack:ent-qa-engineer` | `opus` | xhigh |
| Security assessment, read-only | `pstack:ent-security-engineer` | `opus` | xhigh |
| Independent code review, read-only | `pstack:ent-code-reviewer` | `opus` | xhigh |
| Measurement and budgets | `pstack:ent-performance-engineer` | `opus` | xhigh |
| Pipeline and infrastructure | `pstack:ent-devops-engineer` | `sonnet` | high |
| Incident system view | `pstack:ent-sre` | `sonnet` | high |
| Logs, metrics, traces | `pstack:ent-observability` | `sonnet` | high |

## Steps

### 1. Establish what the user can actually run

Do not enumerate models by guessing. Two sources, in order:

- Read `modelConfigs.aliases` and `modelConfigs.customAliases` from `~/.qoder/settings.json` and `<project>/.qoder/settings.json` when they exist. Those name real aliases.
- Ask the user to paste the model names they see in Qoder's model picker, or to run `/model` and report the list.

The aliases `inherit`, `auto`, `haiku`, `sonnet`, and `opus` are always valid. Never write a concrete model name you have not confirmed the user has. An unconfirmed name makes the seat fail at dispatch, and the failure surfaces far from its cause.

### 2. Load current state

Read `agents.overrides` from `<project>/.qoder/settings.json`, then `<project>/.qoder/settings.local.json`, then `~/.qoder/settings.json`. Higher precedence wins per key. Treat any `pstack-*`, `ent-*`, `pstack:poteto-agent`, or `pstack:comment-sicko` entry as a prior choice.

Read `~/.claude/rules/pstack-models.md` when it exists, and reconcile it against the overrides. When they disagree, the overrides are the truth, because they are what Qoder loads. Say so, and rewrite the rule to match.

### 3. Ask, per role bucket

Prefer `AskUserQuestion` over free text. Ask the pstack seats in the buckets below, one question per bucket the user cares about routing separately:

- Architecture and planning (`pstack:pstack-architect`)
- Implementation (`pstack:poteto-agent`)
- Code review and design (the three panel seats)
- Independent judgment (`pstack:pstack-judge`)
- Verification (`pstack:pstack-verifier`)

Offer the confirmed aliases and model names, plus `inherit` for "follow the session model". Support the three support seats (`pstack:pstack-explorer`, `pstack:pstack-mechanic`, `pstack:comment-sicko`) in one follow-up question rather than three.

For the panel bucket, explain the tradeoff before asking. Three seats on three different models give a real panel. Three seats on one model give three samples of the same judgment, which still catches nondeterminism but not blind spots. Let the user pick, and record which they picked.

Then five more questions, one per enterprise family, each written per agent:

- Product and requirements (`pstack:ent-product-analyst`, `pstack:ent-business-analyst`, `pstack:ent-prd-agent`)
- Architecture and design (`pstack:ent-system-architect`, `pstack:ent-api-architect`, `pstack:ent-database-architect`)
- Engineering (`pstack:ent-backend-engineer`, `pstack:ent-frontend-engineer`, `pstack:ent-mobile-engineer`, `pstack:ent-database-engineer`, `pstack:ent-integration-engineer`)
- Quality and governance (`pstack:ent-qa-engineer`, `pstack:ent-security-engineer`, `pstack:ent-code-reviewer`, `pstack:ent-performance-engineer`)
- Infra and operations (`pstack:ent-devops-engineer`, `pstack:ent-sre`, `pstack:ent-observability`)

Ask each family as one question with one answer applied to every seat in it, and offer "split this family" as an option so a user who wants `pstack:ent-code-reviewer` on a different vendor than `pstack:ent-qa-engineer` can say so instead of editing JSON afterwards. Skip a family the repository will never dispatch, and say which ones you skipped.

One independence note matters more than the rest. Where the governance policy requires a review, `pstack:ent-code-reviewer` and `pstack:ent-security-engineer` should not sit on the same model as the engineering seats whose work they review, because a model grades its own output generously. Say that before asking the quality family, and record what the user chose.

Ask about effort separately, once, as a budget:

- `large` keeps each seat's default effort
- `medium` lowers each one step on the ladder `xhigh` > `high` > `medium` > `low`
- `small` lowers each two steps

Effort lives in agent frontmatter. Qoder's documented `agents.overrides` fields are enablement, tools, models, and run limits, and `model.reasoningEffort` is a session-level key, not a per-agent override. So an effort change means editing the plugin's agent file, which Qoder does not recommend and which an update overwrites. Tell the user that plainly. Offer the two honest options: accept the shipped effort, or keep a project-level copy of the agent under `.qoder/agents/` and accept that the plugin version shadows it. Do not claim an effort override you cannot write.

### 4. Validate

Every model value you are about to write is either one of `inherit`, `auto`, `haiku`, `sonnet`, `opus`, or a name the user confirmed in step 1. Anything else stops the run and goes back to step 3.

### 5. Write the overrides

Merge into the target `settings.json`, preserving every unrelated key. Qoder deep-merges objects, so write only the pstack and enterprise entries. Ask which level before writing: project (`.qoder/settings.json`, committed and shared) or user (`~/.qoder/settings.json`, personal, all projects). Default to project for a team repo and say which you chose.

```json
{
  "agents": {
    "overrides": {
      "poteto-agent":    { "modelConfig": { "model": "<confirmed>" } },
      "pstack-architect":{ "modelConfig": { "model": "<confirmed>" } },
      "pstack-panel-1":  { "modelConfig": { "model": "<confirmed>" } },
      "pstack-panel-2":  { "modelConfig": { "model": "<confirmed>" } },
      "pstack-panel-3":  { "modelConfig": { "model": "<confirmed>" } },
      "pstack-judge":    { "modelConfig": { "model": "<confirmed>" } },
      "pstack-verifier": { "modelConfig": { "model": "<confirmed>" } },
      "pstack-explorer": { "modelConfig": { "model": "<confirmed>" } },
      "pstack-mechanic": { "modelConfig": { "model": "<confirmed>" } },
      "comment-sicko":   { "modelConfig": { "model": "<confirmed>" } },

      "ent-product-analyst":      { "modelConfig": { "model": "<confirmed>" } },
      "ent-business-analyst":     { "modelConfig": { "model": "<confirmed>" } },
      "ent-prd-agent":            { "modelConfig": { "model": "<confirmed>" } },
      "ent-system-architect":     { "modelConfig": { "model": "<confirmed>" } },
      "ent-api-architect":        { "modelConfig": { "model": "<confirmed>" } },
      "ent-database-architect":   { "modelConfig": { "model": "<confirmed>" } },
      "ent-backend-engineer":     { "modelConfig": { "model": "<confirmed>" } },
      "ent-frontend-engineer":    { "modelConfig": { "model": "<confirmed>" } },
      "ent-mobile-engineer":      { "modelConfig": { "model": "<confirmed>" } },
      "ent-database-engineer":    { "modelConfig": { "model": "<confirmed>" } },
      "ent-integration-engineer": { "modelConfig": { "model": "<confirmed>" } },
      "ent-qa-engineer":          { "modelConfig": { "model": "<confirmed>" } },
      "ent-security-engineer":    { "modelConfig": { "model": "<confirmed>" } },
      "ent-code-reviewer":        { "modelConfig": { "model": "<confirmed>" } },
      "ent-performance-engineer": { "modelConfig": { "model": "<confirmed>" } },
      "ent-devops-engineer":      { "modelConfig": { "model": "<confirmed>" } },
      "ent-sre":                  { "modelConfig": { "model": "<confirmed>" } },
      "ent-observability":        { "modelConfig": { "model": "<confirmed>" } }
    }
  }
}
```

Omit any seat the user left on its plugin default, including a whole enterprise family the repository will never dispatch. A shorter file is a truer one.

### 6. Write the rule

Write `~/.claude/rules/pstack-models.md` as an Always Apply rule. Overwrite the whole file so re-runs stay idempotent.

```markdown
# pstack model configuration

Written by /setup-pstack. One line per seat. Delete a line to fall back to the
plugin default in the pstack-seats or enterprise-seats rule.

# defaults: 2

poteto-agent: <model>
pstack-architect: <model>
pstack-panel-1: <model>
pstack-panel-2: <model>
pstack-panel-3: <model>
pstack-judge: <model>
pstack-verifier: <model>
pstack-explorer: <model>
pstack-mechanic: <model>
comment-sicko: <model>

ent-product-analyst: <model>
ent-business-analyst: <model>
ent-prd-agent: <model>
ent-system-architect: <model>
ent-api-architect: <model>
ent-database-architect: <model>
ent-backend-engineer: <model>
ent-frontend-engineer: <model>
ent-mobile-engineer: <model>
ent-database-engineer: <model>
ent-integration-engineer: <model>
ent-qa-engineer: <model>
ent-security-engineer: <model>
ent-code-reviewer: <model>
ent-performance-engineer: <model>
ent-devops-engineer: <model>
ent-sre: <model>
ent-observability: <model>

Panel diversity: <three distinct models | one model, three samples>
Judge independence from the parent model: <holds | does not hold | unknown>
Reviewer independence from the engineering seats: <holds | does not hold | not configured>
```

The `# defaults: 2` line marks this schema version. Version 2 is the one that carries the enterprise roster. A rule reading `# defaults: 1`, or one with no version line at all, came from an older run and is missing 18 seats, so rewrite it whole rather than appending to it.

### 7. Confirm

Tell the user what was written and where, and that a new chat is needed before `agents.overrides` is read, plus a restart if a seat still reports its old model. Name the seats left on plugin defaults, and the enterprise families skipped entirely, since a skipped family is the difference between "on its default" and "this repo will never dispatch it". State plainly whether the judge seat is now independent from the parent model, because that is the one property upstream pstack guarantees and this port cannot check at dispatch time. Say the same about the reviewer seats, because an enterprise chain leans on that independence for every review its governance policy requires.

### 8. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill`. On no, move on without pushing.

Qoder resolves project skills from `.claude/skills/<name>/SKILL.md`, so that is where the generated skill goes.

### 9. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill. If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, invoke it. On no, move on without pushing.

## What this port cannot do

Upstream `/setup-pstack` detects entitled model slugs from the running session and writes reasoning levels per role. Qoder exposes neither to a skill. This version asks instead of detecting, and it configures models but not per-seat effort. Both gaps are recorded in `COMPATIBILITY.md`. Do not paper over them by inventing slugs or claiming an effort write succeeded.
