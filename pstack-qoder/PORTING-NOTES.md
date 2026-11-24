# Porting notes

How this plugin was built from Cursor pstack, why it was built that way, and how
to rebuild it when upstream moves.

This file describes the port. It is not an instruction a model reads at runtime,
so unlike the rest of the tree it names Cursor freely. The lever's gate skips it
for exactly that reason.

## The lever

Everything copied or adapted here was produced by one script:

```bash
python3 scripts/port-from-upstream.py [UPSTREAM_ROOT]
```

`UPSTREAM_ROOT` defaults to `../upstream/pstack`. The upstream tree is only
ever read.

The lever does four things in order:

1. Walks upstream and copies the roots listed in `COPY_ROOTS`, skipping
   `EXCLUDES`.
2. Applies 54 recorded mechanical substitutions to Markdown and shell files, then
   the hand-chosen dash replacements in `DASH_FIXES`.
3. Leaves the 24 hand-owned files and the 14 port-authored ones alone, seeding
   any of them from upstream only when the destination does not exist yet.
4. Gates the entire shipped tree and fails loudly if a Cursor-only construct
   survives anywhere outside a file it knows is hand-owned.

It writes `scripts/port-report.json` with the counts, the substitutions that
fired, the hand-owned files it protected, and the gate result.

### Why a script and not a copy

A hand-edited fork goes stale the first time upstream ships a fix, and there is
no way to tell which of your edits were load-bearing. A lever means an upstream
update is a re-run plus a reviewable diff.

It also means the adaptation is *auditable*. Every substitution is a tuple of
pattern, replacement, and the reason it is correct. A reviewer can check the
reason without reading 58 skills. `port-report.json` records which rules actually
fired and how often, so a rule that stops matching shows up as a zero rather than
as silent drift.

### Idempotency

Re-running the lever on an already-ported tree produces no changes. That is a
property, not a coincidence: `HAND_OWNED_SEED_ONLY` is true, so hand work is
never clobbered, and every rule is a literal-to-literal substitution that cannot
match its own output.

The last run reported `hand-owned: 0 seeded, 24 left untouched`, which is the
idempotency check passing in practice.

## The rule catalog

54 rules, numbered R01 to R55. R33 was deleted rather than repurposed, so the
numbering has one intentional gap; `check_tables()` fails on a duplicate id.

Grouped by what they fix:

**Paths and locations (R03 to R08, R22, R24, R25, R43).** Cursor's skill, rule,
transcript, and cache directories become Qoder's. The transcript and cache
entries were measured on macOS rather than guessed, because a wrong path in an
instruction fails silently and far from its cause.

**Tool and API naming (R01, R02, R09 to R21).** `generalPurpose` becomes
`general-purpose`, the `Task` tool becomes `Agent`, Cursor's structured question
tool becomes `AskUserQuestion`, `TodoWrite` stays, and Qoder's own `create-skill`
replaces the upstream one. Several rules exist twice, once for a backticked form
and once for bare prose, because both appear upstream.

**Model routing (R23, R26 to R32).** Cursor model slugs are opaque in Qoder, so
they become aliases. Per-call effort instructions become statements about the
seat's frontmatter, since Qoder fixes effort per agent. Implementation work routes
to the implementation seat and purely mechanical work to the mechanic seat.

**Missing capabilities (R34 to R49).** Cloud agents, per-call background
execution, the `/loop` wake mechanism, and the two `cursor-team-kit` skills have
no equivalent. These rules do not delete the sentences. They replace each with
the fallback plus a statement of what is lost, so the reader learns the gap at
the point where they would have hit it.

**Judge independence (R50 to R53).** Four places upstream depend on the reviewer
coming from a different model vendor. Each now routes to the `pstack-judge` seat
and replaces the guarantee with a report the caller can check.

**Retitled page cross-references (R54, R55).** `docs/guide/07-overnight.md` keeps
its filename so every existing link resolves, but its title and premise changed.
The link texts that promised an unattended run had to change with it.

## Hand-owned files

