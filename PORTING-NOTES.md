# Porting notes

How this plugin was built from the Qoder edition of pstack, why it was built that
way, and how to rebuild it when the Qoder edition moves.

This file describes the port. It is not an instruction a model reads at runtime,
so unlike the rest of the tree it names Qoder and Cursor freely. The lever's
vendor gate skips it for exactly that reason. The dash gate does not.

## The lever

Everything ported here was produced by one script:

```bash
python3 scripts/port-from-qoder.py [QODER_ROOT] [UPSTREAM_CLAUDE_ROOT]
```

`QODER_ROOT` defaults to `../pstack-qoder`, the source of truth, including its
enterprise layer. `UPSTREAM_CLAUDE_ROOT` defaults to
`../pstack-source/harness/pstack/claude-code`, upstream's own Claude Code
edition, read only for the two skill frontmatter switches the Qoder edition had
to drop. Neither tree is ever written.

The lever does five things in order:

1. Walks the Qoder tree under `COPY_ROOTS` (`skills`, `agents`, `assets`, `docs`,
   `hooks`, `rules`, `LICENSE`), skipping `EXCLUDES` (the Qoder manifest, the
   Qoder tooling under `scripts/`, and the four provenance documents).
2. Moves the components whose container changed, via `RENAMES`. Each
   `rules/<name>.md` becomes `skills/<name>/SKILL.md`, and the transform refuses
   any rule whose trigger is not `model_decision`, because an `always_on` rule
   would need a `SessionStart` hook instead. `hooks/enterprise-gates.json`
   becomes `hooks/hooks.json` with `name` dropped from each handler.
3. Rewrites agent frontmatter: Qoder model aliases to Claude Code aliases, and
   every key checked against the documented subagent fields.
4. Applies 80 recorded substitutions to Markdown, shell, and Python, then restores
   `disable-model-invocation` and `paths` on skills from upstream's Claude
   edition and inserts one line into each manual-only skill saying how to reach
   the others.
5. Gates the whole shipped tree, and fails loudly.

It writes `scripts/port-report.json` with the counts, every rule's pattern,
replacement, and reason, the hit count per rule, the rules that did not fire, the
hand-owned files, and the gate result.

### Idempotency

A second run writes nothing. Every rule is chosen so its replacement cannot match
its own pattern, hand-owned files are seed-only, and the report is only rewritten
when its content changes. The output says so on its last line:

```text
summary: written=0 seeded=0 protected=15 gate_failures=0
```

`scripts/selftest.sh --rebuild` runs the lever twice and fails unless the second
run reports `written=0` and `git status` is clean.

Hand-owned files are adapted in memory on every run even though they are never
written, so a rule's hit count means the same thing on the first run as on the
tenth: zero means the rule matched nothing anywhere in the Qoder tree. Four rules
and one seat rule that were dead from the start were deleted rather than kept as
noise, which is why the ids have gaps. `check_tables()` fails on a duplicate id.

## The rule catalog

80 rules: C01 to C94 with gaps, M01 to M04, S01 and S03. Grouped by what they
fix:

**Environment and paths (C01 to C16).** Hook environment variables, the
enterprise policy directory, rule cards becoming project skills, the user model
rule, skill and plugin paths, and the transcript layout. The Qoder transcript
slug carried a hash that could not be derived from the path. The Claude Code slug
can, so C12 to C16 replace "list the folder and match by name" with the
derivation upstream's Claude edition documents. The layout was checked against a
real `~/.claude/projects/` folder on the building machine, where the `.jsonl`
lines carry a `type`, and `user` and `assistant` are two types among many.

**Rules became skills (C20 to C25).** Path and noun changes for the three rules.

**Per-seat model overrides (C30 to C38).** The core of the port. Every
"fixed by this file or by `agents.overrides.<seat>`" sentence in the 28 agents
becomes "defaults to this file's frontmatter, and the dispatcher can override
both on the `Agent` call from the `<seat>:` line". C33 rewrites the panel-3 note,
because Qoder's `auto` was a real per-turn alias and Claude Code's `inherit` is
not, and because "pin this seat to a third vendor" is impossible here. C38 tells
`poteto-agent` that subagents run in the background and that the `Agent` tool
takes `isolation`.

