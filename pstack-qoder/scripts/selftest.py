#!/usr/bin/env python3
"""Static conformance test for the pstack-qoder port.

This proves the plugin is wired correctly. It does not prove Qoder runs it.
Nothing here dispatches an agent, because dispatch needs a live Qoder session
and `qodercli` is not present on every machine that checks this out. What a
static test can prove is the part that actually breaks in a port:

  * the manifest declares only components that exist
  * every skill and agent has frontmatter Qoder will accept
  * no agent carries a field a plugin is not allowed to carry
  * every relative link resolves, so no instruction points at a file the port
    dropped
  * every backticked relative path resolves too, which the link syntax hides
  * every seat named by a skill or playbook exists in `agents/`, so no dispatch
    can fail on an unknown subagent_type
  * the main workflow is reachable end to end, orchestrator to playbook to seat
  * no Cursor-only construct survived anywhere in the shipped tree
  * the enterprise gate hooks are shaped the way Qoder loads them, and their
    scripts exist and are executable, which is the half a behavioural test in
    `scripts/test-gates.py` cannot catch

Run it with `scripts/selftest.sh`, which also runs the port lever's gate and,
when available, `qodercli plugin validate` for the runtime half of the proof.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

# The gate check below imports the port lever by path. Without this, that import
# drops a `scripts/__pycache__/*.pyc` into the tree being packaged, so running
# the test creates the very junk it then fails on.
sys.dont_write_bytecode = True

PLUGIN_ROOT = Path(__file__).resolve().parent.parent

SCRIPTS = PLUGIN_ROOT / "scripts"
SKILLS = PLUGIN_ROOT / "skills"
AGENTS = PLUGIN_ROOT / "agents"
RULES = PLUGIN_ROOT / "rules"
HOOKS = PLUGIN_ROOT / "hooks"

# Every event Qoder documents. A typo here is a hook that never fires and says
# nothing about it, so the set is checked rather than trusted.
HOOK_EVENTS = {
    "SessionStart", "SessionEnd", "UserPromptSubmit",
    "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PermissionRequest", "PermissionDenied",
    "Stop", "StopFailure", "SubagentStart", "SubagentStop",
    "PreCompact", "PostCompact", "Notification", "InstructionsLoaded",
    "ConfigChange", "CwdChanged", "FileChanged",
    "WorktreeCreate", "WorktreeRemove", "Elicitation", "ElicitationResult",
}
# Events that honour exit 2. Declaring a block on one that does not support it
# would give a gate that looks enforced and is not.
BLOCKING_EVENTS = {
    "UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop", "PreCompact",
    "ConfigChange", "Elicitation", "ElicitationResult",
}

MODEL_ALIASES = {"inherit", "auto", "lite", "efficient", "performance"}
EFFORTS = {"low", "medium", "high", "xhigh", "max"}
RULE_TRIGGERS = {"always_on", "model_decision", "glob", "manual"}
PLUGIN_UNSAFE_AGENT_KEYS = {"hooks", "mcpServers", "permissionMode"}
DROPPED_SKILL_KEYS = {"disable-model-invocation", "icon", "color", "paths"}
KNOWN_TOOLS = {
    "Read", "Grep", "Glob", "Bash", "Write", "Edit",
    "WebFetch", "WebSearch", "Agent",
}
# The documented palette has eight entries and this port ships 28 agents, so six
# colors are shared by arithmetic rather than by oversight, and within the ent-
# roster by design, where color reads as family. That is a note, not a defect,
# and it is why duplicates warn while an unknown color fails.
AGENT_COLORS = {"red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"}
JUNK_NAMES = {".DS_Store", "__MACOSX", "settings.local.json", ".pytest_cache", "__pycache__"}
BANNED_ROOT_DIRS = {".cursor-plugin", ".claude-plugin", ".codex-plugin"}

SEAT_RE = re.compile(r"`(pstack-[a-z0-9-]+|poteto-agent|comment-sicko)`")
# The enterprise roster is prefixed so it greps as a group, and SEAT_RE cannot
# see it because none of its alternatives match. Reachability for these seats is
# a separate check, since they are named by playbooks rather than by a skill.
ENT_SEAT_RE = re.compile(r"`(ent-[a-z0-9-]+)`")
SUBAGENT_RE = re.compile(r"subagent_type:\s*\"?([A-Za-z0-9_-]+)\"?")
MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")

# A path in backticks, with a slash so bare filenames stay out of it. The
# markdown link check cannot see these, and a wrong one silently sends the model
# to a file the port dropped.
BARE_PATH_RE = re.compile(
    r"`([^`\s<>{}*$]*/[A-Za-z0-9._-]+\.(?:md|sh|json|py|ya?ml|png|svg|ts|js))`"
)
# Paths that live in the user's project or their home, not in this plugin.
BARE_PATH_SKIPS = ("~/", "/", ".qoder/", "http://", "https://")

failures: list[str] = []
warnings: list[str] = []


def fail(check: str, message: str) -> None:
    failures.append(f"{check}: {message}")


def warn(check: str, message: str) -> None:
    warnings.append(f"{check}: {message}")


# ---------------------------------------------------------------------------
# Frontmatter
# ---------------------------------------------------------------------------

def frontmatter(path: Path) -> tuple[dict[str, str] | None, str | None]:
    """Parse flat YAML frontmatter without a YAML dependency.

    Every frontmatter block in this plugin is flat, with at most a folded block
    scalar for `description`. Returns (fields, error). A block scalar's
    continuation lines are indented, which is how they are told apart from keys.
    """
    lines = path.read_text(encoding="utf-8").split("\n")
    if not lines or lines[0].strip() != "---":
        return None, "no frontmatter block"
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return None, "frontmatter block is never closed"

    fields: dict[str, str] = {}
    key: str | None = None
    for line in lines[1:end]:
        if not line.strip():
            continue
        if line[:1] in (" ", "\t"):
            if key is not None:
                fields[key] = (fields[key] + " " + line.strip()).strip()
            continue
        if ":" not in line:
            return fields, f"unparsable frontmatter line: {line!r}"
        raw_key, value = line.split(":", 1)
        key = raw_key.strip()
        value = value.strip()
        if value in (">", ">-", "|", "|-", "|+"):
            fields[key] = ""
        else:
            fields[key] = value.strip("\"'")
    return fields, None


def list_field(value: str) -> list[str]:
    """Split a frontmatter list without cutting `Agent(name1, name2)` in two.

    Qoder accepts that form to allow only specific subagents, so the comma
    inside the parens is part of one entry.
    """
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    out: list[str] = []
    depth = 0
    current = ""
    for char in value:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            out.append(current)
            current = ""
            continue
        current += char
    out.append(current)
    return [item.strip().strip("\"'") for item in out if item.strip()]


def is_valid_tool(token: str) -> bool:
    """A documented tool name, the `*` wildcard, an `Agent(...)` allow-list, or
    a fully qualified MCP tool."""
    if token == "*":
        return True
    if token.startswith("mcp__"):
        return True
    if re.fullmatch(r"Agent\([A-Za-z0-9_, *-]+\)", token):
        return True
    return token in KNOWN_TOOLS


def strip_code_fences(text: str) -> str:
    """Blank out fenced blocks so a snippet's path is not read as a link."""
    out: list[str] = []
    fenced = False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            out.append("")
            continue
        out.append("" if fenced else line)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_manifest() -> dict:
    path = PLUGIN_ROOT / ".qoder-plugin" / "plugin.json"
    if not path.is_file():
        fail("manifest", ".qoder-plugin/plugin.json is missing")
        return {}
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail("manifest", f"plugin.json is not valid JSON: {exc}")
        return {}

    name = manifest.get("name")
    if name != PLUGIN_ROOT.name:
        fail("manifest", f"name {name!r} does not match folder {PLUGIN_ROOT.name!r}")

    for field in ("version", "description"):
        if not manifest.get(field):
            fail("manifest", f"{field} is missing")

    for key, target in manifest.items():
        if key not in ("skills", "agents", "rules", "commands", "hooks", "mcpServers", "logo"):
            continue
        if not isinstance(target, str):
            continue
        if not target.startswith("./"):
            fail("manifest", f"{key} path must start with ./: {target}")
        if ".." in target:
            fail("manifest", f"{key} path must stay inside the plugin: {target}")
        resolved = PLUGIN_ROOT / target
        if not resolved.exists():
            fail("manifest", f"{key} declares {target}, which does not exist")
        if key in ("hooks", "mcpServers") and not target.endswith(".json"):
            fail("manifest", f"{key} must point at a .json file: {target}")

    return manifest


