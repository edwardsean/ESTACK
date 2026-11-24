#!/usr/bin/env python3
"""Rebuild the Qoder port of pstack from the upstream Cursor source.

This script is the lever. It copies upstream pstack into this plugin, applies
the mechanical Cursor-to-Qoder substitutions, and then fails loudly if any
Cursor-only construct survives in a place this script claims to have handled.

Files listed in HAND_REWRITES are hand-owned. Their Cursor coupling is
semantic, not lexical, so no substitution can fix them. This script never
writes them. It gates them and reports them, which keeps the lever idempotent
and keeps re-running it from destroying a hand-written version.

Usage:
    python3 scripts/port-from-upstream.py [UPSTREAM_ROOT]

UPSTREAM_ROOT defaults to ../upstream/pstack relative to the repo that
contains this plugin. The upstream tree is only ever read, never written.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# What to copy
# ---------------------------------------------------------------------------

COPY_ROOTS = [
    "skills",
    "assets",
    "docs/guide",
    "LICENSE",
]

# Never carried into the Qoder package. Each entry is documented in
# COMPATIBILITY.md with the reason.
EXCLUDES = [
    # Cursor Automations runtime. No Qoder equivalent.
    "automations",
    # Upstream manifests. Qoder uses .qoder-plugin/plugin.json.
    ".cursor-plugin",
    "plugin.json",
    ".gitignore",
    # Upstream README describes Cursor installation. Replaced by a Qoder one.
    "README.md",
    # Claude Code harness adapter. Not relevant to Qoder.
    "docs/harness",
    # 3.7 MB of TLA+ test fixtures. Only useful when developing statechart.
    "skills/statechart/scripts/test",
]

# Files the hand-written Qoder port owns outright. The lever copies upstream
# into them only when the destination does not exist yet, so a first run seeds
# a reviewable diff and later runs leave the hand-written version alone.
HAND_OWNED_SEED_ONLY = True

# Destination renames. The upstream file name carries a Cursor product name
# that has no Qoder counterpart, and the gate rejects it.
RENAMES = {
    "skills/poteto-mode/references/bugbot-triage.md":
        "skills/poteto-mode/references/bot-triage.md",
}

# Files whose Cursor coupling is semantic, not lexical. The lever seeds them
# verbatim on first run so a reviewer can diff against upstream, then never
# touches them again. A hand-written Qoder version owns each one.
#
# A file belongs here only when no substitution can make it correct. Anything
# the rules above can fix stays out of this list, so the port remains
# reproducible from upstream instead of resting on prose nobody re-checks.
HAND_REWRITES = [
    # Orchestrator and setup. Both describe the routing model itself.
    "skills/poteto-mode/SKILL.md",
    "skills/setup-pstack/SKILL.md",
    # Fan-out workflows. They name seats directly.
    "skills/arena/SKILL.md",
    "skills/swarm/SKILL.md",
    "skills/interrogate/SKILL.md",
    "skills/how/SKILL.md",
    # Upstream sketches in the chat that receives /architect and names no
    # subagent, because it picks a model per call. This port has to route the
    # sketch to a seat or the architecture model is unreachable from the skill,
    # so a section was added rather than substituted.
    "skills/architect/SKILL.md",
    # comment-sicko is read-only in this port, so the caller owns the edits.
    "skills/no-comments/SKILL.md",
    # The skill index maps upstream features, several of which do not exist here.
    "skills/poteto-help/SKILL.md",
    # Builds a webhook UI on a runtime Qoder does not have.
    "skills/make-bot-ui/SKILL.md",
    # Authors mode skills against a frontmatter field Qoder ignores.
    "skills/automate-me/SKILL.md",
    # Bugbot triage, generalized to any bot reviewer.
    "skills/poteto-mode/references/bot-triage.md",
    # Resolves the transcript dir. Qoder's project slug carries a hash that
    # cannot be derived from the repo path, so the lookup had to change shape.
    "skills/poteto-mode/scripts/worktree-audit.sh",
    # Playbooks that arm a wake loop or drive cloud owners.
    "skills/poteto-mode/playbooks/autonomous-run.md",
    "skills/poteto-mode/playbooks/autopilot-full.md",
    "skills/poteto-mode/playbooks/babysit.md",
    "skills/poteto-mode/playbooks/bug-fix.md",
    "skills/poteto-mode/playbooks/shipping.md",
    # The user-facing guide describes installing into a different IDE.
    "docs/guide/01-setup.md",
    "docs/guide/02-poteto-mode.md",
    "docs/guide/05-build-and-clean.md",
    "docs/guide/07-overnight.md",
    "docs/guide/09-make-it-yours.md",
    "docs/guide/10-recipes-and-pitfalls.md",
]

# Files this port wrote that upstream does not ship, and that live under a
# COPY_ROOT the lever sweeps. Listed so a future upstream release that adds a
# skill of the same name seeds alongside the port's version instead of
# silently overwriting it.
#
# The rest of the port's own work needs no entry here. `hooks/`, `rules/`, and
# `scripts/` are not copy roots, so the lever cannot reach them and cannot
# overwrite them. Listing them would imply a protection they do not need.
PORT_AUTHORED = [
    # The enterprise approval gates: PRD to confirmed business rules, and the
    # per-repo opt-in that writes the gate policy.
    "skills/prd-rules/SKILL.md",
    "skills/setup-enterprise/SKILL.md",
    # The twelve enterprise playbooks. `skills/` is a copy root, so without an
    # entry here the lever treats each as an upstream file it failed to find.
    # The 18 ent- agents need no entry because `agents/` is not a copy root.
    "skills/poteto-mode/playbooks/requirements-analysis.md",
    "skills/poteto-mode/playbooks/prd-creation.md",
    "skills/poteto-mode/playbooks/architecture-design.md",
    "skills/poteto-mode/playbooks/architecture-review.md",
    "skills/poteto-mode/playbooks/database-migration.md",
    "skills/poteto-mode/playbooks/api-contract-design.md",
    "skills/poteto-mode/playbooks/security-assessment.md",
    "skills/poteto-mode/playbooks/enterprise-feature-development.md",
    "skills/poteto-mode/playbooks/enterprise-bug-fix.md",
    "skills/poteto-mode/playbooks/integration-testing.md",
    "skills/poteto-mode/playbooks/enterprise-release-management.md",
    "skills/poteto-mode/playbooks/production-incident-management.md",
]

# ---------------------------------------------------------------------------
# Mechanical substitutions
# ---------------------------------------------------------------------------
# Ordered. Each entry is (rule id, pattern, replacement, note). Longer and more
# specific patterns come first so they win over the generic ones.

RULES: list[tuple[str, str, str, str]] = [
    (
        "R01",
        r"subagent_type:\s*\"?generalPurpose\"?",
        "subagent_type: general-purpose",
        "Qoder's built-in general research subagent is named general-purpose.",
    ),
    (
        "R02",
        r"\bgeneralPurpose\b",
        "general-purpose",
        "Bare mentions of the built-in subagent name.",
    ),
    (
        "R03",
        r"`~/\.cursor/rules/pstack-models\.mdc`",
        "`.qoder/rules/pstack-models.md`",
        "Qoder rules live in .qoder/rules and are plain Markdown.",
    ),
    (
        "R04",
        r"~/\.cursor/rules/pstack-models\.mdc",
        ".qoder/rules/pstack-models.md",
        "Unquoted form of the model-routing rule path.",
    ),
    (
        "R05",
        r"~/\.cursor/plugins/",
        "~/.qoder/plugins/",
        "Qoder plugin cache path.",
    ),
    (
        "R06",
        r"~/\.cursor/skills/",
        "~/.qoder/skills/",
        "Qoder user-level skill path.",
    ),
    (
        "R07",
        r"(?<![/~])\.cursor/skills/",
        ".qoder/skills/",
        "Qoder project-level skill path.",
    ),
    (
        "R08",
        r"\.cursor/automations/",
        ".qoder/automations/",
        "Path shape only. Qoder has no automations runtime; see COMPATIBILITY.md.",
    ),
    (
        "R09",
        r"\bAskQuestion\b",
        "AskUserQuestion",
        "Qoder's structured question tool.",
    ),
    (
        "R10",
        r"the `Task` tool",
        "the `Agent` tool",
        "Qoder dispatches subagents through the Agent tool.",
    ),
    (
        "R11",
        r"\bTask tool\b",
        "Agent tool",
        "Unquoted form.",
    ),
    (
        "R12",
        r"`Task` subagent",
        "`Agent` subagent",
        "Qoder naming.",
    ),
    (
        "R13",
        r"\bTask subagent\b",
        "Agent subagent",
        "Unquoted form.",
    ),
    (
        "R14",
        r"Spawn `Task` with",
        "Spawn the `Agent` tool with",
        "Qoder naming.",
    ),
    (
        "R15",
        r"every `Task` call",
        "every `Agent` call",
        "Qoder naming.",
    ),
    (
        "R16",
        r"a `Task` subagent",
        "an `Agent` subagent",
        "Qoder naming.",
    ),
    (
        "R17",
        r"one Task subagent",
        "one Agent subagent",
        "Qoder naming.",
    ),
    (
        "R18",
        r"the \*\*create-skill\*\* skill \(Cursor's built-in for authoring SKILL\.md files\)",
        "Qoder's built-in `/create-skill` skill",
        "Qoder ships its own create-skill.",
    ),
    (
        "R19",
        r"\btodolist tool\b",
        "TodoWrite tool",
        "Qoder's todo tool.",
    ),
    (
        "R20",
        r"\ba todolist\b",
        "a todo list",
        "Qoder spelling.",
    ),
    (
        "R21",
        r"\btodolists\b",
        "todo lists",
        "Qoder spelling.",
    ),
    # Transcript location. Qoder stores chat history in a different place under
    # a different name, and its project slug carries a hash that cannot be
    # derived from the workspace path. Five upstream files depend on this, so
    # the whole idiom is mechanical rather than five hand edits.
    (
        "R22",
        r"`~/\.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>\.jsonl`",
        "`~/.qoder/cache/projects/<slug>/conversation-history/<id>/<id>.jsonl`",
        "Qoder transcript path.",
    ),
    (
        "R23",
        r"where `<slug>` is the workspace path with the leading slash dropped "
        r"and each \"/\" turned into \"-\" \(so `/Users/you/proj` becomes "
        r"`Users-you-proj`\)",
        "where `<slug>` is the workspace folder name plus a short hash, like "
        "`MyApp-1a2b3c4d`. The hash is not derivable from the path, so list "
        "`~/.qoder/cache/projects/` and match the folder name instead of "
        "building the slug",
        "Qoder slugs are opaque.",
    ),
    (
        "R24",
        r"`agent-transcripts/`",
        "`conversation-history/`",
        "Qoder transcript directory name.",
    ),
    (
        "R25",
        r"`~/\.cursor/projects/\*/`",
        "`~/.qoder/cache/projects/*/`",
        "Qoder project cache root.",
    ),
    (
        "R26",
        r"\(the system prompt names (?:the|this) path\)",
        "(listed under `~/.qoder/cache/projects/`)",
        "Qoder does not guarantee the system prompt names this path.",
    ),
    (
        "R27",
        r"The system prompt names the workspace's `conversation-history/` "
        r"directory\. Use only that path\.",
        "Find this workspace's directory under `~/.qoder/cache/projects/` and "
        "use only the `conversation-history/` folder inside it.",
        "Same reason as R26, phrased as an instruction.",
    ),
    # Model routing. Upstream names a model slug per playbook step. Qoder binds
    # the model to the agent, so the slug becomes a seat.
    (
        "R28",
        r"your configured [\w-]+ model \(default `claude-opus-5-5-xhigh-fast`\)",
        "the `poteto-agent` seat",
        "Implementation work goes to the implementation seat.",
    ),
    (
        "R29",
        r"runs on `claude-opus-5-5-medium-fast`",
        "runs on the `pstack-mechanic` seat",
        "Dispatch-only and result-packing work is mechanical.",
    ),
    # Effort is fixed per seat in Qoder, so "pick a reasoning level" is no
    # longer a thing a dispatcher can do.
    (
        "R30",
        r"Pick each subagent's reasoning level for the job, per the Subagents "
        r"section of the \*\*poteto-mode\*\* skill\.",
        "Name the seat rather than a reasoning level, since each seat carries "
        "its own effort. See the Subagents section of the **poteto-mode** skill.",
        "Qoder fixes effort in agent frontmatter.",
    ),
    (
        "R31",
        r"Pick each subagent's reasoning level per the Subagents section of "
        r"the \*\*poteto-mode\*\* skill\.",
        "Name the seat rather than a reasoning level, since each seat carries "
        "its own effort. See the Subagents section of the **poteto-mode** skill.",
        "Unquoted variant of R30.",
    ),
    (
        "R32",
        r"Pick each subagent's reasoning level for the job, per the Subagents "
        r"section\.",
        "Name the seat rather than a reasoning level, since each seat carries "
        "its own effort.",
        "Short variant of R30.",
    ),
    # cursor-team-kit is a separate vendor plugin that is not ported. Its
    # control-skill job maps onto the project's own harness, in the rules below.
    # Its code-slop job maps onto nothing, so this rule spells the outcome out
    # in plain words, which is the fallback upstream's own guide gives. The
    # **unslop** skill is not a stand-in for it. Unslop edits prose, so pointing
    # it at a diff would leave the dead guards and compatibility shims in the
    # code while reporting the strip as done.
    (
        "R34",
        r"Run `/deslop` from `cursor-team-kit` over the diff before commit\.",
        "Strip the slop from the diff before commit, meaning narrating "
        "comments, unsupported guards, dead compatibility paths, and unrelated "
        "edits.",
        "No ported equivalent for code slop.",
    ),
    (
        "R35",
        r"the matching control skill \(such as `control-ui` or `control-cli` "
        r"from `cursor-team-kit`\)",
        "the project's own driver for that surface",
        "No ported equivalent. The project has to supply the driver.",
    ),
    (
        "R36",
        r"its control skill \(such as `control-ui` or `control-cli` from "
        r"`cursor-team-kit`\)",
        "the project's own driver for that surface",
        "Same, possessive form.",
    ),
    (
        "R37",
        r"via the control skill",
        "through the project's own driver for that surface",
        "Same, short form.",
    ),
    # Cloud agents. Qoder runs every subagent locally, so isolation comes from
    # a worktree rather than from a separate machine.
    (
        "R38",
        r"Each owner is a Cursor cloud agent",
        "Each owner is a `poteto-agent` seat in its own git worktree",
        "No cloud agents in Qoder.",
    ),
    (
        "R39",
        r"each a Cursor cloud agent",
        "each a `pstack-verifier` seat in its own git worktree",
        "No cloud agents in Qoder.",
    ),
    (
        "R40",
        r", or run them as cloud agents, which each get their own machine\.",
        ". Seats that carry `isolation: worktree` get their own checkout, and "
        "Qoder runs every one of them on this machine.",
        "No cloud agents in Qoder.",
    ),
    (
        "R41",
        r", as cloud agents",
        ", each in its own worktree",
        "No cloud agents in Qoder.",
    ),
    (
        "R42",
        r"a cloud-agent URL, or a pushed branch",
        "or a pushed branch",
        "No cloud agents, so no cloud transcript URL.",
    ),
    # Disk cleanup targets. Qoder is a VS Code fork, so state.vscdb.backup is
    # real, but it has no snapshots/roots tree. SharedClientCache is the actual
    # space hog. Measured, not assumed.
    (
        "R43",
        r"`~/Library/Application Support/Cursor` \(`state\.vscdb\.backup`, and "
        r"`snapshots/roots/<root>` where a `<root>` named for a folder you "
        r"opened as a workspace balloons\)",
        "`~/Library/Application Support/Qoder` (`SharedClientCache` grows "
        "largest, then `CachedData`, `CachedExtensionVSIXs`, `Cache`, and "
        "`logs`, plus `User/globalStorage/state.vscdb.backup`) and "
        "`~/.qoder/logs`",
        "Qoder's real cache layout, measured on macOS.",
    ),
    (
        "R44",
        r"`~/Library/Application Support/Cursor`",
        "`~/Library/Application Support/Qoder`",
        "Fallback for any other mention.",
    ),
    (
        "R45",
        r"a hand-typed `myrepo-worktrees/x` misses one that lives at "
        r"`\.cursor/worktrees/myrepo/x`",
        "a hand-typed `myrepo-worktrees/x` misses one the IDE created under "
        "its own worktree root",
        "Qoder's worktree root is not a documented fixed path.",
    ),
    (
        "R46",
        r"The transcript scan is slow, so background it\.",
        "The transcript scan is slow, so let it finish before you read the "
        "table. Qoder has no per-call background flag for a shell command "
        "inside a subagent.",
        "No per-call background execution.",
    ),
    (
        "R47",
        r"`/loop` per component until the diff is zero\.",
        "Repeat per component until the diff is zero, driving each pass "
        "yourself, since Qoder has no timer that re-enters a run.",
        "No scheduled re-entry. Qoder does have asyncRewake, where a background "
        "hook exiting 2 wakes the model, but a lifecycle event still has to "
        "launch it, so it cannot restart a run the way /loop did.",
    ),
    # Prompt recipes a user would paste. A command Qoder does not have would
    # fail silently as ordinary prose, so the intent has to survive without it.
    (
        "R48",
        r"give `/loop` that predicate",
        "give the agent that predicate",
        "No scheduled re-entry, but the done predicate still drives the run.",
    ),
    (
        "R49",
        r"/loop until done\.",
        "keep going until done.",
        "Same, inside a pasted prompt.",
    ),
    # Upstream makes several steps depend on the reviewer coming from a
    # different model vendor than the author. Qoder binds a model to an agent
    # and publishes no vendor behind an alias, so nothing here can promise
    # that. Each rule below routes the step to the judge seat and replaces the
    # guarantee with a report the caller can check, because a silent
    # substitution would leave the port claiming an independence it lacks.
    (
        "R50",
        r"spawn a subagent on another vendor's model than the one that did "
        r"the work\.",
        "spawn the `pstack-judge` seat, and ask it to report the model it ran "
        "on. Qoder publishes no vendor behind a model alias, so independence "
        "is something you check from that report rather than something you can "
        "guarantee. When the judge's model matches the one that did the work, "
        "say the independence check did not hold instead of implying a second "
        "opinion.",
        "Judge independence is unverifiable at dispatch.",
    ),
    (
        "R51",
        r"on a different model family per the \*\*arena\*\* skill's Phase C",
        "on the `pstack-judge` seat per the **arena** skill's Phase C",
        "Same, in the eval playbook.",
    ),
    (
        "R52",
        r"A read-only judge from a different model vendor scores every "
        r"candidate against a rubric\. When no model from another vendor can "
        r"run, the coordinator skips the judge and picks the base itself\.",
        "The `pstack-judge` seat scores every candidate against a rubric "
        "without seeing which seat produced which. Qoder publishes no vendor "
        "behind a model alias, so a judge from a genuinely different model "
        "family is a hope rather than a guarantee, and the judge reports the "
        "model it ran on so you can check it. When that model matches the "
        "candidates', the coordinator says so and picks the base itself.",
        "Same, in the design guide page.",
    ),
    (
        "R53",
        r"on different models per the \*\*arena\*\* skill's Phase B",
        "on the three panel seats per the **arena** skill's Phase B",
        "Candidates are seats, not per-call model choices.",
    ),
    # The overnight page keeps its filename so every existing link resolves,
    # but its title and premise changed, so the link texts that promised an
    # unattended run have to change with it.
    (
        "R54",
        r"\[Run work while you sleep\]\(\./07-overnight\.md\)",
        "[Run long work you review later](./07-overnight.md)",
        "Page retitled, filename kept so links resolve.",
    ),
    (
        "R55",
        r"Trust before loops, an overnight contract, a decision log you can "
        r"audit, and Projects and automations that scale past one agent\.",
        "Trust before a long run, a handoff contract with a ceiling, a "
        "decision log you can audit, and what the port cannot do without a "
        "scheduler or a second machine.",
        "Guide index summary of the same page.",
    ),
]

# Applied to every SKILL.md frontmatter.
FRONTMATTER_DROPS = [
    # Qoder skill frontmatter documents only name and description. Unknown
    # fields are ignored, so carrying them would imply support that is absent.
    "disable-model-invocation",
    "icon",
    "color",
    "paths",
]

# This plugin ships the **unslop** skill, whose rule 13 allows no em dash, no en
# dash, and no parenthesis standing in for one, and whose rule 14 keeps a colon
# out of mid-sentence. Upstream breaks rule 13 in two files that this lever
# copies verbatim, and a plugin that violates its own style rule invites a reader
# to discount the rest of it.
#
# The right substitute depends on the sentence, so there is no blanket pattern
# here. Each entry is a literal span around one dash, with the leading space
# included so the replacement can start on its own punctuation. Every find
# string contains a dash, which is what keeps these from matching anywhere the
# gate would not already have looked.
DASH_FIXES: list[tuple[str, str]] = [
    # skills/create-verification-skill/SKILL.md
    (" — any language", ", in any language"),
    (" — Playwright/Cypress", ", meaning Playwright/Cypress"),
    (" — without frontmatter", ", because without frontmatter"),
    (" — process up, right version", ", covering process up, right version"),
    (" — a cleanup that eats", ", because a cleanup that eats"),
    # skills/maintain-verification-skill/SKILL.md
    (" — every feature got", ". Every feature got"),
    (" — one PR ships", ". One PR ships"),
    (" — coverage could not", ". Coverage could not"),
    (" — require a concrete", ", and require a concrete"),
    (" — one long-lived", ", meaning one long-lived"),
    (" — doctor before", ". Doctor before"),
    (" — failed-iteration residue", ", so failed-iteration residue"),
    (
        " — restart whatever the fix invalidated, nothing more — before calling",
        ", restarting whatever the fix invalidated and nothing more, before "
        "calling",
    ),
    (
        " — including those re-proofs — so nothing outlives",
        ", including those re-proofs, so nothing outlives",
    ),
]

# ---------------------------------------------------------------------------
# Gate: constructs that must not survive anywhere in the shipped tree
# ---------------------------------------------------------------------------

FORBIDDEN_PATTERNS = [
    (r"\bCursor\b", "Cursor brand reference"),
    (r"\bcursor\b", "cursor path or brand reference"),
    (r"generalPurpose", "Cursor built-in subagent name"),
    (r"run_in_background", "Cursor per-call background flag"),
    (r'environment:\s*"cloud"', "Cursor cloud agent environment"),
    (r"cloud_base_branch", "Cursor cloud agent base branch"),
    (r"readonly:\s*true", "Cursor per-call readonly flag"),
    (r"claude-opus-5-5", "Cursor model slug"),
    (r"claude-fable-5-2", "Cursor model slug"),
    (r"gemini-4-carbon", "Cursor model slug"),
    (r"grok-\*", "Cursor model slug"),
    (r"/loop\b", "Cursor built-in loop command"),
    (r"\bdeslop\b", "cursor-team-kit skill"),
    (r"control-ui", "cursor-team-kit skill"),
    (r"control-cli", "cursor-team-kit skill"),
    (r"cursor-team-kit", "Cursor plugin"),
    (r"[Bb]ugbot", "Cursor Bugbot"),
    (r"disable-model-invocation", "Cursor skill frontmatter"),
    (r"Custom Mode", "Cursor custom mode"),
    (r"[Oo]ption\+[Ee]nter", "Cursor keybinding"),
    (r"inherit-parent", "Cursor model alias"),
    (r"`Task`", "Cursor Task tool"),
    # Style, not vendor coupling, but enforced here for the same reason: the
    # plugin ships the rule, so the plugin has to pass it. Hand-owned files are
    # gated too, which is what keeps a hand rewrite from reintroducing one.
    (r"\u2014", "em dash, forbidden by the unslop rule 13 this plugin ships"),
    (r"\u2013", "en dash, forbidden by the unslop rule 13 this plugin ships"),
]

# Port-authored documents. They exist to describe the upstream system, so they
# name it. Everything else in the tree is a runtime instruction the model reads.
GATE_SKIPS = {
    "README.md",
    "COMPATIBILITY.md",
    "PORTING-NOTES.md",
    "CONNECTORS.md",
    "docs/MODEL-ROUTING.md",
}

GATE_SKIP_PREFIXES = ["scripts/", ".qoder-plugin/"]

# Markdown carries the instructions a model reads, and shell carries paths a
# script resolves. Both broke on the Cursor transcript layout, so both are
# gated. TypeScript is not: its `endCursor` hits are GraphQL pagination, and
# `watch-pr`'s bot detection is documented in COMPATIBILITY.md rather than
# silently generalized.
#
# Python is gated because the port's own gate engine is Python, and a file that
# enforces these rules should pass them. Outside the `scripts/` skip prefix that
# reaches exactly one file, which is clean, so the coverage costs nothing.
GATE_SUFFIXES = [".md", ".sh", ".py"]


def is_excluded(rel: str) -> bool:
    parts = rel.split("/")
    for exclude in EXCLUDES:
        exc_parts = exclude.split("/")
        if parts[: len(exc_parts)] == exc_parts:
            return True
    return False


def is_hand_owned(rel: str) -> bool:
    return rel in HAND_REWRITES or rel in PORT_AUTHORED or rel in RENAMES.values()


def adapt_file(src: Path, dst: Path, rel: str, hits: Counter) -> bool:
    """Copy one upstream file to the plugin, adapting text the lever owns.

    Returns True when the written content differs from the source.
    """
    if src.suffix != ".md":
        shutil.copy2(src, dst)
        return False
    text = src.read_text(encoding="utf-8")
    adapted_text = adapt_markdown(rel, text, hits)
    dst.write_text(adapted_text, encoding="utf-8")
    return adapted_text != text


def check_tables() -> list[str]:
    """Reject a malformed table before it can silently misroute a file.

    A duplicated HAND_REWRITES entry inflates the pending count. A rename whose
    target is not hand-owned would be adapted by rules that assume the old name.
    """
    problems: list[str] = []
    for name, table in (
        ("HAND_REWRITES", HAND_REWRITES),
        ("PORT_AUTHORED", PORT_AUTHORED),
    ):
        seen: set[str] = set()
        for entry in table:
            if entry in seen:
                problems.append(f"{name} has a duplicate entry: {entry}")
            seen.add(entry)
    # A file cannot both rewrite an upstream original and be something upstream
    # never shipped. An overlap means one of the two lists is wrong about it.
    for entry in PORT_AUTHORED:
        if entry in HAND_REWRITES:
            problems.append(f"PORT_AUTHORED entry is also hand-rewritten: {entry}")
    for src, dst in RENAMES.items():
        if dst not in HAND_REWRITES:
            problems.append(f"RENAMES target is not hand-owned: {dst}")
    ids = [rule[0] for rule in RULES]
    for rule_id in set(ids):
        if ids.count(rule_id) > 1:
            problems.append(f"RULES has a duplicate id: {rule_id}")
    return problems


def collect_sources(upstream: Path) -> list[Path]:
    files: list[Path] = []
    for root in COPY_ROOTS:
        target = upstream / root
        if target.is_file():
            files.append(target)
            continue
        if not target.is_dir():
            continue
        for path in sorted(target.rglob("*")):
            if path.is_file():
                files.append(path)
    return files


def split_frontmatter(text: str) -> tuple[list[str], str]:
    """Return (frontmatter lines without fences, body)."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", text, re.DOTALL)
    if not match:
        return [], text
    return match.group(1).splitlines(), text[match.end():]


