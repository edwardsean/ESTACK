#!/usr/bin/env python3
"""Rebuild the Claude Code edition of pstack from the Qoder port.

This script is the lever. It reads the Qoder port of pstack (the source of
truth, including its enterprise layer), applies recorded Qoder-to-Claude-Code
substitutions, reshapes the few components whose container changed (rules
become skills, the hook manifest becomes hooks/hooks.json, agent frontmatter
takes Claude Code model aliases), and then gates the whole shipped tree so a
Qoder-only construct that survives anywhere fails the run loudly.

Files listed in HAND_REWRITES are hand-owned. The lever seeds each one once,
from the adapted text, so the hand edit starts from a real diff. After that it
never writes them again, which keeps re-runs idempotent and keeps a re-run from
destroying hand work. Hand-owned files are still gated.

Usage:
    python3 scripts/port-from-qoder.py [QODER_ROOT] [UPSTREAM_CLAUDE_ROOT]

QODER_ROOT defaults to ../pstack-qoder. UPSTREAM_CLAUDE_ROOT defaults to
../pstack-source/harness/pstack/claude-code, read only for the skill
frontmatter switches Qoder could not express. Neither tree is ever written.
"""

from __future__ import annotations

import json
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
    "agents",
    "assets",
    "docs",
    "hooks",
    "rules",
    "LICENSE",
]

# Never carried over. Each has a Claude Code replacement written by hand.
EXCLUDES = [
    # Qoder manifest. Claude Code reads .claude-plugin/plugin.json.
    ".qoder-plugin",
    # The Qoder port's own tooling and its provenance documents. This edition
    # ships its own lever, tests, and documents under the same names.
    "scripts",
    "README.md",
    "COMPATIBILITY.md",
    "PORTING-NOTES.md",
    "CONNECTORS.md",
]

HAND_OWNED_SEED_ONLY = True

# Container moves. A Qoder rule with `trigger: model_decision` loads on demand
# by its description, which is exactly how a Claude Code skill loads, so each
# rule becomes a skill of the same name and description. None of the three is
# `always_on`, so no SessionStart hook is needed to stand in for one.
RENAMES = {
    "rules/pstack-seats.md": "skills/pstack-seats/SKILL.md",
    "rules/enterprise-seats.md": "skills/enterprise-seats/SKILL.md",
    "rules/enterprise-gates.md": "skills/enterprise-gates/SKILL.md",
    "hooks/enterprise-gates.json": "hooks/hooks.json",
}
RULE_TO_SKILL = {k for k in RENAMES if k.startswith("rules/")}

# Files whose Qoder coupling is semantic, not lexical. Seeded once from the
# adapted text, then owned by hand.
#
# A file belongs here only when no substitution can make it correct. Anything a
# rule can fix stays out, so the port stays reproducible from the Qoder tree.
HAND_REWRITES = [
    # The routing model itself. Qoder bound a model to an agent and overrode it
    # in settings.json; Claude Code takes model and effort per Agent call.
    "skills/poteto-mode/SKILL.md",
    "skills/setup-pstack/SKILL.md",
    "skills/poteto-help/SKILL.md",
    "skills/pstack-seats/SKILL.md",
    "docs/MODEL-ROUTING.md",
    # Fan-out workflows whose Qoder text explains a missing per-call model or
    # a missing background flag. Claude Code has both.
    "skills/arena/SKILL.md",
    "skills/swarm/SKILL.md",
    # Built on capabilities that differ shape-wise between the two hosts.
    "skills/automate-me/SKILL.md",
    "skills/make-bot-ui/SKILL.md",
    "skills/prd-rules/SKILL.md",
    # Transcript lookup. The Qoder slug was opaque, the Claude Code slug is
    # derivable from the path, so the lookup changes shape.
    "skills/poteto-mode/scripts/worktree-audit.sh",
    # Playbooks and guide pages that replaced the /loop wake with a fallback.
    # Claude Code has /loop, so the real step comes back.
    "skills/poteto-mode/playbooks/autonomous-run.md",
    "skills/poteto-mode/playbooks/autopilot-full.md",
    "docs/guide/01-setup.md",
    "docs/guide/07-overnight.md",
]

# Written for this edition only, outside any copy root, listed so the lever can
# report a missing one. The lever never writes these.
PORT_AUTHORED = [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "README.md",
    "COMPATIBILITY.md",
    "PORTING-NOTES.md",
    "CONNECTORS.md",
    "PROGRESS.md",
    "scripts/selftest.py",
    "scripts/selftest.sh",
    "scripts/test-gates.py",
]

# Every agent file under agents/ is a seat. Claude Code registers plugin
# agents as `pstack:<name>`, so a dispatch by bare name would miss.
def seat_names(source: Path) -> list[str]:
    return sorted(p.stem for p in (source / "agents").glob("*.md"))


# ---------------------------------------------------------------------------
# Mechanical substitutions
# ---------------------------------------------------------------------------
# Ordered. Each entry is (rule id, pattern, replacement, reason). Patterns are
# regular expressions, but almost all are literal spans. Longer and more
# specific patterns come first so they win over the generic ones. Every
# replacement is chosen so it cannot match its own pattern, which is what makes
# a re-run a no-op.