def check_skills() -> set[str]:
    names: set[str] = set()
    for path in sorted(SKILLS.glob("*/SKILL.md")):
        folder = path.parent.name
        fields, error = frontmatter(path)
        if error:
            fail("skills", f"{folder}/SKILL.md: {error}")
            continue
        assert fields is not None
        name = fields.get("name", "")
        names.add(name or folder)

        if not name:
            fail("skills", f"{folder}/SKILL.md: name is missing")
        elif name != folder:
            fail("skills", f"{folder}/SKILL.md: name {name!r} does not match its folder")
        elif not re.fullmatch(r"[a-z0-9-]{1,64}", name):
            fail("skills", f"{folder}/SKILL.md: name {name!r} is not lowercase kebab-case under 64 chars")

        description = fields.get("description", "")
        if not description:
            fail("skills", f"{folder}/SKILL.md: description is missing")
        elif len(description) > 1024:
            fail("skills", f"{folder}/SKILL.md: description is {len(description)} chars, over the 1024 limit")
        elif description[:1] in (">", "|"):
            # The lever once read a block indicator as the value, which yields
            # frontmatter Qoder cannot parse.
            fail("skills", f"{folder}/SKILL.md: description starts with a YAML block indicator")

        for dropped in DROPPED_SKILL_KEYS & set(fields):
            fail("skills", f"{folder}/SKILL.md: carries {dropped!r}, which Qoder skill frontmatter does not support")

        for unknown in set(fields) - {"name", "description"} - DROPPED_SKILL_KEYS:
            warn("skills", f"{folder}/SKILL.md: undocumented frontmatter key {unknown!r}")

    if not names:
        fail("skills", "no SKILL.md found")
    return names