**Section titles and host naming (C40 to C66, C76, C84 to C92).** Only where the
sentence stays true with the host renamed. There is no blanket `Qoder` to
`Claude Code` rule on purpose. "Qoder has no timer" renamed would be false, and a
lexical rule cannot tell the difference, so every surviving mention fails the
gate and gets a rule or a hand edit chosen for its sentence.

**Capabilities that came back (C70 to C75, C77 to C81, C83, C86, C93, C94).**
The Qoder lever turned `/loop`, background execution, and per-call reasoning into
fallbacks. These rules turn them back into upstream's own sentences with the host
renamed: `/loop` in visual parity, the recipes, bug fix, and shipping; background
shell commands; worktree isolation per call; per-call effort in every playbook
that picks a subagent's reasoning level.

**Judge independence (C64, C65, C87, and the hand edits).** Kept honest. Qoder
could not check vendor independence because aliases hid the vendor. Claude Code
cannot deliver it because there is only one vendor. The wording changed and the
conclusion did not: report the model, say when independence did not hold, and
call a different Anthropic model "same vendor".

**Model aliases in prose (M01 to M04).** Backticked `performance`, `efficient`,
and `lite` become `opus`, `sonnet`, and `haiku`. `auto` is only rewritten in
seat-table cells, because prose about `auto` described Qoder semantics that had to
be rewritten by hand.

**Seat dispatch names (S01, S03).** Generated from the agent file names.
`subagent_type: x` becomes `subagent_type: "pstack:x"`, and every other
backticked seat name gets the `pstack:` prefix. The lookbehind on the backtick is
what makes S03 idempotent. A rule-file line key such as `` `pstack-judge:` `` is
not matched, because the seat name has to be followed directly by a backtick.

## Hand-owned files

15 files are listed in `HAND_REWRITES`. The principle is the same as in the Qoder
edition: a file belongs there only when no substitution can make it correct.

- **Routing model (5).** `skills/poteto-mode/SKILL.md` (the Subagents section),
  `skills/setup-pstack/SKILL.md` (rewritten end to end around the rule file),
  `skills/poteto-help/SKILL.md`, `skills/pstack-seats/SKILL.md` (the rule turned
  skill, with a new "Dispatching a seat" section), `docs/MODEL-ROUTING.md`.
- **Fan-out (2).** `skills/arena/SKILL.md`, `skills/swarm/SKILL.md`. Their Qoder
  text explained a missing per-call model and a missing background flag.
- **Capability shape (3).** `skills/automate-me/SKILL.md` (transcript format,
  authoring skill, the real manual-only switch), `skills/make-bot-ui/SKILL.md`,
  `skills/prd-rules/SKILL.md` (cards become project skills).
- **Transcript lookup (1).** `skills/poteto-mode/scripts/worktree-audit.sh`
  derives the slug and matches worktree slugs that start with the repo's.
- **The loop (4).** `playbooks/autonomous-run.md`, `playbooks/autopilot-full.md`,
  `docs/guide/01-setup.md` (install), `docs/guide/07-overnight.md`.

Several files the Qoder edition hand-owned are mechanical here: `interrogate`,
`how`, `architect`, `no-comments`, `bug-fix`, `shipping`, `babysit`, and guide
pages 2, 5, 9, and 10. Their Qoder text was already right for Claude Code apart
from sentences a rule could reach.

Each hand-owned file was seeded from the adapted text on the first run, so the
hand edit started from a real diff, and is gated like any other file.

## Port-authored files