RULES: list[tuple[str, str, str, str]] = [
    # --- Environment and paths -------------------------------------------
    ("C01", r"QODER_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT",
     "Claude Code exports CLAUDE_PLUGIN_ROOT to plugin hook commands."),
    ("C02", r"QODER_PROJECT_DIR", "CLAUDE_PROJECT_DIR",
     "Claude Code exports CLAUDE_PROJECT_DIR to every command hook."),
    ("C03", r"\.qoder/enterprise/", ".claude/enterprise/",
     "Project policy lives beside the rest of the project's Claude Code config."),
    ("C04", r"`\.qoder/rules/enterprise-<domain>\.md`",
     "`.claude/skills/enterprise-<domain>/SKILL.md`",
     "A model_decision rule card becomes a project skill, which loads on demand by description."),
    ("C05", r"\.qoder/rules/enterprise-\*\.md", ".claude/skills/enterprise-*/SKILL.md",
     "Same move, glob form."),
    ("C06", r"(?<![~/])\.qoder/rules/pstack-models\.md", "~/.claude/rules/pstack-models.md",
     "Upstream's Claude edition keeps the model choices in a user rule, which Claude Code loads into every session."),
    ("C07", r"~/\.qoder/skills/", "~/.claude/skills/", "Claude Code user skill path."),
    ("C08", r"(?<![~/])\.qoder/skills/", ".claude/skills/", "Claude Code project skill path."),
    ("C09", r"~/\.qoder/plugins/", "~/.claude/plugins/", "Claude Code plugin cache root."),
    ("C10", r"\.qoder-plugin/plugin\.json", ".claude-plugin/plugin.json", "Claude Code manifest path."),
    ("C11", r"existing rule cards under `\.qoder/rules/`",
     "existing rule cards under `.claude/skills/enterprise-*/`",
     "Rule cards are project skills here."),
    # Transcripts. Measured layout: ~/.claude/projects/<slug>/<session>.jsonl,
    # slug derivable from the path, per upstream's Claude Code adapter.
    ("C12", r"`~/\.qoder/cache/projects/<slug>/conversation-history/<id>/<id>\.jsonl`, where `<slug>` is the "
            r"workspace folder name plus (?:a short|an opaque) hash, like `MyApp-1a2b3c4d`\. The hash is not "
            r"derivable from the path, so list `~/\.qoder/cache/projects/` and match the folder name instead "
            r"of building the slug",
     "`~/.claude/projects/<slug>/<session>.jsonl`, where `<slug>` is the workspace path with each `/` and "
     "`.` changed to `-` (so `/Users/you/proj` is `-Users-you-proj`). The newest `.jsonl` directly in that "
     "folder is the current session, and `<session>/subagents/` holds its subagent transcripts",
     "Claude Code transcript layout, from upstream's Claude Code adapter."),
    ("C13", r"under the active workspace's `conversation-history/` directory \(listed under `~/\.qoder/cache/projects/`\)",
     "in the active workspace's folder under `~/.claude/projects/` (the workspace path with each `/` and `.` changed to `-`)",
     "Claude Code transcript layout."),
    ("C14", r"under the active workspace's `conversation-history/` directory \(the system prompt names the path\. "
            r"Do not glob across `~/\.qoder/cache/projects/\*/`",
     "in the active workspace's folder under `~/.claude/projects/` (the workspace path with each `/` and `.` "
     "changed to `-`. Do not glob across `~/.claude/projects/*/`",
     "Same, with the cross-workspace warning kept."),
    ("C16", r"`~/\.qoder/cache/projects/\*/`", "`~/.claude/projects/*/`", "Cross-workspace glob root."),

    # --- Rules became skills ----------------------------------------------
    ("C20", r"`rules/enterprise-gates\.md`", "`skills/enterprise-gates/SKILL.md`", "Rule moved into a skill."),
    ("C21", r"`rules/enterprise-seats\.md`", "`skills/enterprise-seats/SKILL.md`", "Rule moved into a skill."),
    ("C22", r"`rules/pstack-seats\.md`", "`skills/pstack-seats/SKILL.md`", "Rule moved into a skill."),
    ("C23", r"the \*\*enterprise-seats\*\* rule", "the **enterprise-seats** skill", "Rule moved into a skill."),
    ("C24", r"the \*\*enterprise-gates\*\* rule", "the **enterprise-gates** skill", "Rule moved into a skill."),
    ("C25", r"the `pstack-seats` rule", "the `pstack-seats` skill", "Rule moved into a skill."),

    # --- Per-seat model overrides -----------------------------------------
    # Qoder: settings.json agents.overrides. Claude Code: the dispatcher passes
    # model and effort on the Agent call, read from the user's model rule.
    ("C30", r"Your (?:`model` and `effort`|model and effort) are fixed by this file or by "
            r"`agents\.overrides\.([\w-]+)` in `settings\.json`, and you cannot change them per task\.",
     r"Your `model` and `effort` default to this file's frontmatter. The dispatcher can override both on "
     r"the `Agent` call, from the `\1:` line in `~/.claude/rules/pstack-models.md`, and you cannot change "
     r"them mid-task.",
     "Claude Code takes model and effort per Agent call."),
    ("C31", r"Your (?:`model` and `effort`|model and effort) are fixed by this file or by "
            r"`agents\.overrides\.([\w-]+)` in `settings\.json`\.",
     r"Your `model` and `effort` default to this file's frontmatter, and the dispatcher can override both "
     r"on the `Agent` call from the `\1:` line in `~/.claude/rules/pstack-models.md`.",
     "Same, sentence form."),
    ("C32", r"and your model and effort are fixed by this file or by `agents\.overrides\.([\w-]+)` in "
            r"`settings\.json`\.",
     r"and your model and effort default to this file's frontmatter, which the dispatcher can override on "
     r"the `Agent` call from the `\1:` line in `~/.claude/rules/pstack-models.md`.",
     "Same, clause form."),
    ("C33", r"Your `model` defaults to `auto`, which resolves to the session model unless "
            r"`agents\.overrides\.pstack-panel-3` in `settings\.json` pins something else\. Pin this seat to "
            r"a third vendor when you want a genuine cross-vendor panel; leaving it on `auto` can collapse "
            r"the panel to two distinct models\.",
     "Your `model` defaults to `inherit`, the session model, unless the dispatcher passes another on the "
     "`Agent` call from the `pstack-panel-3:` line in `~/.claude/rules/pstack-models.md`. Every model "
     "Claude Code can run is one vendor's, so this seat adds a third model, not a third vendor, and "
     "leaving it on `inherit` collapses the panel to two distinct models whenever the session runs "
     "`opus` or `sonnet`.",
     "No cross-vendor seat exists in Claude Code."),
    ("C34", r"If the dispatcher needs this seat on a specific model for vendor diversity, it sets that "
            r"through `agents\.overrides` before the run\.",
     "If the dispatcher needs this seat on a specific model for diversity, it passes `model` on the "
     "`Agent` call.",
     "Per-call model."),
    ("C35", r"`agents\.overrides` in `settings\.json` can repin a seat, so the configured default is not "
            r"evidence of what produced the design\.",
     "The dispatcher can pass a different `model` on the `Agent` call, so the configured default is not "
     "evidence of what produced the design.",
     "Per-call model."),
    ("C36", r"so the answer does not change if a user swaps the seat for a different agent through "
            r"`agents\.overrides`\.",
     "so the answer does not change if a user repoints the seat's model in "
     "`~/.claude/rules/pstack-models.md`.",
     "Per-call model."),
    ("C37", r"You are a Qoder Custom Agent\. Your `model` and `effort` are fixed by this file, or by an "
            r"`agents\.overrides\.poteto-agent` entry in `settings\.json`\. You cannot change them per task, "
            r"and you cannot ask for a different model\.",
     "You are a Claude Code plugin subagent, registered as `pstack:poteto-agent`. Your `model` and "
     "`effort` default to this file's frontmatter, and your parent can override both on the `Agent` "
     "call from the `poteto-agent:` line in `~/.claude/rules/pstack-models.md`. You cannot change them "
     "mid-task.",
     "Per-call model."),
    ("C38", r"There is no cloud environment and no per-call background flag\. When a step needs an isolated "
            r"working copy, use a git worktree you create yourself and name its path in your report\.",
     "There is no cloud environment. Subagents run in the background by default and notify their parent "
     "when they finish. When a step needs an isolated working copy, dispatch with `isolation: "
     "\"worktree\"` on the `Agent` call, or use a git worktree you create yourself, and name its path in "
     "your report.",
     "Claude Code subagents run in the background by default, and the Agent tool takes isolation."),

    # --- Worktree isolation wording -----------------------------------------
    ("C40", r"`isolation: worktree` is set here, so Qoder gives you a separate checkout; report its path so "
            r"the dispatcher can read your artifact\.",
     "`isolation: worktree` is set here, so Claude Code runs you in a temporary git worktree; report its "
     "path and branch so the dispatcher can read your artifact.",
     "Claude Code subagent frontmatter supports isolation: worktree."),

    # --- Section titles -----------------------------------------------------
    ("C45", r"^## Qoder specifics$", "## Claude Code specifics", "Retitle, content adapted by the rules above."),
    ("C46", r"^## Qoder port note$", "## Claude Code port note", "Retitle."),

    # --- Plain host naming where the sentence stays true ---------------------
    ("C50", r"enforced by Qoder hooks, which sit outside the model",
     "enforced by Claude Code hooks, which sit outside the model", "Same mechanism, both hosts."),
    ("C51", r"also enforced by Qoder hooks that sit outside the model",
     "also enforced by Claude Code hooks that sit outside the model", "Same."),
    ("C52", r"\| Qoder hooks, outside the model \|", "| Claude Code hooks, outside the model |", "Same."),
    ("C53", r"relative to the project root Qoder opened", "relative to the project root Claude Code started in",
     "CLAUDE_PROJECT_DIR is the session's start directory."),
    ("C54", r"inside the environment Qoder runs hooks in", "inside the environment Claude Code runs hooks in", "Same."),
    ("C55", r"Errors land in Qoder's diagnostic output rather than in the chat\.",
     "Errors land in Claude Code's debug output rather than in the chat. Run `claude --debug`, or open "
     "`/hooks` to confirm the three pstack hooks are registered.",
     "Claude Code's hook diagnostics."),
    ("C56", r"plugin agents have `mcpServers` stripped by Qoder's safety policy",
     "Claude Code ignores `mcpServers` on plugin agents", "Documented Claude Code plugin subagent restriction."),
    ("C57", r"since Qoder strips `mcpServers` from plugin-shipped definitions along with `hooks` and "
            r"`permissionMode`",
     "since Claude Code ignores `mcpServers` on plugin-shipped subagents, along with `hooks` and "
     "`permissionMode`",
     "Same restriction, Claude Code wording."),
    ("C58", r"Qoder's built-in `/create-skill` skill",
     "the skill-authoring skill the session offers (such as `skill-creator` or `writing-skills`), or a "
     "hand-written `SKILL.md`",
     "Claude Code ships no create-skill built-in."),
    ("C59", r"Qoder caps a question at four options and allows at most four questions per call",
     "`AskUserQuestion` caps a question at four options and allows at most four questions per call",
     "Same tool limit."),
    ("C60", r"A developer works in the Qoder IDE and invokes a skill",
     "A developer works in Claude Code and invokes a skill", "Host naming."),
    ("C61", r"Nothing here proves that Qoder dispatches an `ent-` seat at runtime\. `qodercli` is\n"
            r"absent on the machine this was built on, so the enterprise roster has never been\n"
            r"observed running\.",
     "Nothing here proves that Claude Code dispatches an `ent-` seat at runtime. The static\n"
     "checks and `claude plugin validate` pass, but no live session has dispatched one,\n"
     "so the enterprise roster has never been observed running.",
     "Host naming; the evidence gap is the same."),
    ("C62", r"The cards are `model_decision` rules, which is what makes",
     "The cards are project skills, loaded by description, which is what makes",
     "Rule cards are skills here."),
    ("C63", r"Tool integrations from this layer are documented rather than built\. Qoder strips",
     "Tool integrations from this layer are documented rather than built. Claude Code ignores",
     "Same restriction."),
    ("C64", r"\bQoder publishes no vendor behind a model alias, so\b",
     "Every model Claude Code can run comes from one vendor, so",
     "Judge independence still cannot hold, for a different reason."),
    ("C65", r"\bQoder cannot check that at dispatch time\.",
     "Claude Code cannot deliver that, because every model it runs is Anthropic's.",
     "Same."),

    # --- /loop is real in Claude Code ---------------------------------------
    # The Qoder lever turned each /loop into a manual fallback. These undo that
    # with upstream's own sentence, because Claude Code ships /loop.
    ("C70", r"Repeat per component until the diff is zero, driving each pass yourself, since Qoder has no "
            r"timer that re-enters a run\.",
     "`/loop` per component until the diff is zero.",
     "Claude Code ships /loop; upstream's step returns."),
    ("C71", r"give the agent that predicate", "give `/loop` that predicate", "Same."),
    ("C72", r"keep going until done\.", "/loop until done.", "Same, inside a pasted prompt."),
    ("C73", r"The transcript scan is slow, so let it finish before you read the table\. Qoder has no per-call "
            r"background flag for a shell command inside a subagent\.",
     "The transcript scan is slow, so run it in the background and read the table when it finishes.",
     "Claude Code runs background shell commands."),

    ("C74", r"Drive a long or stubborn hunt by running the passes yourself inside this run, since Qoder has "
            r"no timer to re-enter it for you\. Say when you stop and hand back a resume note per "
            r"`pause-safely\.md`\.",
     "Drive a long or stubborn hunt with Claude Code's `/loop` command (a built-in, not a pstack skill).",
     "Upstream's step, with the host renamed."),
    ("C75", r"which blocks until it reports `COMPLETE` at the ceiling\. Qoder has no timer to re-enter this "
            r"run, so run it inside this turn with a ceiling you can defend, and say when you hit it rather "
            r"than leaving the stack half-landed\.",
     "under `/loop` until it reports `COMPLETE` at the ceiling.",
     "Upstream's step; Claude Code ships /loop."),
    ("C76", r"Qoder runs every seat on this machine, so a stack of N verifiers is N worktrees and N checkouts "
            r"sharing one disk and one CPU\.",
     "Claude Code runs every seat on this machine, so a stack of N verifiers is N worktrees and N "
     "checkouts sharing one disk and one CPU.",
     "Still true: no cloud agent is assumed."),
    ("C77", r"Upstream's version of this recipe says \"do not stop\", and Qoder stops anyway when the turn "
            r"ends, so the ceiling and the resume note are what separate a deliberate stop from a truncation "
            r"in the middle of an edit\.",
     "Upstream's version of this recipe says \"do not stop\". `/loop` re-enters the run, and the ceiling "
     "and the resume note are still what separate a deliberate stop from a truncation in the middle of "
     "an edit.",
     "Claude Code has /loop, so the stop is no longer forced."),
    ("C78", r"because a worktree is the only isolation Qoder offers\.",
     "or dispatch with `isolation: \"worktree\"` so Claude Code makes one per subagent.",
     "Agent tool isolation."),
    ("C79", r"- \*\*Treating `auto` as \"follow my chat\"\.\*\* `inherit` is the alias that follows the session "
            r"model\. `auto` lets Qoder pick per turn, which is a different thing\.",
     "- **Leaving every seat on `inherit`.** `inherit` follows the session model, so a panel of three "
     "`inherit` seats is one model guessing three times.",
     "Claude Code has no `auto` alias; the pitfall that survives is the collapsed panel."),
    ("C80", r"Qoder has no per-skill mode, so start each new task with `/poteto-mode` again, or move the "
            r"discipline you want into a rule under `\.qoder/rules/`\.",
     "Claude Code has no per-skill mode, so start each new task with `/pstack:poteto-mode` again, or move "
     "the discipline you want into `CLAUDE.md` or a rule under `~/.claude/rules/`.",
     "Claude Code loads CLAUDE.md and ~/.claude/rules/ into every session."),
    ("C81", r"Qoder has no cloud agent and hands out no second machine, so the isolation on offer is a git "
            r"worktree, one directory per agent sharing this machine's disk and CPU\.",
     "This port assumes no cloud agent and no second machine, so the isolation on offer is a git "
     "worktree, one directory per agent sharing this machine's disk and CPU. Claude Code makes one per "
     "subagent when the dispatch passes `isolation: \"worktree\"`.",
     "Agent tool isolation."),
    ("C82", r"through Qoder's built-in `/create-skill`",
     "through the skill-authoring skill your session offers, or by hand",
     "Claude Code ships no create-skill built-in."),
    ("C83", r"`~/Library/Application Support/Qoder` \(`SharedClientCache` grows largest, then `CachedData`, "
            r"`CachedExtensionVSIXs`, `Cache`, and `logs`, plus `User/globalStorage/state\.vscdb\.backup`\) "
            r"and `~/\.qoder/logs`",
     "old session transcripts under `~/.claude/projects/` (only ones the user agrees are done with)",
     "Claude Code's disk growth is its transcript store, not an editor cache."),
    ("C84", r"Qoder enforces the restriction through the agent's tool list instead\.",
     "Claude Code enforces the restriction through the agent's tool list instead.",
     "Same mechanism."),
    ("C85", r"\*\*Port note\.\*\* In this Qoder build", "**Port note.** In this build",
     "Read-only reviewer is unchanged; the host name was incidental."),
    ("C86", r"Qoder binds a model to an agent and offers no per-call model parameter, which is why the seat "
            r"exists at all\.",
     "Claude Code could pass a model per call, but the seat also carries the architecture brief and the "
     "tool list, which is why it stays a seat.",
     "Claude Code has per-call model; the seat survives for its contract."),
    ("C87", r"Qoder binds models per agent, so independence is a property of your configuration, not "
            r"something you can choose at runtime\.",
     "Every model Claude Code can run comes from one vendor, so that independence cannot hold here. "
     "A different model family is the most the dispatcher can arrange, by passing `model` on the call.",
     "Judge independence stays unachievable, for a different reason."),
    ("C88", r"Enterprise approval gates for the pstack Qoder port\.",
     "Enterprise approval gates for the pstack Claude Code plugin.", "Host naming in the hook module."),
    ("C90", r"Qoder hands a hook its event as JSON on stdin", "Claude Code hands a hook its event as JSON on stdin",
     "Same hook I/O contract: JSON on stdin, verdict on stdout plus exit code."),
    ("C91", r"hookEventName is required or Qoder rejects the whole blob\.",
     "hookEventName is required inside hookSpecificOutput.", "Claude Code hook output contract."),
    ("C92", r"# Qoder sets this when the seat", "# Claude Code sets this when the seat",
     "stop_hook_active is a documented SubagentStop input field."),
    # enterprise-seats: the override section.
    ("C89", r"Same mechanism as the pstack seats\. A seat's model lives in its agent frontmatter and "
            r"`settings\.json` overrides it\. Run `/setup-pstack` to write the overrides, which asks once per "
            r"family, or edit them by hand:\n\n```json\n\{\n  \"agents\": \{\n    \"overrides\": \{\n      "
            r"\"ent-code-reviewer\": \{ \"modelConfig\": \{ \"model\": \"<your model name>\" \} \}\n    \}\n  "
            r"\}\n\}\n```\n\nEffort cannot be overridden and stays frontmatter-only\. Start a new chat after "
            r"editing, since Qoder documents no reload path for `agents\.overrides` in the IDE\. ",
     "Same mechanism as the pstack seats. A seat's model and effort live in its agent frontmatter, and "
     "the orchestrator overrides both on the `Agent` call when `~/.claude/rules/pstack-models.md` has a "
     "line for that seat. Run `/pstack:setup-pstack` to write the lines, which asks once per family and "
     "writes one line per seat, or edit them by hand:\n\n```\nent-code-reviewer: opus xhigh\n```\n\n"
     "Edits apply to the next dispatch, with no restart, because the orchestrator reads the line at "
     "dispatch time. ",
     "Claude Code takes model and effort per Agent call."),

    ("C93", r"Name the seat rather than a reasoning level, since each seat carries its own effort\.",
     "Pick each subagent's seat and reasoning level for the job. Start from the seat's line in "
     "`~/.claude/rules/pstack-models.md` and pass `effort` on the `Agent` call, higher than the line when "
     "the job needs it.",
     "Claude Code takes effort per Agent call, so upstream's per-call reasoning choice returns."),
    ("C94", r"in agent mode because readonly strips MCP access",
     "on `general-purpose`, because it keeps the session's MCP servers and the read-only seats declare none",
     "A plugin seat's tools allowlist carries no MCP tools; general-purpose inherits them."),
    # --- Seat dispatch names -------------------------------------------------
    # Applied last among prose rules. `subagent_type` gets the quoted scoped
    # name, every other backticked seat name gets the scope prefix.
    # SEAT_RULES are generated from agents/ in build_seat_rules().
]