def check_agents() -> set[str]:
    names: set[str] = set()
    colors: dict[str, list[str]] = {}
    for path in sorted(AGENTS.glob("*.md")):
        stem = path.stem
        fields, error = frontmatter(path)
        if error:
            fail("agents", f"{stem}.md: {error}")
            continue
        assert fields is not None
        name = fields.get("name", "")
        names.add(name or stem)

        if name != stem:
            fail("agents", f"{stem}.md: name {name!r} does not match its filename")
        if not fields.get("description"):
            fail("agents", f"{stem}.md: description is missing")

        model = fields.get("model")
        if not model:
            fail("agents", f"{stem}.md: model is missing, so the seat has no routing")
        elif model not in MODEL_ALIASES:
            # Documented as "any model name or model alias", so a concrete name
            # is legal. It just has to exist on the account that installs this.
            warn("agents", f"{stem}.md: model {model!r} is not a documented alias, so it must exist on the account")

        effort = fields.get("effort")
        if effort and effort not in EFFORTS and not effort.isdigit():
            fail("agents", f"{stem}.md: effort {effort!r} is not one of {sorted(EFFORTS)} or a positive integer")

        color = fields.get("color")
        if color:
            if color not in AGENT_COLORS:
                fail("agents", f"{stem}.md: color {color!r} is not one of {sorted(AGENT_COLORS)}")
            colors.setdefault(color, []).append(stem)

        for unsafe in PLUGIN_UNSAFE_AGENT_KEYS & set(fields):
            fail("agents", f"{stem}.md: plugin agents may not set {unsafe!r}")

        isolation = fields.get("isolation")
        if isolation and isolation != "worktree":
            fail("agents", f"{stem}.md: isolation {isolation!r} is not supported for plugin agents")

        for field in ("tools", "disallowedTools"):
            for tool in list_field(fields.get(field, "")):
                if not is_valid_tool(tool):
                    warn("agents", f"{stem}.md: {field} names {tool!r}, which is not a documented Qoder tool")

    if not names:
        fail("agents", "no agent files found")

    # One warning, not one per pair. At ten agents a shared color was an
    # accident worth naming individually. At twenty-eight the enterprise roster
    # colors by family, so five of the eight palette colors carry a whole family
    # plus the pstack seats that already used them, and per-pair output buries
    # the one thing a reader needs to know.
    shared = {color: sorted(stems) for color, stems in colors.items() if len(stems) > 1}
    if shared:
        detail = "; ".join(f"{color} ({', '.join(stems)})" for color, stems in sorted(shared.items()))
        warn(
            "agents",
            f"{len(shared)} of {len(AGENT_COLORS)} colors are shared across "
            f"{sum(len(stems) for stems in shared.values())} agents, which is forced once agents "
            f"outnumber the palette and deliberate for the ent- families, where color reads as "
            f"family rather than as seat: {detail}",
        )
    return names


