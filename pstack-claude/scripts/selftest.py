#!/usr/bin/env python3
"""Static conformance for the Claude Code edition of pstack.

Checks the plugin against the formats Claude Code documents for plugins,
subagents, skills, and hooks, then traces the workflows and the enterprise
roster the port was asked to preserve. Needs nothing but Python 3.

What it cannot prove is that a live session dispatches a seat or fires a hook.
`claude plugin validate .` and one real session cover that half; README.md says
how.

Usage:
    python3 scripts/selftest.py
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = PLUGIN_ROOT / "scripts"
SKILLS = PLUGIN_ROOT / "skills"
AGENTS = PLUGIN_ROOT / "agents"
HOOKS = PLUGIN_ROOT / "hooks"

# Documented at code.claude.com/docs/en/plugins-reference (manifest) and
# plugin-marketplaces (marketplace entries).
MANIFEST_KEYS = {
    "$schema", "name", "version", "description", "author", "homepage", "repository", "license",
    "keywords", "commands", "agents", "skills", "hooks", "mcpServers", "outputStyles", "lspServers",
}
# code.claude.com/docs/en/sub-agents, supported frontmatter fields.
AGENT_KEYS = {
    "name", "description", "tools", "disallowedTools", "model", "effort", "permissionMode",
    "isolation", "color", "background", "maxTurns", "autoCompactWindow", "skills", "mcpServers",
    "hooks", "memory", "omitClaudeMd", "initialPrompt", "experimental",
}
# Ignored when the agent ships in a plugin, so shipping one implies a lie.
PLUGIN_IGNORED_AGENT_KEYS = {"hooks", "mcpServers", "permissionMode", "initialPrompt"}
AGENT_MODELS = {"opus", "sonnet", "haiku", "fable", "inherit"}
EFFORTS = {"low", "medium", "high", "xhigh", "max"}
AGENT_COLORS = {"red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"}
# code.claude.com/docs/en/skills, frontmatter fields.
SKILL_KEYS = {
    "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation",
    "user-invocable", "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent",
    "background", "hooks", "paths", "shell", "metadata", "license", "compatibility",
}
DESCRIPTION_LIMIT = 1536
KNOWN_TOOLS = {
    "Agent", "Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "TodoWrite", "WebFetch",
    "WebSearch", "Write", "AskUserQuestion", "Skill",
}
# The skills that stay model-invocable: the three references converted from
# Qoder model_decision rules, the two enterprise skills the Qoder port wrote,
# and setup-pstack, which upstream also leaves model-invocable.
MODEL_INVOCABLE = {"pstack-seats", "enterprise-seats", "enterprise-gates", "prd-rules", "setup-enterprise", "setup-pstack"}
READ_ONLY_SEATS = {"pstack-judge", "pstack-explorer", "comment-sicko", "ent-code-reviewer", "ent-security-engineer"}
ENTERPRISE_PLAYBOOKS = {
    "api-contract-design", "architecture-design", "architecture-review", "database-migration",
    "enterprise-bug-fix", "enterprise-feature-development", "enterprise-release-management",
    "integration-testing", "prd-creation", "production-incident-management", "requirements-analysis",
    "security-assessment",
}
JUNK_NAMES = {".DS_Store", "__MACOSX", "settings.local.json", ".pytest_cache", "__pycache__"}

SCOPED_SEAT_RE = re.compile(r"pstack:([a-z0-9-]+)(?![a-z0-9*<-])")
SUBAGENT_RE = re.compile(r"subagent_type:\s*\"?([A-Za-z0-9_:<>-]+)\"?")
BARE_SEAT_RE = re.compile(r"(?<![:\w/-])`((?:pstack-(?:architect|explorer|judge|mechanic|verifier|panel-[123]))|poteto-agent|comment-sicko|ent-[a-z-]+)`")
MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")

FAILURES: list[str] = []
WARNINGS: list[str] = []


def fail(check: str, message: str) -> None:
    FAILURES.append(f"[{check}] {message}")


def warn(check: str, message: str) -> None:
    WARNINGS.append(f"[{check}] {message}")


def frontmatter(path: Path) -> tuple[dict[str, str] | None, str | None]:
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
        fields[key] = "" if value in (">", ">-", "|", "|-", "|+") else value.strip("\"'")
    return fields, None


def list_field(value: str) -> list[str]:
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return [item.strip().strip("\"'") for item in value.split(",") if item.strip()]


def strip_code_fences(text: str) -> str:
    out, fenced = [], False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            out.append("")
            continue
        out.append("" if fenced else line)
    return "\n".join(out)


def shipped_markdown() -> list[Path]:
    return [p for p in sorted(PLUGIN_ROOT.rglob("*.md"))
            if ".git" not in p.parts and not p.relative_to(PLUGIN_ROOT).as_posix().startswith("scripts/")]


# ---------------------------------------------------------------------------


def check_manifest() -> None:
    path = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("manifest", f"{path.name}: {exc}")
        return
    for key in set(manifest) - MANIFEST_KEYS:
        fail("manifest", f"plugin.json key {key!r} is not a documented manifest field")
    if manifest.get("name") != "pstack":
        fail("manifest", "plugin name must be pstack, since every seat dispatches as pstack:<seat>")
    if manifest.get("author", {}).get("name") != "Lauren Tan":
        fail("manifest", "author must stay Lauren Tan")
    if manifest.get("license") != "MIT" or not (PLUGIN_ROOT / "LICENSE").is_file():
        fail("manifest", "MIT license and LICENSE file must ship")
    for qoder_only in (".qoder-plugin", "rules"):
        if (PLUGIN_ROOT / qoder_only).exists():
            fail("manifest", f"{qoder_only}/ is a Qoder component directory and must not ship")

    market_path = PLUGIN_ROOT / ".claude-plugin" / "marketplace.json"
    try:
        market = json.loads(market_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("marketplace", f"{market_path.name}: {exc}")
        return
    for key in ("name", "owner", "plugins"):
        if key not in market:
            fail("marketplace", f"marketplace.json lacks required {key!r}")
    entries = [p for p in market.get("plugins", []) if p.get("name") == manifest.get("name")]
    if len(entries) != 1:
        fail("marketplace", "marketplace.json must list exactly one entry named like plugin.json")
    elif entries[0].get("source") != "./":
        fail("marketplace", "the pstack entry's source must be ./ (the plugin is the marketplace root)")
    elif entries[0].get("version") not in (None, manifest.get("version")):
        fail("marketplace", "marketplace entry version disagrees with plugin.json")
    print(f"manifest     pstack {manifest.get('version')}, marketplace {market.get('name')}")


def check_skills() -> set[str]:
    names = set()
    manual = 0
    for skill_dir in sorted(p for p in SKILLS.iterdir() if p.is_dir()):
        path = skill_dir / "SKILL.md"
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        if not path.is_file():
            fail("skills", f"{skill_dir.name}/ has no SKILL.md")
            continue
        fields, error = frontmatter(path)
        if error or fields is None:
            fail("skills", f"{rel}: {error}")
            continue
        for key in set(fields) - SKILL_KEYS:
            fail("skills", f"{rel}: frontmatter key {key!r} is not a Claude Code skill field")
        if fields.get("name") != skill_dir.name:
            fail("skills", f"{rel}: name {fields.get('name')!r} differs from its folder")
        description = fields.get("description", "")
        if not description:
            fail("skills", f"{rel}: no description, so Claude Code has nothing to match on")
        if len(description) > DESCRIPTION_LIMIT:
            fail("skills", f"{rel}: description is {len(description)} chars, over the {DESCRIPTION_LIMIT} listing limit")
        is_manual = fields.get("disable-model-invocation") == "true"
        manual += is_manual
        if skill_dir.name in MODEL_INVOCABLE and is_manual:
            fail("skills", f"{rel}: must stay model-invocable, it replaces an on-demand rule or is setup")
        if is_manual and "${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md" not in path.read_text(encoding="utf-8"):
            fail("skills", f"{rel}: manual-only but carries no note on how to reach other pstack skills")
        names.add(skill_dir.name)
    print(f"skills       {len(names)} ({manual} manual-only, {len(names) - manual} model-invocable)")
    return names


def check_agents() -> set[str]:
    names = set()
    colors: dict[str, list[str]] = {}
    for path in sorted(AGENTS.glob("*.md")):
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        fields, error = frontmatter(path)
        if error or fields is None:
            fail("agents", f"{rel}: {error}")
            continue
        for key in set(fields) - AGENT_KEYS:
            fail("agents", f"{rel}: frontmatter key {key!r} is not a Claude Code subagent field")
        for key in set(fields) & PLUGIN_IGNORED_AGENT_KEYS:
            fail("agents", f"{rel}: {key!r} is ignored for plugin subagents")
        name = fields.get("name", "")
        if name != path.stem or ":" in name:
            fail("agents", f"{rel}: name {name!r} must equal the file stem and hold no colon")
        if fields.get("model") not in AGENT_MODELS:
            fail("agents", f"{rel}: model {fields.get('model')!r} is not one of {sorted(AGENT_MODELS)}")
        if fields.get("effort") not in EFFORTS:
            fail("agents", f"{rel}: effort {fields.get('effort')!r} is not a documented level")
        if "isolation" in fields and fields["isolation"] != "worktree":
            fail("agents", f"{rel}: isolation only takes worktree")
        color = fields.get("color")
        if color not in AGENT_COLORS:
            fail("agents", f"{rel}: color {color!r} is not in the documented palette")
        colors.setdefault(str(color), []).append(name)
        tools = list_field(fields.get("tools", ""))
        denied = list_field(fields.get("disallowedTools", ""))
        for tool in tools + denied:
            if tool not in KNOWN_TOOLS and not tool.startswith("mcp__"):
                fail("agents", f"{rel}: tool {tool!r} is not a known Claude Code tool")
        if name.startswith("ent-") and "Agent" not in denied:
            fail("agents", f"{rel}: enterprise seats must deny Agent, so no seat drives the workflow")
        if name in READ_ONLY_SEATS and ({"Write", "Edit"} & set(tools)):
            fail("agents", f"{rel}: read-only seat holds a write tool")
        if "## Qoder" in path.read_text(encoding="utf-8"):
            fail("agents", f"{rel}: still carries a Qoder section")
        names.add(name)
    shared = sorted(c for c, seats in colors.items() if len(seats) > 1)
    if shared:
        warn("agents", f"{len(names)} agents over 8 colors, so {len(shared)} colors are shared ({', '.join(shared)}). Cosmetic.")
    print(f"agents       {len(names)} ({sum(n.startswith('ent-') for n in names)} enterprise)")
    return names


def check_links() -> None:
    for path in shipped_markdown():
        text = strip_code_fences(path.read_text(encoding="utf-8"))
        for target in MD_LINK_RE.findall(text):
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            if not (path.parent / target.split("#")[0]).resolve().exists():
                line = text[: text.find(target)].count("\n") + 1
                fail("links", f"{path.relative_to(PLUGIN_ROOT)}:{line}: {target} does not resolve")


def check_seat_references(agent_names: set[str]) -> None:
    """Every dispatch target exists and is scoped, or the Agent call misses.

    Runtime files only. The provenance documents quote the Qoder names on
    purpose, to say what was renamed.
    """
    provenance = {"README.md", "COMPATIBILITY.md", "PORTING-NOTES.md", "CONNECTORS.md",
                  "PROGRESS.md", "docs/MODEL-ROUTING.md"}
    for path in shipped_markdown():
        rel = path.relative_to(PLUGIN_ROOT).as_posix()
        if rel in provenance:
            continue
        text = path.read_text(encoding="utf-8")
        for seat in set(SCOPED_SEAT_RE.findall(text)):
            if seat in agent_names or seat in {"poteto-mode", "setup-pstack", "setup-enterprise", "prd-rules"}:
                continue
            if (SKILLS / seat).is_dir():
                continue
            fail("seats", f"{rel}: names pstack:{seat}, which is neither an agent nor a skill")
        for target in set(SUBAGENT_RE.findall(text)):
            if target in {"general-purpose", "Explore", "pstack:<seat>"}:
                continue
            if not target.startswith("pstack:") or target[len("pstack:"):] not in agent_names:
                fail("seats", f"{rel}: subagent_type {target!r} is not a scoped pstack seat")
        for seat in set(BARE_SEAT_RE.findall(text)):
            fail("seats", f"{rel}: bare `{seat}` would not resolve as a subagent_type; scope it as pstack:{seat}")


def kebab(title: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", title.lower())).strip("-")


def playbook_titles(text: str) -> list[str]:
    for line in text.split("\n"):
        line = line.strip()
        if not line.endswith(".") or "," not in line:
            continue
        parts = [part.strip() for part in line[:-1].split(",")]
        if len(parts) >= 3 and all(re.fullmatch(r"[A-Z][A-Za-z0-9' -]*", part) for part in parts):
            return [kebab(part) for part in parts]
    return []


def check_playbooks() -> None:
    entry = SKILLS / "poteto-mode" / "SKILL.md"
    routed = playbook_titles(entry.read_text(encoding="utf-8"))
    on_disk = {p.stem for p in (SKILLS / "poteto-mode" / "playbooks").glob("*.md")}
    if not routed:
        fail("playbooks", "poteto-mode names no playbook titles, so it cannot route a task")
    for title in routed:
        if title not in on_disk:
            fail("playbooks", f"poteto-mode routes to playbooks/{title}.md, which does not exist")
    for orphan in sorted(on_disk - set(routed)):
        fail("playbooks", f"playbooks/{orphan}.md exists but poteto-mode never routes to it")
    for missing in sorted(ENTERPRISE_PLAYBOOKS - on_disk):
        fail("playbooks", f"enterprise playbook {missing}.md is missing")
    print(f"playbooks    {len(routed)} routed, {len(on_disk)} on disk, {len(ENTERPRISE_PLAYBOOKS & on_disk)} enterprise")


def check_enterprise(agent_names: set[str]) -> None:
    ent = {n for n in agent_names if n.startswith("ent-")}
    if len(ent) != 18:
        fail("enterprise", f"expected 18 ent- seats, found {len(ent)}")
    sources = [SKILLS / "poteto-mode" / "SKILL.md", SKILLS / "enterprise-seats" / "SKILL.md"]
    sources += sorted((SKILLS / "poteto-mode" / "playbooks").glob("*.md"))
    named = set()
    for path in sources:
        named |= {s for s in SCOPED_SEAT_RE.findall(path.read_text(encoding="utf-8")) if s.startswith("ent-")}
    for orphan in sorted(ent - named):
        fail("enterprise", f"agents/{orphan}.md is named by no playbook and no seat reference, so it ships unreachable")
    text = (SKILLS / "poteto-mode" / "SKILL.md").read_text(encoding="utf-8")
    start = text.find("### Composition chains")
    if start < 0:
        fail("enterprise", "poteto-mode lost its composition chains section")
    else:
        rest = text[start + 24:]
        stop = next((i for i in (rest.find("\n### "), rest.find("\n## ")) if i >= 0), len(rest))
        on_disk = {p.stem for p in (SKILLS / "poteto-mode" / "playbooks").glob("*.md")}
        for title in re.findall(r"\*\*([^*]+)\*\*", rest[:stop]):
            if kebab(title) not in on_disk:
                fail("enterprise", f"composition chain names {title!r}, but playbooks/{kebab(title)}.md is missing")
    for skill in ("enterprise-gates", "enterprise-seats", "pstack-seats", "prd-rules", "setup-enterprise"):
        if not (SKILLS / skill / "SKILL.md").is_file():
            fail("enterprise", f"skills/{skill}/SKILL.md is missing")
    for doc in ("docs/ENTERPRISE-ARCHITECTURE.md", "docs/MODEL-ROUTING.md"):
        if not (PLUGIN_ROOT / doc).is_file():
            fail("enterprise", f"{doc} is missing")
    print(f"enterprise   {len(ent)} seats, {len(ent & named)} reachable")


def check_workflow(agent_names: set[str]) -> None:
    expected = {
        "poteto-mode": ["poteto-agent"],
        "architect": ["pstack-architect"],
        "arena": ["pstack-panel-1", "pstack-panel-2", "pstack-panel-3", "pstack-judge"],
        "swarm": ["pstack-verifier", "pstack-explorer", "poteto-agent"],
        "interrogate": ["pstack-panel-1", "pstack-panel-2", "pstack-panel-3"],
        "how": ["pstack-explorer"],
        "no-comments": ["comment-sicko"],
    }
    print("workflow     skill -> seats it dispatches")
    for skill, seats in expected.items():
        text = (SKILLS / skill / "SKILL.md").read_text(encoding="utf-8")
        for seat in seats:
            if f"pstack:{seat}" not in text:
                fail("workflow", f"{skill} never dispatches pstack:{seat}")
            if seat not in agent_names:
                fail("workflow", f"seat {seat} has no agent file")
        print(f"  /pstack:{skill:<12} -> {', '.join('pstack:' + s for s in seats)}")
    # Every skill that dispatches a configured seat has to say where the
    # per-call model and effort come from.
    for skill in ("poteto-mode", "arena", "swarm", "pstack-seats", "setup-pstack"):
        if "~/.claude/rules/pstack-models.md" not in (SKILLS / skill / "SKILL.md").read_text(encoding="utf-8"):
            fail("workflow", f"{skill} never names ~/.claude/rules/pstack-models.md, so overrides cannot reach its seats")


def check_hooks() -> None:
    try:
        manifest = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("hooks", f"hooks/hooks.json: {exc}")
        return
    events = manifest.get("hooks", {})
    for event in ("PreToolUse", "PostToolUse", "SubagentStop"):
        if event not in events:
            fail("hooks", f"hooks.json lost its {event} hook")
    count = sum(len(g.get("hooks", [])) for groups in events.values() for g in groups)
    text = (HOOKS / "scripts" / "enterprise_hooks.py").read_text(encoding="utf-8")
    for needle in ('".claude/enterprise/gates.json"', '"CLAUDE_PROJECT_DIR"', '"permissionDecision": "ask"'):
        if needle not in text:
            fail("hooks", f"enterprise_hooks.py lost {needle}")
    print(f"hooks        {count} handlers on {', '.join(sorted(events))}")


def check_gate() -> None:
    """Reuse the lever's own gate, so the two checks cannot drift apart."""
    spec = importlib.util.spec_from_file_location("port_lever", SCRIPTS / "port-from-qoder.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    failures: list[str] = []
    module.gate_tree(failures)
    for failure in failures:
        fail("gate", failure)
    print(f"gate         {'clean' if not failures else str(len(failures)) + ' failures'}")


def check_junk() -> None:
    for path in PLUGIN_ROOT.rglob("*"):
        if ".git" in path.parts:
            continue
        if path.name in JUNK_NAMES:
            fail("junk", f"{path.relative_to(PLUGIN_ROOT)} must not ship")


def main() -> int:
    print(f"plugin: {PLUGIN_ROOT}\n")
    check_manifest()
    check_skills()
    agents = check_agents()
    check_links()
    check_seat_references(agents)
    check_playbooks()
    check_enterprise(agents)
    check_workflow(agents)
    check_hooks()
    check_gate()
    check_junk()
    print()
    for item in WARNINGS:
        print(f"  warn    {item}")
    if FAILURES:
        print(f"\nFAILURES ({len(FAILURES)})")
        for item in FAILURES:
            print(f"  {item}")
        return 1
    print(f"selftest: PASS, 0 failures, {len(WARNINGS)} warnings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
