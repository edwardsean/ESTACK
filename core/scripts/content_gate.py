"""The content gate: no em or en dashes anywhere, and no vendor coupling in
runtime files. Extracted from the retired Qoder-to-Claude-Code lever so the
selftest keeps the same rules. Dashes are written as escapes so this file
passes its own gate."""

from __future__ import annotations

import re
from pathlib import Path

STYLE_PATTERNS = [
    (r"\u2014", "em dash, forbidden by the unslop rule 13 this plugin ships"),
    (r"\u2013", "en dash, forbidden by the unslop rule 13 this plugin ships"),
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
    "CONNECTORS.md",
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


def gate_tree(root: Path, failures: list[str]) -> None:
    for path in sorted(root.rglob("*")):
        if ".git" in path.parts or not path.is_file() or path.suffix not in GATE_SUFFIXES:
            continue
        gate_file(path.relative_to(root).as_posix(), path.read_text(encoding="utf-8"), failures)