def check_rules() -> None:
    for path in sorted(RULES.glob("*.md")):
        fields, error = frontmatter(path)
        if error:
            fail("rules", f"{path.name}: {error}")
            continue
        assert fields is not None
        trigger = fields.get("trigger")
        if trigger not in RULE_TRIGGERS:
            fail("rules", f"{path.name}: trigger {trigger!r} is not one of {sorted(RULE_TRIGGERS)}")
        if trigger == "model_decision" and not fields.get("description"):
            fail("rules", f"{path.name}: model_decision needs a description for the model to match on")
        if trigger == "glob" and not fields.get("glob"):
            fail("rules", f"{path.name}: glob trigger needs a glob pattern")


def check_links() -> None:
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        text = strip_code_fences(path.read_text(encoding="utf-8"))
        for target in MD_LINK_RE.findall(text):
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            resolved = (path.parent / target.split("#")[0]).resolve()
            if not resolved.exists():
                line = text[: text.find(target)].count("\n") + 1
                fail("links", f"{path.relative_to(PLUGIN_ROOT)}:{line}: {target} does not resolve")


def check_seats(agent_names: set[str]) -> None:
    """Every seat a skill names must exist, or dispatch fails at runtime."""
    # A rule file is named the same way a seat is, and rules/pstack-seats.md
    # holds the catalog itself. Reading the stems off disk keeps this from going
    # stale the day someone adds a rule.
    rule_stems = {path.stem for path in RULES.glob("*.md")}
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        if rel.startswith("scripts/"):
            continue
        text = path.read_text(encoding="utf-8")
        for regex in (SEAT_RE, SUBAGENT_RE):
            for seat in set(regex.findall(text)):
                if seat in rule_stems:
                    continue
                if seat not in agent_names:
                    fail("seats", f"{rel}: names {seat!r}, which is not in agents/")


def skill_root(path: Path) -> Path | None:
    """The skill folder a path lives under, or None outside `skills/`."""
    try:
        return SKILLS / path.relative_to(SKILLS).parts[0]
    except ValueError:
        return None


def check_bare_paths() -> None:
    """Resolve every backticked relative path in the shipped prose.

    Instructions reach their files three ways: from the file's own folder, from
    the skill folder when a playbook names a sibling as `playbooks/x.md`, and
    from the plugin root when a rule or manifest is named. A path that resolves
    under none of the three sends the model somewhere empty.
    """
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        if rel.startswith("scripts/"):
            continue
        bases = [path.parent]
        root = skill_root(path)
        if root is not None:
            bases.append(root)
        bases.append(PLUGIN_ROOT)

        text = path.read_text(encoding="utf-8")
        for target in sorted(set(BARE_PATH_RE.findall(text))):
            if target.startswith(BARE_PATH_SKIPS):
                continue
            if not any((base / target).resolve().exists() for base in bases):
                line = text[: text.find(f"`{target}`")].count("\n") + 1
                fail("paths", f"{rel}:{line}: `{target}` resolves under no base")


def kebab(title: str) -> str:
    """Fold a playbook title the way poteto-mode folds it at runtime."""
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", title.lower())).strip("-")


def playbook_titles(text: str) -> list[str]:
    """Read the orchestrator's title list, which is what it actually routes from.

    poteto-mode enumerates its playbooks as human titles and kebab-cases them
    into `playbooks/<title>.md` when it routes. Matching on literal paths
    instead reported 20 of the 22 as orphaned. A title list is one line of
    three or more comma-separated capitalized names, ending in a period.
    """
    for line in text.split("\n"):
        line = line.strip()
        if not line.endswith(".") or "," not in line:
            continue
        parts = [part.strip() for part in line[:-1].split(",")]
        if len(parts) < 3:
            continue
        if all(re.fullmatch(r"[A-Z][A-Za-z0-9' -]*", part) for part in parts):
            return [kebab(part) for part in parts]
    return []