# Model aliases. Qoder: inherit, auto, lite, efficient, performance.
# Claude Code: haiku, sonnet, opus, fable, inherit, or a full model id.
MODEL_ALIASES = {
    "performance": "opus",
    "efficient": "sonnet",
    "lite": "haiku",
    "auto": "inherit",
    "inherit": "inherit",
}

# Prose mentions of the alias as a seat default, backticked.
ALIAS_RULES: list[tuple[str, str, str, str]] = [
    ("M01", r"`performance`", "`opus`", "Qoder performance alias is Claude Code opus."),
    ("M02", r"`efficient`", "`sonnet`", "Qoder efficient alias is Claude Code sonnet."),
    ("M03", r"`lite`", "`haiku`", "Qoder lite alias is Claude Code haiku."),
    ("M04", r"`auto`(?=( \|)|, high \|| \| high)", "`inherit`", "Seat-table cells only; prose `auto` is hand-checked."),
]


def build_seat_rules(seats: list[str]) -> list[tuple[str, str, str, str]]:
    alt = "|".join(re.escape(s) for s in sorted(seats, key=len, reverse=True))
    return [
        ("S01", rf"subagent_type:\s*\"?({alt})\"?(?![\w:-])", r'subagent_type: "pstack:\1"',
         "Plugin subagents register as pstack:<name>."),
        ("S03", rf"(?<=`)({alt})(?=`)", r"pstack:\1",
         "Backticked seat names are dispatch targets; scope them."),
    ]


