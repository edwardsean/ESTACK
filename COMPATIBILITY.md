# Feature compatibility

The honest accounting of what survived the port from the Qoder edition of pstack
to Claude Code, what changed shape, what came back, and what still does not work.
A port that quietly drops a feature is worse than one that says the feature is
gone.

Read this before you trust any instruction in this plugin that mentions a model,
a subagent, a loop, or a reviewer from another vendor.

## What this was checked against

Claude Code documentation, retrieved for this port:

- https://code.claude.com/docs/en/sub-agents (frontmatter fields, plugin subagent restrictions, model resolution order, per-call effort and isolation, background default)
- https://code.claude.com/docs/en/hooks (handler fields, PreToolUse `ask`, exit code 2 per event, SubagentStop input, hooks inside subagents, `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT`)
- https://code.claude.com/docs/en/skills (frontmatter fields, `disable-model-invocation`, plugin skill naming, `${CLAUDE_PLUGIN_ROOT}` substitution, 1,536-character listing limit)
- https://code.claude.com/docs/en/plugin-marketplaces (marketplace file, relative source, `claude plugin validate`)

Plus the installed reference plugins `superpowers` 7.0.2, `pr-review-toolkit`,
and `learning-output-style`, for exact manifest and hook file shapes, and the
`Agent` tool schema of the session that performed the port. `claude plugin
validate .` passes on the result.

Source: the Qoder edition at `../pstack-qoder` (pstack 0.15.43 plus its
enterprise layer), read only. Upstream's own Claude Code edition at
`../pstack-source/harness/pstack/claude-code`, read only, for frontmatter and
transcript conventions.

## Summary

| | Count |
|---|---|
| Skills | 63 (60 from the Qoder edition, plus 3 converted from its rules) |
| Manual-only skills (`disable-model-invocation: true`) | 57 |
| Model-invocable skills | 6 (`pstack-seats`, `enterprise-seats`, `enterprise-gates`, `prd-rules`, `setup-enterprise`, `setup-pstack`) |
| Agents | 28 (10 pstack seats, 18 enterprise seats) |
| Playbooks routed by the orchestrator | 34 (12 enterprise) |
| Hook handlers | 3 (`PreToolUse`, `PostToolUse`, `SubagentStop`) |
| Files ported by the lever | 207 |
| Files hand-owned after seeding | 15 |
| Recorded substitution rules | 80, every one of which fires |
| Features dropped | 0 |

## The one structural difference

The Qoder edition bound `model` and `effort` to an agent and overrode them in
`settings.json` under `agents.overrides`, because Qoder's `Agent` tool takes no
model. **Claude Code has no `agents.overrides` key.** It does take `model` and
`effort` on each `Agent` call, and a per-call value wins over the frontmatter.

So the override moved from a settings file Qoder reads at load time to a rule
file the dispatcher reads at call time:

| | Qoder edition | Claude Code edition |
|---|---|---|
| Where a seat's choice lives | `settings.json` `agents.overrides.<seat>.modelConfig.model` | `~/.claude/rules/pstack-models.md`, line `<seat>: <model> <effort>` |
| Who applies it | Qoder, when it loads the agent | The dispatching skill, as `model` and `effort` on the `Agent` call |
| Effort override | Not possible | Per call, Claude Code v2.1.292 or later |
| Takes effect | New chat, maybe a restart | Next dispatch once the file is read; new sessions load it at start |
| Written by | `/setup-pstack` | `/pstack:setup-pstack`, rewritten for this |
| Beaten by | Nothing documented | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, `CLAUDE_CODE_EFFORT_LEVEL` |

The seats stay. Each one carries a contract as well as a model: a read-only tool
list, `isolation: worktree`, or `disallowedTools: [Agent]`. Claude Code registers
them as `pstack:<seat>`, and every dispatch reference in the tree was scoped to
that name.

## Mapping applied