def check_playbooks() -> list[str]:
    """Every playbook the orchestrator routes to must exist, and none be orphaned."""
    entry = SKILLS / "poteto-mode" / "SKILL.md"
    if not entry.is_file():
        fail("workflow", "skills/poteto-mode/SKILL.md is missing")
        return []

    routed = playbook_titles(entry.read_text(encoding="utf-8"))
    if not routed:
        fail("workflow", "poteto-mode names no playbook titles, so it cannot route a task")

    on_disk = {path.stem for path in (SKILLS / "poteto-mode" / "playbooks").glob("*.md")}
    for title in routed:
        if title not in on_disk:
            fail("workflow", f"poteto-mode routes to playbooks/{title}.md, which does not exist")
    for orphan in sorted(on_disk - set(routed)):
        warn("workflow", f"playbooks/{orphan}.md exists but poteto-mode never routes to it")

    return routed


def check_enterprise(agent_names: set[str]) -> None:
    """Reachability of the enterprise roster, and of the chains that route to it.

    Two failures this catches that nothing else does. An `ent-` agent no playbook
    and no rule names ships unreachable, since the orchestrator picks seats from
    prose and cannot dispatch what nothing mentions. And a composition chain that
    names a playbook title the router does not fold to a file sends the
    orchestrator to an empty path mid-chain, which is worse than having no chain.
    """
    ent_agents = {name for name in agent_names if name.startswith("ent-")}
    if not ent_agents:
        warn("enterprise", "no ent- agents found, so the enterprise roster is empty")
        return

    # Playbooks and rules are where a seat gets named. The orchestrator's own
    # SKILL.md counts too, since it dispatches some seats directly.
    sources: list[tuple[str, str]] = []
    entry = SKILLS / "poteto-mode" / "SKILL.md"
    if entry.is_file():
        sources.append(("skills/poteto-mode/SKILL.md", entry.read_text(encoding="utf-8")))
    for path in sorted((SKILLS / "poteto-mode" / "playbooks").glob("*.md")):
        sources.append((f"playbooks/{path.name}", path.read_text(encoding="utf-8")))
    for path in sorted(RULES.glob("*.md")):
        sources.append((f"rules/{path.name}", path.read_text(encoding="utf-8")))

    named: dict[str, list[str]] = {}
    for rel, text in sources:
        for seat in set(ENT_SEAT_RE.findall(text)):
            named.setdefault(seat, []).append(rel)
            if seat not in ent_agents:
                fail("enterprise", f"{rel}: dispatches {seat!r}, which has no agent file")

    for orphan in sorted(ent_agents - set(named)):
        fail(
            "enterprise",
            f"agents/{orphan}.md is named by no playbook and no rule, so the orchestrator "
            "can never pick it and the seat ships unreachable",
        )

    # Every bolded title in the composition chains table has to fold to a real
    # playbook. Scoped to that section, because bold is used for skill names
    # elsewhere in the file and those are not playbooks.
    if not entry.is_file():
        return
    text = entry.read_text(encoding="utf-8")
    start = text.find("### Composition chains")
    if start < 0:
        fail("enterprise", "poteto-mode has no composition chains section, so it cannot route an enterprise task")
        return
    rest = text[start + len("### Composition chains"):]
    stop = next((i for i in (rest.find("\n### "), rest.find("\n## ")) if i >= 0), len(rest))
    block = rest[:stop]

    on_disk = {path.stem for path in (SKILLS / "poteto-mode" / "playbooks").glob("*.md")}
    chain_steps = set()
    for title in re.findall(r"\*\*([^*]+)\*\*", block):
        folded = kebab(title)
        chain_steps.add(folded)
        if folded not in on_disk:
            fail("enterprise", f"composition chains name {title!r}, but playbooks/{folded}.md does not exist")
    if not chain_steps:
        fail("enterprise", "the composition chains section names no playbook, so it routes nothing")

    print("\nenterprise roster")
    print(f"  ent- agents  {len(ent_agents)}")
    print(f"  reachable    {len(ent_agents & set(named))}")
    print(f"  chain steps  {len(chain_steps)} playbooks named by a composition chain")