24 files are listed in `HAND_REWRITES`. The governing principle is in the
comment above that list:

> A file belongs here only when no substitution can make it correct. Anything the
> rules above can fix stays out of this list, so the port remains reproducible
> from upstream instead of resting on prose nobody re-checks.

Hand-owning a file removes it from the reproducible path, so each one is a debt.
The list is short for a 58-skill plugin because most Cursor coupling turned out
to be lexical.

The 24 break down as:

- **Routing model (3).** `skills/poteto-mode/SKILL.md`,
  `skills/setup-pstack/SKILL.md`, `skills/poteto-help/SKILL.md`. These describe
  the seat system itself, which does not exist upstream in this form.
- **Seat-naming workflows (5).** `arena`, `swarm`, `interrogate`, `how`,
  `architect`. Each dispatches named seats.
- **Capability loss (3).** `no-comments` (the reviewer is read-only here),
  `make-bot-ui` and `automate-me` (both built on capabilities Qoder lacks).
- **Playbooks (5).** `autonomous-run`, `autopilot-full`, `babysit`, `bug-fix`,
  `shipping`. Each leaned on cloud agents, the wake loop, or Bugbot.
- **Guide pages (6).** `01-setup`, `02-poteto-mode`, `05-build-and-clean`,
  `07-overnight`, `09-make-it-yours`, `10-recipes-and-pitfalls`.
- **Renamed reference and one script (2).** `bot-triage.md` (from
  `bugbot-triage.md`, via `RENAMES`) and `worktree-audit.sh`.

Everything else, including all 24 `principle-*` leaves and all 58 upstream skill
folders, came through mechanically.

## The gate

`FORBIDDEN_PATTERNS` is a list of 24 patterns that must not appear in the shipped
tree: the Cursor brand, its built-in subagent name, its per-call flags, its model
slugs, `/loop`, the `cursor-team-kit` skill names, Bugbot, its skill frontmatter
keys, Custom Mode, its keybinding, its `inherit-parent` alias, its `Task` tool,
and the em dash and the en dash.

The gate runs over every `.md`, `.sh`, and `.py` file except `GATE_SKIPS` (the
five port-authored documents that exist to describe upstream) and
`GATE_SKIP_PREFIXES` (`scripts/` and `.qoder-plugin/`). Python joined the list
with the approval gates, because the gate engine is Python and a file that
enforces these rules should pass them. Outside the `scripts/` prefix that reaches
one file, `hooks/scripts/enterprise_hooks.py`, which is clean. TypeScript stays
excluded, for the reasons recorded against `GATE_SUFFIXES`.

**Hand-owned files are gated too.** A hand rewrite is not finished until its file
passes, which makes a clean gate run the acceptance test for the whole port
rather than for the mechanical half of it.

### The allowance

One legitimate exception exists: citing where the port came from. `GATE_ALLOW`
lists the upstream GitHub URL, and `strip_allowed()` blanks those spans before the
patterns run.

It pads with spaces instead of deleting, so every later offset, and therefore
every reported line number, still points at the original text. A gate that
reports the wrong line is a gate people stop trusting.

### The port has to pass the rules it ships

The last two patterns are style rather than vendor coupling. This plugin ships
**unslop**, whose rule 13 allows no em dash, no en dash, and no parenthesis
standing in for one, and whose rule 14 keeps a colon out of mid-sentence.
Upstream ships em dashes in four files, so a port that failed its own rule would
have invited a reader to discount the rest of it.

Two of those four files, `skills/setup-pstack/SKILL.md` and
`skills/poteto-mode/references/bot-triage.md`, are hand-owned, and the lever never
writes them. Upstream calls the second one `bugbot-triage.md`, and `RENAMES`
retitles it on the way in. Both were fixed by hand, along with three more in
`agents/pstack-verifier.md`, which this port authored rather than copied.