# Frontmatter keys Qoder agents carried that Claude Code subagents also
# document. Anything else in an agent's frontmatter fails the run.
AGENT_KEYS = {"name", "description", "model", "effort", "color", "isolation",
              "tools", "disallowedTools", "background", "maxTurns", "skills", "memory"}
# Ignored for plugin subagents, so shipping one would imply support.
PLUGIN_AGENT_FORBIDDEN = {"hooks", "mcpServers", "permissionMode", "initialPrompt"}

# Skill frontmatter switches the Qoder port had to drop and Claude Code has.
SKILL_RESTORE_KEYS = ["disable-model-invocation", "paths"]

# One line inserted under the frontmatter of every manual-only skill, the way
# upstream's Claude edition inserts its adapter pointer. A manual-only skill is
# refused by the Skill tool, so a skill that names another has to say how to
# reach it.
MANUAL_ONLY_NOTE = (
    "> Claude Code: pstack skills are manual-only, so the `Skill` tool refuses them. To run another "
    "pstack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. "
    "Seats dispatch as `subagent_type: \"pstack:<seat>\"`."
)

# Unslop rule 13. Applied to every file, provenance documents included.
STYLE_PATTERNS = [
    (r"—", "em dash, forbidden by the unslop rule 13 this plugin ships"),
    (r"–", "en dash, forbidden by the unslop rule 13 this plugin ships"),
]