def check_workflow(agent_names: set[str]) -> None:
    """Trace the workflows the port was asked to preserve, orchestrator to seat."""
    expected = {
        "poteto-mode": ["poteto-agent"],
        "architect": ["pstack-architect"],
        "arena": ["pstack-panel-1", "pstack-panel-2", "pstack-panel-3", "pstack-judge"],
        "swarm": ["pstack-verifier", "pstack-explorer", "poteto-agent"],
        "interrogate": ["pstack-panel-1", "pstack-panel-2", "pstack-panel-3"],
        "how": ["pstack-explorer"],
        "no-comments": ["comment-sicko"],
    }
    print("\nworkflow trace (skill -> seats it dispatches)")
    for skill, seats in expected.items():
        path = SKILLS / skill / "SKILL.md"
        if not path.is_file():
            fail("workflow", f"{skill}/SKILL.md is missing")
            continue
        text = path.read_text(encoding="utf-8")
        missing = [seat for seat in seats if seat not in text]
        for seat in missing:
            fail("workflow", f"{skill} never dispatches {seat}, so the seat is unreachable from it")
        print(f"  /{skill:<12} -> {', '.join(seats)}")

    for skill in ("tdd", "why", "unslop"):
        if not (SKILLS / skill / "SKILL.md").is_file():
            fail("workflow", f"{skill}/SKILL.md is missing")
        else:
            print(f"  /{skill:<12} -> runs inline, dispatches no seat")

    unknown = {s for seats in expected.values() for s in seats} - agent_names
    for seat in sorted(unknown):
        fail("workflow", f"seat {seat!r} has no agent file")