def rebuild_frontmatter(lines: list[str]) -> str:
    # Only a column-0 line can be a key. An indented line is a block scalar
    # continuation, and treating it as a key would drop real description text.
    kept = [
        line for line in lines
        if line[:1] not in (" ", "\t")
        and line.split(":")[0].strip() not in FRONTMATTER_DROPS
    ]
    return "---\n" + "\n".join(kept) + "\n---\n"


BLOCK_SCALAR_RE = re.compile(r"^([>|])([+-]?)(\d*)\s*$")


def description_span(lines: list[str]) -> tuple[int, int, bool]:
    """Locate the description entry.

    Returns (start, end, is_block) where [start, end) covers the key line and,
    for a block scalar, every indented continuation line below it.
    """
    for index, line in enumerate(lines):
        if line[:1] in (" ", "\t"):
            continue
        key, _, value = line.partition(":")
        if key.strip() != "description":
            continue
        if not BLOCK_SCALAR_RE.match(value.strip()):
            return index, index + 1, False
        end = index + 1
        while end < len(lines) and lines[end][:1] in (" ", "\t"):
            end += 1
        return index, end, True
    return -1, -1, False


def indent_of(line: str) -> str:
    return line[: len(line) - len(line.lstrip())]


def add_manual_trigger_guard(name: str, description: str) -> str:
    """Re-encode Cursor's disable-model-invocation as description prose.

    Qoder has no frontmatter switch for manual-only skills. The description is
    the only signal the model gets, so the intent moves there.
    """
    guard = manual_trigger_guard(name)
    if guard in description:
        return description
    return f"{description} {guard}".strip()