# Vendor coupling. Applied to every runtime file, not to provenance docs.
FORBIDDEN_PATTERNS = [
    # Qoder
    (r"(?i)qoder", "Qoder brand, path, or CLI"),
    (r"QODER_", "Qoder environment variable"),
    (r"\.qoder/", "Qoder config path"),
    (r"agents\.overrides", "Qoder settings.json per-agent override"),
    (r"modelConfig", "Qoder override field"),
    (r"model_decision", "Qoder rule trigger"),
    (r"always_on", "Qoder rule trigger"),
    (r"trigger:\s*\w", "Qoder rule frontmatter"),
    (r"(?m)^model:\s*(performance|efficient|lite|auto)\s*$", "Qoder model alias in frontmatter"),
    (r"`(performance|efficient|lite)`", "Qoder model alias in prose"),
    (r"Custom Agent", "Qoder product term for a subagent"),
    (r"conversation-history", "Qoder transcript directory"),
    (r"cache/projects", "Qoder transcript root"),
    # Cursor, inherited from the Qoder gate. A Qoder file that was clean of
    # these has to stay clean after the port.
    (r"\bCursor\b", "Cursor brand reference"),
    (r"generalPurpose", "Cursor built-in subagent name"),
    (r"run_in_background", "per-call background flag the Agent tool does not take"),
    (r'environment:\s*"cloud"', "Cursor cloud agent environment"),
    (r"cloud_base_branch", "Cursor cloud agent base branch"),
    (r"readonly:\s*true", "Cursor per-call readonly flag"),
    (r"claude-opus-5-5|claude-fable-5-2|gemini-4-carbon", "Cursor model slug"),
    (r"\bdeslop\b|control-ui|control-cli|cursor-team-kit", "cursor-team-kit skill"),
    (r"[Bb]ugbot", "Cursor Bugbot"),
    (r"Custom Mode", "Cursor custom mode"),
    (r"inherit-parent", "Cursor model alias"),
    (r"`Task`", "Cursor Task tool"),
]