def check_cursorisms() -> None:
    """Reuse the lever's own gate, so the two checks cannot drift apart."""
    lever = SCRIPTS / "port-from-upstream.py"
    if not lever.is_file():
        warn("gate", "scripts/port-from-upstream.py is missing, so the gate could not run")
        return
    spec = importlib.util.spec_from_file_location("port_lever", lever)
    if spec is None or spec.loader is None:
        warn("gate", "could not import the port lever")
        return
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    hits: list[str] = []
    for path in sorted(PLUGIN_ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in module.GATE_SUFFIXES:
            continue
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        if rel in module.GATE_SKIPS or rel.startswith(tuple(module.GATE_SKIP_PREFIXES)):
            continue
        module.gate(rel, path.read_text(encoding="utf-8"), hits)
    for hit in hits:
        fail("gate", hit)


def check_hooks() -> int:
    """Static shape of the enterprise gate hooks.

    The behavioural half lives in `scripts/test-gates.py`, which drives the real
    entry points with recorded events. This catches what that cannot: a config
    Qoder refuses to load, an event name that silently never fires, and a script
    that is present but not executable, which fails quietly at the exact moment
    a gate is supposed to hold.
    """
    config_path = HOOKS / "enterprise-gates.json"
    if not config_path.is_file():
        fail("hooks", "hooks/enterprise-gates.json is missing")
        return 0
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail("hooks", f"enterprise-gates.json is not valid JSON: {exc}")
        return 0

    events = config.get("hooks")
    if not isinstance(events, dict) or not events:
        fail("hooks", "enterprise-gates.json has no 'hooks' object")
        return 0

    scripts: set[Path] = set()
    for event, groups in events.items():
        if event not in HOOK_EVENTS:
            fail("hooks", f"{event!r} is not a documented Qoder hook event")
            continue
        if not isinstance(groups, list):
            fail("hooks", f"{event} must hold a list of matcher groups")
            continue
        for group in groups:
            if not isinstance(group, dict):
                fail("hooks", f"{event} has a group that is not an object")
                continue
            entries = group.get("hooks")
            if not isinstance(entries, list) or not entries:
                fail("hooks", f"{event} has a group with no hooks array")
                continue
            for entry in entries:
                name = entry.get("name") or event
                if entry.get("type") != "command":
                    fail("hooks", f"{name}: only 'command' hooks are used here, got {entry.get('type')!r}")
                command = entry.get("command")
                if not isinstance(command, str) or not command.strip():
                    fail("hooks", f"{name}: no command")
                    continue

                # Qoder exports these as environment variables and the shell
                # expands them at run time, so a placeholder outside a quoted
                # span splits the command on any space in the install path. The
                # useful form quotes the whole path, not the placeholder alone,
                # so blank out every quoted span and see whether a placeholder
                # survives outside one.
                outside = re.sub(r'"[^"]*"', '""', command)
                stray = re.findall(r"\$\{(QODER_[A-Z_]+)\}", outside)
                if stray:
                    fail(
                        "hooks",
                        f"{name}: ${{{stray[0]}}} is not inside double quotes: {command}",
                    )

                match = re.search(r'\$\{QODER_PLUGIN_ROOT\}/([^"\s]+)', command)
                if not match:
                    fail("hooks", f"{name}: command does not resolve through QODER_PLUGIN_ROOT")
                    continue
                target = PLUGIN_ROOT / match.group(1)
                if not target.is_file():
                    fail("hooks", f"{name}: {match.group(1)} does not exist")
                    continue
                if not os.access(target, os.X_OK):
                    fail("hooks", f"{name}: {match.group(1)} is not executable, so the hook cannot run")
                scripts.add(target)

    # Both enforcement points rest on exit 2 actually blocking. PreToolUse has to
    # stop the command, and SubagentStop has to keep the seat running long enough
    # to report an ungated action. If Qoder ever drops blocking from either, the
    # gates become advice, and this fails instead of letting the port go on
    # describing them as enforcement.
    for event in ("PreToolUse", "SubagentStop"):
        if event in events and event not in BLOCKING_EVENTS:
            fail(
                "hooks",
                f"{event} no longer supports blocking, so the gates are advice "
                "rather than enforcement",
            )

    # A gate that cannot be turned off per repo is not portable, and a gate that
    # runs everywhere the plugin is installed is a surprise nobody asked for. The
    # dormancy test has to come before the interpreter starts, or a repo with no
    # policy pays for a gate it never enabled.
    gate_sh = HOOKS / "scripts" / "gate-check.sh"
    if gate_sh.is_file():
        text = gate_sh.read_text(encoding="utf-8")
        policy_at = text.find(".qoder/enterprise/gates.json")
        python_at = text.find("python3")
        if policy_at < 0:
            fail("hooks", "gate-check.sh never tests for the project policy file, so it cannot stay dormant")
        elif python_at >= 0 and policy_at > python_at:
            fail("hooks", "gate-check.sh starts python3 before the dormancy test")
    else:
        fail("hooks", "hooks/scripts/gate-check.sh is missing")

    module = HOOKS / "scripts" / "enterprise_hooks.py"
    if module.is_file():
        text = module.read_text(encoding="utf-8")
        # Qoder rejects the whole output blob when this field is missing, and it
        # rejects it at the moment the gate is trying to hold.
        if "hookEventName" not in text:
            fail("hooks", "enterprise_hooks.py never sets hookEventName, so Qoder would reject every decision")
        # SubagentStop blocking keeps the seat running. Without this guard the
        # same log blocks the same seat forever.
        if "stop_hook_active" not in text:
            fail("hooks", "enterprise_hooks.py ignores stop_hook_active, so the backstop can loop")
    else:
        fail("hooks", "hooks/scripts/enterprise_hooks.py is missing")

    return len(scripts)


def check_junk() -> None:
    for banned in BANNED_ROOT_DIRS:
        if (PLUGIN_ROOT / banned).exists():
            fail("package", f"{banned}/ at the plugin root competes with .qoder-plugin/")
    for path in PLUGIN_ROOT.rglob("*"):
        if path.name in JUNK_NAMES or path.suffix in (".pyc", ".rar"):
            fail("package", f"{path.relative_to(PLUGIN_ROOT)} is local state and must not ship")


def main() -> int:
    print(f"plugin: {PLUGIN_ROOT}")

    manifest = check_manifest()
    skill_names = check_skills()
    agent_names = check_agents()
    check_rules()
    check_links()
    check_bare_paths()
    check_seats(agent_names)
    playbooks = check_playbooks()
    check_enterprise(agent_names)
    check_workflow(agent_names)
    check_cursorisms()
    hook_scripts = check_hooks()
    check_junk()

    print("\ncounts")
    print(f"  manifest   {manifest.get('name', '?')} v{manifest.get('version', '?')}")
    print(f"  skills     {len(skill_names)}")
    print(f"  agents     {len(agent_names)}")
    print(f"  playbooks  {len(playbooks)} routed")
    print(f"  hook scripts {hook_scripts}")

    if warnings:
        print(f"\nWARNINGS ({len(warnings)})")
        for item in warnings:
            print(f"  {item}")

    if failures:
        print(f"\nFAILURES ({len(failures)})")
        for item in failures:
            print(f"  {item}")
        return 1

    print("\nPASS: the port is internally consistent and statically conformant")
    print("Not proven here: that Qoder dispatches a seat at runtime. Run")
    print("scripts/selftest.sh on a machine with qodercli for that half.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