| Qoder | Claude Code | How |
|---|---|---|
| `.qoder-plugin/plugin.json` | `.claude-plugin/plugin.json`, plus `.claude-plugin/marketplace.json` | Hand-written |
| `"skills"`, `"agents"`, `"rules"`, `"hooks"` manifest paths | Default locations, no path keys | Claude Code discovers `skills/`, `agents/`, `hooks/hooks.json` |
| `rules/*.md` with `trigger: model_decision` | `skills/<name>/SKILL.md`, same description | Lever transform. None of the three was `always_on`, so no `SessionStart` hook was needed |
| `hooks/enterprise-gates.json` | `hooks/hooks.json` | Lever transform. `name` dropped (not a handler field), `statusMessage` kept (documented) |
| `${QODER_PLUGIN_ROOT}`, `QODER_PROJECT_DIR` | `${CLAUDE_PLUGIN_ROOT}`, `CLAUDE_PROJECT_DIR` | C01, C02 |
| `.qoder/enterprise/gates.json`, `approvals.jsonl`, `governance.json`, `knowledge/index.md` | `.claude/enterprise/...` | C03 |
| `.qoder/rules/enterprise-<domain>.md` rule cards | `.claude/skills/enterprise-<domain>/SKILL.md` project skills | C04, C05, hand edit in `prd-rules` |
| `.qoder/rules/pstack-models.md` | `~/.claude/rules/pstack-models.md` | C06, upstream Claude edition's convention |
| `~/.qoder/skills/`, `.qoder/skills/`, `~/.qoder/plugins/` | `~/.claude/skills/`, `.claude/skills/`, `~/.claude/plugins/` | C07 to C09 |
| `~/.qoder/cache/projects/<slug-hash>/conversation-history/<id>/<id>.jsonl` | `~/.claude/projects/<slug>/<session>.jsonl`, slug derivable | C12 to C16, hand edits in `automate-me` and `worktree-audit.sh` |
| `model: performance`, `efficient`, `lite`, `auto` | `opus`, `sonnet`, `haiku`, `inherit` | Agent frontmatter transform, M01 to M04 in prose |
| Bare seat names `pstack-judge` | `pstack:pstack-judge`, `subagent_type: "pstack:..."` | S01, S03 |
| `tools: [..]`, `disallowedTools: [..]` YAML lists | Kept as YAML lists | Documented as accepted |
| `isolation: worktree` in frontmatter | Kept | Documented subagent field |
| "Qoder specifics" agent sections | "Claude Code specifics", content rewritten | C30 to C40, C45, C46 |
| "Custom Agent" | "plugin subagent" | Hand edits |
| Skill `disable-model-invocation` dropped, intent moved into the description | Restored from upstream's Claude edition for 57 skills, description guard kept | Lever transform, plus one inserted line telling the model how to reach a manual-only skill |
| `paths` dropped from `typescript-best-practices` | Restored | Lever transform |

## What came back

The Qoder edition replaced several upstream steps with a fallback and a statement
of what was lost. Claude Code has the capability, so the real step returns.

| Upstream step | Qoder edition | Claude Code edition |
|---|---|---|
| Per-call model | Fixed per seat | `model` on the `Agent` call, from the seat's line |
| Per-call reasoning effort | Fixed per seat, not overridable at all | `effort` on the `Agent` call. Every "name the seat rather than a reasoning level" sentence became "pick each subagent's seat and reasoning level" (C93) |
| Background subagents | A per-agent default needing a settings switch, "do not promise a detached run" | Subagents run in the background by default and notify the parent (`arena`, `swarm`, `poteto-mode`, `poteto-agent`) |
| `/loop` wake | Not supported, one bounded attended pass | `/loop` in `autonomous-run`, `autopilot-full`, `bug-fix`, `shipping`, `visual-parity`, the overnight guide page and the recipes page (C70 to C75, C77, hand edits) |
| Worktree per dispatch | Only seats with `isolation: worktree`, or a manual `git worktree add` | Also `isolation: "worktree"` on any `Agent` call |
| Manual-only skills | A sentence in the description, a hint the model could ignore | `disable-model-invocation: true`, enforced by Claude Code |
| Background shell scan in `worktree-cleanup` | "let it finish" | "run it in the background" (C73) |

## Changed shape