The other two are copied verbatim and hold 16 em dashes between them.
`DASH_FIXES` covers all 16 in 14 entries, because two of the entries span a
matched pair around one clause. The right substitute depends on the sentence, so
there is no blanket pattern. Each entry is a literal span with the leading space
included, so the replacement can start on its own punctuation.

Every find string contains a dash, which means an entry can only match a place
the gate would reject anyway. When upstream rewords one of those sentences the
find string stops matching, the dash comes back, and the gate fails on it. The
`dash-fix: 14` in `port-report.json` is the evidence the fix still applies. A zero
there would mean a stale entry, not a clean upstream.

## Two mistranslations the gate could not catch

Worth recording, because both were found by reading rather than by running
anything, and both would have shipped.

### `/deslop` is not `/unslop`

Upstream calls `/deslop` from `cursor-team-kit` before commit. The obvious
mapping is this plugin's `/unslop`, and an earlier revision of the lever made it.

That was wrong. `/deslop` stripped dead guards, unsupported branches,
compatibility shims, and unrelated edits from **code**. `/unslop` cuts AI tells
from **writing**. Pointing it at a diff leaves the dead guards in the code while
reporting the strip as done, which is worse than not running it.

Both tokens are legal strings, so no lexical gate can see this. The fix was to
delete the dead rule, rewrite the surviving one to emit upstream's own plain-words
fallback, and hand-fix four files. `docs/guide/05-build-and-clean.md` now warns
against the substitution explicitly.

### Vendor independence is not a seat

Upstream requires the cross-judge to come from a different model vendor than the
author, because a model grades its own output generously. Four files stated that
property as something the workflow delivers.

Qoder cannot deliver it. Aliases publish no vendor, and there is no per-call model
parameter, so independence can be neither arranged nor checked at dispatch time.
Substituting the judge seat silently would have left the port claiming a guarantee
it does not have.

The fix routes the step to `pstack-judge`, has the seat report the model it ran
on, and tells the caller to say plainly when the independence check did not hold.

### The lesson

A lexical gate proves the port has no leftover vendor tokens. It cannot prove the
port is *true*. Every rule target in this lever was read in context for that
reason, and the two errors above were both caught that way.

## Port-authored files

Not copied and not adapted. These six exist only in the Qoder port, which is why
the gate skips the five that describe upstream:

| File | Purpose |
|---|---|
| `README.md` | Install, usage, provenance, validation evidence |
| `COMPATIBILITY.md` | The feature matrix |
| `PORTING-NOTES.md` | This file |
| `CONNECTORS.md` | External requirements, and the longer list of things not used |
| `docs/MODEL-ROUTING.md` | Per-seat model configuration |
| `docs/ENTERPRISE-ARCHITECTURE.md` | The six-layer diagram the enterprise extension was built from, recorded layer by layer |

`docs/ENTERPRISE-ARCHITECTURE.md` is not in `GATE_SKIPS`, because it names no
vendor. It is gated like any other shipped prose and passes.

Plus the Qoder-side implementation, which has no upstream counterpart at all:
`.qoder-plugin/plugin.json`, the 28 files under `agents/`, the three rules under
`rules/`, and the tooling under `scripts/`.

The approval gates added a second group: `hooks/enterprise-gates.json` with the
three entry points below it, `rules/enterprise-gates.md`, and the two skills
`/prd-rules` and `/setup-enterprise`. The enterprise extension added a third:
`rules/enterprise-seats.md`, and twelve playbooks under
`skills/poteto-mode/playbooks/`.

Those twelve and the two skills are the only port-authored files that sit under a
copy root, so they are the only ones a future upstream release could overwrite.
`PORT_AUTHORED` lists all 14, and `is_hand_owned()` treats a listed path as
protected, which means an upstream file of the same name gets skipped rather than
copied over the port's version. Everything else the enterprise work added lives
under `agents/`, `rules/`, `docs/`, or `scripts/`, none of which is a copy root,
so the lever cannot reach it and needs no entry. That is why 18 new agent files
cost zero registrations.