Not copied from the Qoder tree at all: `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `README.md`, `COMPATIBILITY.md`,
`PORTING-NOTES.md`, `CONNECTORS.md`, `PROGRESS.md`, `scripts/selftest.py`,
`scripts/selftest.sh`, and `scripts/test-gates.py`. The lever lists them as
`PORT_AUTHORED`, never writes them, and prints `present` or `MISSING` for each.

`test-gates.py` began as a copy of the Qoder edition's and keeps every one of its
assertions, with the policy path, the environment variable, and the seat names
changed. It now wraps each event in Claude Code's documented common fields and
adds three tests: the `hooks.json` shape, the exact `ask` payload keys, and that
an ask from inside a seat records its `agent_id` and `agent_type`. 46 assertions.

`selftest.py` was written fresh against Claude Code's documented fields rather
than ported, because most of the Qoder edition's checks were about Qoder's
schema. It keeps the playbook-title fold, the enterprise reachability check, the
composition-chain check, the workflow trace, and the import of the lever's own
gate so the two cannot drift.

## The gate

Two tiers.

**Style, everywhere.** No em dash and no en dash in any `.md`, `.sh`, `.py`, or
`.json` file, provenance documents included, because the plugin ships **unslop**
and its rule 13.

**Vendor, everywhere except provenance.** `FORBIDDEN_PATTERNS` rejects the Qoder
brand in any case, `QODER_`, `.qoder/`, `agents.overrides`, `modelConfig`,
`model_decision`, `always_on`, any `trigger:` frontmatter, a Qoder alias as an
agent's `model:`, a backticked Qoder alias in prose, "Custom Agent",
`conversation-history`, and the Qoder transcript root. It also keeps every Cursor
pattern the Qoder gate enforced, except `/loop`, which is a real Claude Code
command now and is meant to appear.

`GATE_SKIPS` holds the provenance documents (`README.md`, `COMPATIBILITY.md`,
`PORTING-NOTES.md`, `CONNECTORS.md`, `PROGRESS.md`, `docs/MODEL-ROUTING.md`) and
the two manifest files, whose description names the port on purpose. `scripts/`
is skipped because the lever and the report hold every pattern by construction.
The upstream GitHub URL is allowed everywhere as a citation.

## Mistakes caught by reading, not by the gate

- **A seat rule scoped its own line key.** The first version of the override
  rules wrote "from the `` `pstack-panel-3` `` line", and S03 then scoped it to
  `` `pstack:pstack-panel-3` ``, which is not the key the rule file uses. The fix
  was to emit `` `pstack-panel-3:` ``, which S03 cannot match.
- **A capitalized clause.** One override rule matched both "Your" and "your" and
  always emitted "Your", producing "and Your model" mid-sentence in
  `pstack-architect`. The rule now matches only the sentence-initial form.
- **`inherit` is not a valid `Agent` argument.** The `Agent` tool's `model` takes
  an alias only. A naive port would have told dispatchers to pass
  `model: "inherit"`. The rule file keeps `inherit` as a value, and every
  dispatching skill resolves it to the chat's alias or omits it and says so.
- **Restoring manual-only skills breaks skill-to-skill calls.** With
  `disable-model-invocation: true` the `Skill` tool refuses the skill and its
  description leaves the model's context. Restoring the switch without the
  inserted "read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md`" line would have
  left the orchestrator unable to run the playbooks' named skills.

## When the Qoder edition updates

```bash
python3 scripts/port-from-qoder.py
git diff
scripts/selftest.sh --rebuild
```

Then:

1. Read the diff in the mechanically adapted files. A new Qoder sentence no rule
   matches survives verbatim, and the gate catches only what it knows.
2. Check `rules_that_did_not_fire` in `port-report.json`. It should stay empty.
3. Diff the 15 hand-owned files' Qoder sources against the last ported version.
   The lever will not tell you they drifted, because it never writes them.
4. A new agent under `agents/` is picked up automatically, including its `pstack:`
   scoping, and `selftest.py` fails if no playbook or seat skill names an `ent-`
   seat.
5. A new Qoder rule becomes a skill only after it is added to `RENAMES`, and only
   if its trigger is `model_decision`.

Bump `version` in `.claude-plugin/plugin.json` and the marketplace entry to match
the upstream cut. It tracks 0.15.43.

## Known open items

- **No live session observed.** `claude plugin validate .` passes and every
  static check passes. No session has dispatched a `pstack:` seat or fired a gate
  on this machine, because installing the plugin into the user's Claude Code
  config was out of scope.
- **Per-call effort needs v2.1.292 or later.** Older builds run each seat at its
  frontmatter effort and ignore the rule file's effort token.
- **Hook `ask` under `bypassPermissions`** was not tested.
- **The judge is one vendor.** Recorded at every point of use.
- **Twenty-eight agents share eight colors.** Cosmetic.
- **The four missing views of the source architecture artifact** are still
  missing, as in the Qoder edition.