# Provenance documents describe the Qoder port and upstream, so they name them.
GATE_SKIPS = {
    "README.md",
    "COMPATIBILITY.md",
    "PORTING-NOTES.md",
    "CONNECTORS.md",
    "PROGRESS.md",
    "docs/MODEL-ROUTING.md",
    # The manifest description names the port's provenance on purpose.
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
}
GATE_SKIP_PREFIXES = ["scripts/"]
GATE_SUFFIXES = [".md", ".sh", ".py", ".json"]

GATE_ALLOW = [
    r"https://github\.com/cursor/plugins[^\s)`\"']*",
]


# ---------------------------------------------------------------------------
# Transforms
# ---------------------------------------------------------------------------

def split_frontmatter(text: str) -> tuple[list[str], str]:
    match = re.match(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", text, re.DOTALL)
    if not match:
        return [], text
    return match.group(1).splitlines(), text[match.end():]


def join_frontmatter(lines: list[str], body: str) -> str:
    return "---\n" + "\n".join(lines) + "\n---\n" + body


def key_of(line: str) -> str:
    if line[:1] in (" ", "\t", "-"):
        return ""
    return line.split(":", 1)[0].strip()


def apply_rules(text: str, rules, hits: Counter) -> str:
    for rule_id, pattern, replacement, _reason in rules:
        text, count = re.subn(pattern, replacement, text, flags=re.MULTILINE)
        if count:
            hits[rule_id] += count
    return text


def transform_agent(rel: str, text: str, hits: Counter, problems: list[str]) -> str:
    lines, body = split_frontmatter(text)
    out = []
    for line in lines:
        key = key_of(line)
        if key in PLUGIN_AGENT_FORBIDDEN:
            problems.append(f"{rel}: frontmatter key `{key}` is ignored for plugin subagents")
        if key and key not in AGENT_KEYS:
            problems.append(f"{rel}: frontmatter key `{key}` is not a Claude Code subagent field")
        if key == "model":
            value = line.split(":", 1)[1].strip()
            mapped = MODEL_ALIASES.get(value)
            if mapped is None:
                problems.append(f"{rel}: model `{value}` has no Claude Code alias")
            elif mapped != value:
                hits[f"model:{value}->{mapped}"] += 1
                line = f"model: {mapped}"
        out.append(line)
    return join_frontmatter(out, body)


def transform_rule_to_skill(rel: str, text: str, hits: Counter) -> str:
    lines, body = split_frontmatter(text)
    name = Path(RENAMES[rel]).parent.name
    kept = [f"name: {name}"]
    for line in lines:
        key = key_of(line)
        if key == "trigger":
            value = line.split(":", 1)[1].strip()
            if value != "model_decision":
                raise SystemExit(f"{rel}: trigger {value!r} needs a SessionStart hook, not a skill")
            hits["rule->skill:model_decision"] += 1
            continue
        if key == "name":
            continue
        kept.append(line)
    return join_frontmatter(kept, body)


def transform_skill(rel: str, text: str, upstream: Path, hits: Counter) -> str:
    lines, body = split_frontmatter(text)
    if not lines:
        return text
    up = upstream / rel
    if not up.is_file():
        return text
    up_lines, _ = split_frontmatter(up.read_text(encoding="utf-8"))
    have = {key_of(line) for line in lines}
    manual = False
    for key in SKILL_RESTORE_KEYS:
        for line in up_lines:
            if key_of(line) == key:
                if key == "disable-model-invocation" and line.split(":", 1)[1].strip() == "true":
                    manual = True
                if key not in have:
                    lines.append(line)
                    hits[f"frontmatter-restore:{key}"] += 1
    if manual and MANUAL_ONLY_NOTE not in body:
        body = "\n" + MANUAL_ONLY_NOTE + "\n\n" + body.lstrip("\n")
        hits["manual-only-note"] += 1
    return join_frontmatter(lines, body)


def transform_hooks(text: str, hits: Counter, problems: list[str]) -> str:
    data = json.loads(text)
    data["description"] = (
        "Enterprise approval gates for the pstack orchestrator. Dormant until a project opts in by "
        "writing .claude/enterprise/gates.json, which /pstack:setup-enterprise does. Gate policy lives "
        "in that project file, never here, so one plugin install serves repos with different rules."
    )
    for event, groups in data.get("hooks", {}).items():
        for group in groups:
            for hook in group.get("hooks", []):
                if "name" in hook:
                    # Not a Claude Code hook handler field.
                    del hook["name"]
                    hits["hooks:drop-name"] += 1
                command = hook.get("command", "")
                if "QODER_PLUGIN_ROOT" in command:
                    hook["command"] = command.replace("QODER_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT")
                    hits["C01"] += 1
                for field in hook:
                    if field not in {"type", "command", "timeout", "statusMessage", "async", "if", "once"}:
                        problems.append(f"hooks/hooks.json: {event} handler field `{field}` is not documented")
    return json.dumps(data, indent=2) + "\n"


TEXT_SUFFIXES = {".md", ".sh", ".py"}


def adapt(rel_src: str, rel_dst: str, text: str, upstream: Path, seats: list[str],
          hits: Counter, problems: list[str]) -> str:
    if rel_dst == "hooks/hooks.json":
        return transform_hooks(text, hits, problems)
    if rel_src in RULE_TO_SKILL:
        text = transform_rule_to_skill(rel_src, text, hits)
    if rel_dst.startswith("agents/"):
        text = transform_agent(rel_dst, text, hits, problems)
    text = apply_rules(text, RULES, hits)
    if rel_dst.endswith(".md"):
        text = apply_rules(text, ALIAS_RULES, hits)
        text = apply_rules(text, build_seat_rules(seats), hits)
    if rel_dst.startswith("skills/") and rel_dst.endswith("/SKILL.md"):
        text = transform_skill(rel_dst, text, upstream, hits)
    return text


# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------

def strip_allowed(text: str) -> str:
    for pattern in GATE_ALLOW:
        text = re.sub(pattern, lambda m: " " * len(m.group(0)), text)
    return text


def gate_file(rel: str, text: str, failures: list[str]) -> None:
    text = strip_allowed(text)
    patterns = list(STYLE_PATTERNS)
    if rel not in GATE_SKIPS and not rel.startswith(tuple(GATE_SKIP_PREFIXES)):
        patterns += FORBIDDEN_PATTERNS
    for pattern, label in patterns:
        for match in re.finditer(pattern, text):
            line_no = text[: match.start()].count("\n") + 1
            failures.append(f"{rel}:{line_no}: {label} -> {match.group(0)!r}")


def gate_tree(failures: list[str]) -> None:
    for path in sorted(PLUGIN_ROOT.rglob("*")):
        if ".git" in path.parts or not path.is_file() or path.suffix not in GATE_SUFFIXES:
            continue
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        if rel in ("scripts/port-report.json", "scripts/port-from-qoder.py"):
            # The lever holds every forbidden pattern by construction, and the
            # report quotes them back.
            continue
        gate_file(rel, path.read_text(encoding="utf-8"), failures)


def check_tables() -> list[str]:
    problems = []
    ids = [r[0] for r in RULES + ALIAS_RULES]
    for rule_id in sorted(set(ids)):
        if ids.count(rule_id) > 1:
            problems.append(f"duplicate rule id {rule_id}")
    for table, name in ((HAND_REWRITES, "HAND_REWRITES"), (PORT_AUTHORED, "PORT_AUTHORED")):
        if len(set(table)) != len(table):
            problems.append(f"{name} has a duplicate entry")
    for entry in PORT_AUTHORED:
        if entry in HAND_REWRITES:
            problems.append(f"{entry} is both hand-rewritten and port-authored")
    return problems


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def collect(source: Path) -> list[Path]:
    files = []
    for root in COPY_ROOTS:
        target = source / root
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            files.extend(sorted(p for p in target.rglob("*") if p.is_file()))
    return files


def is_excluded(rel: str) -> bool:
    for exclude in EXCLUDES:
        if rel == exclude or rel.startswith(exclude + "/"):
            return True
    return rel.endswith(".DS_Store")


def main(argv: list[str]) -> int:
    source = Path(argv[0]).expanduser().resolve() if argv else (PLUGIN_ROOT.parent / "pstack-qoder").resolve()
    upstream = (Path(argv[1]).expanduser().resolve() if len(argv) > 1 else
                (PLUGIN_ROOT.parent / "pstack-source" / "harness" / "pstack" / "claude-code").resolve())
    for label, path in (("qoder port", source), ("upstream claude edition", upstream)):
        if not path.is_dir():
            print(f"error: {label} not found: {path}", file=sys.stderr)
            return 2
    problems = check_tables()
    if problems:
        print("error: port tables are malformed", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 2

    print(f"source:   {source}")
    print(f"upstream: {upstream}")
    print(f"plugin:   {PLUGIN_ROOT}")

    seats = seat_names(source)
    hits: Counter = Counter()
    frontmatter_problems: list[str] = []
    copied = changed = adapted = excluded = seeded = protected = 0
    written: list[str] = []

    for src in collect(source):
        rel_src = src.relative_to(source).as_posix()
        if is_excluded(rel_src):
            excluded += 1
            continue
        rel_dst = RENAMES.get(rel_src, rel_src)
        dst = PLUGIN_ROOT / rel_dst
        hand = rel_dst in HAND_REWRITES
        if hand and HAND_OWNED_SEED_ONLY and dst.exists():
            # Adapt in memory only, so the hit counts mean the same thing on
            # every run: a rule at zero matched nothing in the Qoder tree.
            adapt(rel_src, rel_dst, src.read_text(encoding="utf-8"), upstream, seats, hits, [])
            protected += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix in TEXT_SUFFIXES or rel_dst == "hooks/hooks.json":
            text = src.read_text(encoding="utf-8")
            new = adapt(rel_src, rel_dst, text, upstream, seats, hits, frontmatter_problems)
            if new != text:
                adapted += 1
            old = dst.read_text(encoding="utf-8") if dst.exists() else None
            if old != new:
                dst.write_text(new, encoding="utf-8")
                changed += 1
                written.append(rel_dst)
            if src.stat().st_mode & 0o111:
                dst.chmod(0o755)
        else:
            if not dst.exists() or dst.read_bytes() != src.read_bytes():
                shutil.copy2(src, dst)
                changed += 1
                written.append(rel_dst)
        if hand:
            seeded += 1
        copied += 1

    print(f"\nported {copied} files ({excluded} excluded), {adapted} adapted by rules, {changed} written this run")
    print(f"hand-owned: {seeded} seeded, {protected} left untouched")

    print("\nsubstitution counts:")
    for key, count in sorted(hits.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {count:4d}  {key}")
    all_ids = [r[0] for r in RULES + ALIAS_RULES] + ["S01", "S03"]
    silent = [i for i in all_ids if hits[i] == 0]

    print(f"\nhand-owned files: {len(HAND_REWRITES)}")
    for rel in HAND_REWRITES:
        print(f"  {'present' if (PLUGIN_ROOT / rel).exists() else 'MISSING'}  {rel}")
    print(f"\nport-authored files: {len(PORT_AUTHORED)}")
    for rel in PORT_AUTHORED:
        print(f"  {'present' if (PLUGIN_ROOT / rel).exists() else 'MISSING'}  {rel}")

    failures: list[str] = list(frontmatter_problems)
    gate_tree(failures)
    if failures:
        print(f"\nGATE FAILURES ({len(failures)}):")
        for failure in failures[:200]:
            print(f"  {failure}")
        if len(failures) > 200:
            print(f"  ... and {len(failures) - 200} more")
    else:
        print("\ngate: clean, no Qoder-only or Cursor-only constructs outside provenance docs, no dashes anywhere")

    report = {
        "source": str(source),
        "upstream": str(upstream),
        "plugin": str(PLUGIN_ROOT),
        "ported": copied,
        "excluded": excluded,
        "adapted": adapted,
        "hand_owned_seeded": seeded,
        "hand_owned_protected": protected,
        "renames": RENAMES,
        "rules": {r[0]: {"pattern": r[1], "replacement": r[2], "reason": r[3]}
                  for r in RULES + ALIAS_RULES + build_seat_rules(seats)},
        "substitutions": dict(sorted(hits.items())),
        "rules_that_did_not_fire": silent,
        "hand_rewrites": HAND_REWRITES,
        "port_authored": PORT_AUTHORED,
        "gate_failures": failures,
    }
    report_path = PLUGIN_ROOT / "scripts" / "port-report.json"
    new_report = json.dumps(report, indent=2) + "\n"
    if not report_path.exists() or report_path.read_text(encoding="utf-8") != new_report:
        report_path.write_text(new_report, encoding="utf-8")
    print(f"\nreport: {report_path}")
    print(f"summary: written={changed} seeded={seeded} protected={protected} gate_failures={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