def manual_trigger_guard(name: str) -> str:
    return (
        f"Runs only when the user types /{name}, or when the poteto-mode "
        "orchestrator routes to it."
    )


def adapt_markdown(rel: str, text: str, hits: Counter) -> str:
    lines, body = split_frontmatter(text)
    had_frontmatter = bool(lines)

    if had_frontmatter and rel.endswith("SKILL.md"):
        name = ""
        for line in lines:
            if line[:1] in (" ", "\t"):
                continue
            key, _, value = line.partition(":")
            if key.strip() == "name":
                name = value.strip()
        manual_only = any(
            line[:1] not in (" ", "\t")
            and line.split(":")[0].strip() == "disable-model-invocation"
            for line in lines
        )
        start, end, is_block = description_span(lines)
        if manual_only and name and start >= 0:
            hits["frontmatter:disable-model-invocation"] += 1
            guard = manual_trigger_guard(name)
            joined = "\n".join(lines[start:end])
            if guard not in joined:
                if is_block:
                    # Keep the block form upstream chose. A folded scalar joins
                    # the appended line with a space, so the guard reads as one
                    # more sentence of the same description.
                    indent = indent_of(lines[start + 1]) if end > start + 1 else "  "
                    lines = lines[:end] + [f"{indent}{guard}"] + lines[end:]
                else:
                    raw = lines[start].partition(":")[2].strip().strip('"').strip("'")
                    merged = add_manual_trigger_guard(name, raw)
                    lines[start] = f'description: "{merged}"'
                start, end, is_block = description_span(lines)

        # Drop keys Qoder does not document. Column-0 lines only, so a block
        # scalar continuation that happens to contain a colon survives.
        rebuilt = []
        for line in lines:
            key = line.split(":")[0].strip()
            if line[:1] not in (" ", "\t") and key in FRONTMATTER_DROPS:
                hits[f"frontmatter-drop:{key}"] += 1
                continue
            rebuilt.append(line)
        lines = rebuilt

        desc_start, desc_end, _ = description_span(lines)
        if desc_start >= 0:
            desc_text = "\n".join(lines[desc_start:desc_end])
            value = desc_text.partition(":")[2]
            if not BLOCK_SCALAR_RE.match(value.strip()):
                value = value.strip().strip('"').strip("'")
            else:
                value = " ".join(
                    part.strip() for part in lines[desc_start + 1:desc_end]
                )
            if len(value) > 1024:
                hits[f"warn:description-over-1024:{rel}"] += 1

    for rule_id, pattern, replacement, _note in RULES:
        body, count = re.subn(pattern, replacement, body)
        if count:
            hits[f"{rule_id}"] += count
        if had_frontmatter:
            joined = "\n".join(lines)
            joined, count = re.subn(pattern, replacement, joined)
            if count:
                hits[f"{rule_id}"] += count
            lines = joined.splitlines()

    if had_frontmatter:
        return strip_dashes(rebuild_frontmatter(lines) + body, hits)
    return strip_dashes(body, hits)