| Qoder edition | Claude Code edition | Why |
|---|---|---|
| `/poteto-mode` | `/pstack:poteto-mode` (bare name also works) | Claude Code namespaces plugin skills |
| Seat dispatched as `pstack-judge` | Dispatched as `pstack:pstack-judge` | Claude Code namespaces plugin agents |
| `pstack-panel-3` and `pstack-judge` on `auto` (Qoder picks per turn) | On `inherit` (the chat's model) | Claude Code has no `auto` alias. Pin both in the rule file; the judge almost always should differ from the chat |
| Rule cards written by `/prd-rules` as `.qoder/rules/*.md` | Project skills under `.claude/skills/enterprise-<domain>/` | `.claude/rules/` would load every card into every session. A skill loads by description, which is what `model_decision` did |
| `general-purpose` when a seat line says "pinned to parent" | `inherit` passes the chat's alias | `Agent` takes no `inherit`, but it does take an alias |
| A skill naming another skill invoked it | A manual-only skill is read from `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` | The `Skill` tool refuses manual-only skills, so each carries one line saying how to reach the others |
| Disk cleanup of the Qoder app cache | Old transcripts under `~/.claude/projects/` with the user's agreement | Claude Code's growth is its transcript store (C83) |
| "Qoder's built-in `/create-skill`" | The skill-authoring skill the session offers, or by hand | Claude Code ships no create-skill built-in (C58, C82) |
| Per-skill mode via `.qoder/rules/` | `CLAUDE.md` or `~/.claude/rules/` | Claude Code's always-loaded locations |

## Does not work, and is not pretended to

| Feature | Status | What the port does instead |
|---|---|---|
| A judge from a different model vendor | **Cannot hold.** Every model Claude Code runs is Anthropic's | `pstack:pstack-judge` reports the model it ran on. The caller compares it to the models that produced the candidates, says the check did not hold when they match, and calls a different model "same vendor" when they differ. Affects `/arena` Phase C, the eval playbook, `show-me-your-work`, the design guide page |
| Unattended runs past a closed laptop | **Not supported.** `/loop` lives in its session | A ceiling plus a resume note. `/schedule` cloud routines exist on some accounts and were not tested |
| Cursor Automations, inbound webhooks, `/make-bot-ui` | **Not supported** | `make-bot-ui` says so first, then offers the parts that transfer |
| Cloud agents on a second machine | **Not assumed** | Local worktrees |
| Cursor Bugbot, `cursor-team-kit` skills | **Not ported** | `bot-triage.md` is bot-agnostic; code-slop stripping is stated in plain words, and `/unslop` is explicitly not a substitute |
| Copying a seat to `~/.claude/agents/` to override it | **Does nothing for pstack** | Creates a second, unscoped agent that pstack never dispatches. Use the rule file |
| Overriding a model when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | **Ignored by Claude Code** | `/pstack:setup-pstack` checks and says so |

## Enterprise layer status

| Part | Status |
|---|---|
| Approval gates (`hooks/hooks.json` plus three scripts) | **Wired and proven offline, firing never observed.** `scripts/test-gates.py` passes 46 assertions driving the real entry points with Claude Code-shaped events. `claude plugin validate .` lists all three hooks. Step 6 of `/pstack:setup-enterprise` is the live check |
| Hooks inside subagents | **Documented, not observed.** The Qoder edition's biggest open question was whether `PreToolUse` reaches a seat. Claude Code documents that `PreToolUse` and `PostToolUse` fire for a subagent's tool calls with `agent_id` and `agent_type` set. The `SubagentStop` backstop stays as defense in depth |
| Exit codes | Same semantics as the Qoder edition: `PreToolUse` exit 2 blocks with stderr to Claude, `PostToolUse` exit 2 only shows stderr (the audit script never uses it), `SubagentStop` exit 2 keeps the seat running with stderr as its next instruction, and `stop_hook_active` prevents a loop |
| `ask` under `bypassPermissions` | **Unverified.** Whether a hook's `ask` still prompts in that mode was not tested |
| `/pstack:prd-rules`, `/pstack:setup-enterprise` | **Unverified at runtime.** Same as the Qoder edition |
| 12 enterprise playbooks, 18 `ent-*` seats | **Statically proven, never dispatched.** Every seat is reachable from a playbook or the enterprise-seats skill, every seat denies `Agent`, the two reviewers hold no write tools |
| 13-step loop, delegation modes, composition chains, delivery pipeline | **Prose only**, as before. The gates are the only enforced part |
| Dormancy | Kept. No `.claude/enterprise/gates.json`, no prompt, no log, no python start on the fast path |
| Platform boundary | Unchanged. Branch protection, required reviewers, CODEOWNERS, and CI gates are platform-side and nothing here installs or checks them |

The four views of the source architecture artifact that were never supplied (a
decision flowchart, an order-cancellation sequence, a responsibility matrix, the
design checks) are still missing, and `docs/ENTERPRISE-ARCHITECTURE.md` still
records them as gaps.

## Frontmatter fields

Agent frontmatter uses only `name`, `description`, `model`, `effort`, `color`,
`isolation`, `tools`, and `disallowedTools`, all documented. No agent sets
`hooks`, `mcpServers`, `permissionMode`, or `initialPrompt`, which Claude Code
ignores on plugin subagents. `scripts/selftest.py` fails on any of them.

Skill frontmatter uses `name`, `description`, `disable-model-invocation`, and
`paths`. No description exceeds the 1,536-character listing limit.

Twenty-eight agents over an eight-color palette share six colors. Within the
enterprise roster color reads as family. Cosmetic.

## How to re-verify any of this

```bash
python3 scripts/port-from-qoder.py      # rebuild from pstack-qoder, then gate the tree
python3 scripts/selftest.py             # static conformance
python3 scripts/test-gates.py           # drives the hook scripts with Claude Code hook events
scripts/selftest.sh --rebuild           # all of the above, a hook smoke test, claude plugin validate, idempotency
```

## What no static test can prove

That a live Claude Code session dispatches a `pstack:` seat with the model the
rule file names, and that the gates fire in a real session. Neither has been
observed. [README.md](./README.md#verifying-it) lists the three live checks.