Upstream's `agents/` held two files, `poteto-agent.md` and `comment-sicko.md`.
Both were ported and rewritten for the seat model. The other twenty-six are new:
eight exist because Qoder binds a model to an agent instead of to a call, and
eighteen are the enterprise roster, which exists because a seat is the only thing
this port can dispatch.

## When upstream updates

```bash
python3 scripts/port-from-upstream.py /path/to/new/upstream
git diff                # review what moved
python3 scripts/selftest.py
```

Then, in order:

1. Read the diff in the 65 mechanically adapted files. A new upstream sentence
   that a rule does not match will survive verbatim, and the gate catches only
   the constructs it knows about.
2. Check whether any rule stopped firing. `port-report.json` lists hit counts, so
   a rule that dropped to zero either found its target gone or found its target
   reworded. Both need a look.
3. Re-read the 24 hand-owned files against their new upstream versions. The lever
   will not tell you they drifted, because it never writes them.
4. Re-check the two mistranslation classes above anywhere upstream touches model
   independence or code cleanup.
5. Read the `port-authored files` block the lever prints. It lists 14 entries and
   marks each `present` or `MISSING`, and it is the only thing that would notice
   one had gone, since upstream never shipped any of them.
6. If upstream added or retitled a playbook, hand-merge it into the title list in
   `skills/poteto-mode/SKILL.md`. That file is hand-owned, so the lever copies the
   new playbook in but never touches the list that routes to it. `selftest.py`
   fails the run when the list and the folder disagree, which is the point: the
   drift surfaces as a failure rather than as a playbook nothing can reach.
7. If upstream shipped a file whose path is one of the 14, the port's version won
   and upstream's was skipped. Read the skipped path in the lever output and
   decide whether the port still wants its own.

Bump `version` in `.qoder-plugin/plugin.json` to match the upstream cut. It
currently tracks 0.15.43.

## Known open items

Recorded rather than hidden:

- **No runtime proof.** `qodercli` was not installed on the machine that built
  this port, so no install smoke test and no live dispatch was run. The static
  half passes. `scripts/selftest.sh --install` is the missing evidence, and
  `README.md` says so. All 28 seats are in the same position, including the 18
  enterprise ones.
- **Alias-to-model mapping is account-specific.** The defaults assume the five
  documented aliases resolve to something sensible on the installing account.
  Nothing in the port can verify that.
- **Agent colors collide by arithmetic.** Eight documented colors, 28 agents, so
  six of the eight are shared. Cosmetic, reported as one aggregate warning rather
  than a failure, and deliberate within the enterprise roster where color reads
  as family.
- **Four views of the source diagram were never supplied.** The enterprise
  extension is built from section A of a six-tab architecture artifact. B, a
  decision flowchart, C, an order-cancellation sequence, D, a responsibility
  matrix, and the design checks all exist in that artifact and were not provided.
  A's prose states the delegation and concurrency rules B would have drawn, so the
  port encodes those from prose rather than guessing at a picture. The gaps are
  tabulated in `docs/ENTERPRISE-ARCHITECTURE.md` and in `COMPATIBILITY.md`, and
  the six composition chains are the part most exposed to C if it ever surfaces.
- **`setup-pstack` suggests `/model`** to list available models. That command is
  documented as Qoder's model wizard, but the exact output it produces was not
  observed during this port.
- **The approval gates have never fired.** `scripts/test-gates.py` proves the
  decision logic with 32 assertions that drive the real entry points over
  recorded hook events, and it needs nothing but Python 3. Nothing has observed
  Qoder invoke them, for the same reason as the first item here. Step 6 of
  `/setup-enterprise` is the check that settles it.
- **Whether `PreToolUse` fires inside a subagent is unresolved.** The hooks
  documentation defines the event and the seat boundary but never says whether
  the event reaches a seat's own session, and the seats do the pushing. The
  `SubagentStop` backstop covers the case where `PostToolUse` fires and
  `PreToolUse` does not. If neither fires inside a seat, no audit record is
  written and the backstop finds nothing. `COMPATIBILITY.md` records how to
  settle it with one delegated dry-run push.