def strip_dashes(text: str, hits: Counter) -> str:
    """Apply the hand-chosen dash replacements, and count what fired.

    A find string that stops matching means upstream reworded the sentence, and
    the gate then fails on the surviving dash. That is the point: the count in
    the report is the evidence the fix still applies.
    """
    for find, replace in DASH_FIXES:
        count = text.count(find)
        if count:
            hits["dash-fix"] += count
            text = text.replace(find, replace)
    return text


# A citation of where this port came from is provenance rather than an
# instruction, so it may name the upstream vendor. Every other match is a
# construct a model reading the file would try to use.
GATE_ALLOW = [
    r"https://github\.com/cursor/plugins[^\s)`\"']*",
]


def strip_allowed(text: str) -> str:
    """Blank out allowed spans without moving anything.

    Padding with spaces instead of deleting keeps every later offset, and so
    every reported line number, pointing at the original text.
    """
    for pattern in GATE_ALLOW:
        text = re.sub(pattern, lambda match: " " * len(match.group(0)), text)
    return text


def gate(rel: str, text: str, failures: list[str]) -> None:
    """Reject Cursor-only constructs.

    Hand-owned files are gated too. A hand rewrite is not done until its file
    passes, so a clean gate run is the acceptance test for the whole port.
    """
    text = strip_allowed(text)
    for pattern, label in FORBIDDEN_PATTERNS:
        for match in re.finditer(pattern, text):
            line_no = text[: match.start()].count("\n") + 1
            failures.append(f"{rel}:{line_no}: {label} -> {match.group(0)!r}")


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        upstream = Path(argv[1]).expanduser().resolve()
    else:
        upstream = (PLUGIN_ROOT.parent / "upstream" / "pstack").resolve()

    if not upstream.is_dir():
        print(f"error: upstream source not found: {upstream}", file=sys.stderr)
        return 2

    table_problems = check_tables()
    if table_problems:
        print("error: port tables are malformed", file=sys.stderr)
        for problem in table_problems:
            print(f"  {problem}", file=sys.stderr)
        return 2

    print(f"upstream: {upstream}")
    print(f"plugin:   {PLUGIN_ROOT}")

    sources = collect_sources(upstream)
    hits: Counter = Counter()
    copied = 0
    adapted = 0
    skipped = 0
    seeded = 0
    protected = 0

    for src in sources:
        rel = src.relative_to(upstream).as_posix()
        if is_excluded(rel):
            skipped += 1
            continue
        dst_rel = RENAMES.get(rel, rel)
        dst = PLUGIN_ROOT / dst_rel
        if HAND_OWNED_SEED_ONLY and is_hand_owned(dst_rel) and dst.exists():
            protected += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if is_hand_owned(dst_rel):
            # Seed verbatim so the hand rewrite starts from a real diff.
            shutil.copy2(src, dst)
            seeded += 1
            continue
        if adapt_file(src, dst, rel, hits):
            adapted += 1
        copied += 1

    print(f"\ncopied {copied} files ({skipped} excluded), adapted {adapted} markdown files")
    print(f"hand-owned: {seeded} seeded, {protected} left untouched")

    print("\nsubstitution counts:")
    for key, count in sorted(hits.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {count:4d}  {key}")

    # Gate over the written tree, so an unfinished hand rewrite fails the run
    # rather than hiding behind an exemption.
    failures: list[str] = []
    for path in sorted(PLUGIN_ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in GATE_SUFFIXES:
            continue
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        if rel in GATE_SKIPS or rel.startswith(tuple(GATE_SKIP_PREFIXES)):
            continue
        gate(rel, path.read_text(encoding="utf-8"), failures)

    print(f"\nhand-owned files: {len(HAND_REWRITES)}")
    for rel in HAND_REWRITES:
        marker = "present" if (PLUGIN_ROOT / rel).exists() else "MISSING"
        print(f"  {marker}  {rel}")

    # A port-authored file that went missing is a feature that stopped shipping,
    # and nothing else in this run would notice, because upstream never had it.
    print(f"\nport-authored files: {len(PORT_AUTHORED)}")
    for rel in PORT_AUTHORED:
        marker = "present" if (PLUGIN_ROOT / rel).exists() else "MISSING"
        print(f"  {marker}  {rel}")

    if failures:
        print(f"\nGATE FAILURES ({len(failures)}):")
        for failure in failures[:120]:
            print(f"  {failure}")
        if len(failures) > 120:
            print(f"  ... and {len(failures) - 120} more")
    else:
        print("\ngate: clean, no Cursor-only constructs outside hand-rewrites")

    report = {
        "upstream": Path(os.path.relpath(upstream, PLUGIN_ROOT.parent)).as_posix(),
        "plugin": Path(os.path.relpath(PLUGIN_ROOT, PLUGIN_ROOT.parent)).as_posix(),
        "copied": copied,
        "excluded": skipped,
        "adapted": adapted,
        "hand_owned_seeded": seeded,
        "hand_owned_protected": protected,
        "renames": RENAMES,
        "substitutions": dict(hits),
        "hand_rewrites": HAND_REWRITES,
        "port_authored": PORT_AUTHORED,
        "gate_failures": failures,
    }
    report_path = PLUGIN_ROOT / "scripts" / "port-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nreport: {report_path}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
