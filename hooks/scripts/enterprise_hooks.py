#!/usr/bin/env python3
"""Enterprise approval gates for the pstack Qoder port.

One module behind two thin shell entry points. It classifies a tool call
against the gate patterns a project opted into, asks a human before a gated
action runs, records what actually ran, and reports a gated action that ran
with no ask behind it.

Qoder hands a hook its event as JSON on stdin and reads the verdict from stdout
plus the exit code. Exit 0 lets stdout be parsed as JSON. Exit 2 blocks and
gives stderr to the agent. Every subcommand here exits 0 except `backstop`,
which exits 2 when it finds an ungated action.

Policy lives in the project rather than in the plugin, so one install serves
many repos with different gate rules. The file is `.claude/enterprise/gates.json`
and `/setup-enterprise` writes it. Nothing here gates a repo that has no such
file, which is what keeps the plugin quiet everywhere else.

Correlation. `tool_use_id` arrives on both PreToolUse and PostToolUse, so an
exec record with no ask record behind it means the action ran without a gate
ever firing. That is the one signal worth escalating, because it is how a
delegated push would slip through if hooks do not reach inside a subagent.
"""

from __future__ import annotations

import copy
import fnmatch
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = 1
CONFIG_RELPATH = Path(".claude/enterprise/gates.json")
DEFAULT_AUDIT_RELPATH = Path(".claude/enterprise/approvals.jsonl")

# What /setup-enterprise writes into a project's gates.json, where it becomes
# editable. The plugin never gates from this table, so a project that deletes a
# class really does lose it rather than falling back to a shipped default.
#
# Patterns lean destructive on purpose. `kubectl get` and a read-only psql query
# are not gated, because a gate that fires on reading is a gate people disable.
DEFAULT_GATES: dict[str, dict[str, Any]] = {
    "push": {
        "enabled": True,
        "label": "git push or open PR",
        "patterns": ["git push *", "gh pr create*", "gh pr merge*", "git push"],
    },
    "deploy": {
        "enabled": True,
        "label": "deploy or infrastructure change",
        "patterns": [
            "*deploy*",
            "kubectl apply*",
            "kubectl delete*",
            "kubectl rollout*",
            "terraform apply*",
            "terraform destroy*",
            "helm install*",
            "helm upgrade*",
            "helm uninstall*",
        ],
    },
    "migration": {
        "enabled": True,
        "label": "database migration or data change",
        "patterns": [
            "*migrate*",
            "*migration*",
            "*seed*",
            "alembic upgrade*",
            "prisma migrate*",
            "flyway migrate*",
            "psql * -c *",
            "mysql * -e *",
        ],
    },
}


def default_config() -> dict[str, Any]:
    """The config /setup-enterprise writes on a first run.

    A deep copy, because callers edit what they get. Returning DEFAULT_GATES by
    reference let one caller's edit change the defaults for every later caller in
    the same process, which is how a test that disabled one gate silently
    disabled it for the rest of the run.
    """
    return {
        "schema": SCHEMA,
        "gates": copy.deepcopy(DEFAULT_GATES),
        "audit": str(DEFAULT_AUDIT_RELPATH),
    }


def read_event() -> dict[str, Any]:
    """The hook event off stdin. An unreadable event is not a reason to block."""
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return event if isinstance(event, dict) else {}


def project_dir(event: dict[str, Any]) -> Path:
    """The project the hook is running against.

    `cwd` on the event is the fallback, and it is what makes these scripts
    testable by piping a recorded event with no environment set up.
    """
    env = os.environ.get("CLAUDE_PROJECT_DIR", "")
    if env:
        return Path(env)
    cwd = event.get("cwd")
    if isinstance(cwd, str) and cwd:
        return Path(cwd)
    return Path.cwd()


def load_config(project: Path) -> dict[str, Any] | None:
    """The project's gate policy, or None when the project has not opted in."""
    path = project / CONFIG_RELPATH
    if not path.is_file():
        return None
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        # Fail closed. A policy file this project wrote and cannot parse is not
        # a licence to run ungated, and the reason names the file to fix.
        refuse(f"could not read {CONFIG_RELPATH}: {exc}")
    if not isinstance(config, dict):
        refuse(f"{CONFIG_RELPATH} must hold a JSON object")
    if config.get("schema") != SCHEMA:
        refuse(
            f"{CONFIG_RELPATH} has schema {config.get('schema')!r}, "
            f"this plugin writes schema {SCHEMA}. Re-run /setup-enterprise."
        )
    gates = config.get("gates")
    if not isinstance(gates, dict):
        refuse(f"{CONFIG_RELPATH} has no 'gates' object")
    return config


def refuse(message: str) -> None:
    """Block with a reason the agent can act on."""
    sys.stderr.write(f"enterprise gate: {message}\n")
    raise SystemExit(2)


def audit_path(project: Path, config: dict[str, Any]) -> Path:
    raw = config.get("audit") or str(DEFAULT_AUDIT_RELPATH)
    path = Path(str(raw))
    return path if path.is_absolute() else project / path


def command_of(event: dict[str, Any]) -> str:
    """The shell command a Bash call would run, empty for any other tool."""
    if event.get("tool_name") != "Bash":
        return ""
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return ""
    command = tool_input.get("command")
    return command if isinstance(command, str) else ""


def matches(command: str, pattern: str) -> bool:
    """Glob match, also allowing the pattern to appear after a shell prefix.

    `git push *` has to catch `cd services/api && git push origin main`, so a
    leading wildcard is tried as well. That over-matches on occasion, and a gate
    that asks about a command it should not have is cheaper than one that waves
    through a push it should have caught. The reason string names the pattern
    that fired, so a false positive is diagnosable from the prompt itself.
    """
    if fnmatch.fnmatchcase(command, pattern):
        return True
    return fnmatch.fnmatchcase(command, f"*{pattern}")


def classify(command: str, config: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Every enabled gate this command trips, as (key, label, pattern)."""
    if not command:
        return []
    hits: list[tuple[str, str, str]] = []
    gates = config.get("gates") or {}
    for key, spec in gates.items():
        if not isinstance(spec, dict) or not spec.get("enabled"):
            continue
        label = str(spec.get("label") or key)
        for pattern in spec.get("patterns") or []:
            if isinstance(pattern, str) and matches(command, pattern):
                hits.append((key, label, pattern))
                break
    return hits


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def append_record(path: Path, record: dict[str, Any]) -> None:
    """One JSON line. A gate that cannot log still gates, so errors are quiet."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def identity(event: dict[str, Any]) -> dict[str, Any]:
    """Who and what, carried onto every record so entries can be correlated."""
    out: dict[str, Any] = {}
    for field in ("session_id", "agent_id", "agent_type", "tool_use_id"):
        value = event.get(field)
        if isinstance(value, str) and value:
            out[field] = value
    return out


def emit_ask(label: str, command: str, pattern: str) -> None:
    """Ask the human. hookEventName is required or Qoder rejects the whole blob."""
    shown = command if len(command) <= 400 else command[:400] + "..."
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": (
                f"Enterprise gate: {label}. Matched the pattern `{pattern}`. "
                f"Command: {shown}"
            ),
        }
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def run_gate(event: dict[str, Any]) -> int:
    """PreToolUse. Ask before a gated command runs, and log that we asked."""
    project = project_dir(event)
    config = load_config(project)
    if config is None:
        return 0
    command = command_of(event)
    hits = classify(command, config)
    if not hits:
        return 0

    key, label, pattern = hits[0]
    log = audit_path(project, config)
    append_record(
        log,
        {
            "ts": now(),
            "phase": "ask",
            "gate": key,
            "pattern": pattern,
            "command": command,
            **identity(event),
        },
    )
    if len(hits) > 1:
        others = ", ".join(sorted({h[0] for h in hits[1:]}))
        label = f"{label}, also tripping {others}"
    emit_ask(label, command, pattern)
    return 0


def run_audit(event: dict[str, Any]) -> int:
    """PostToolUse. Log what actually ran, which only happens once approved."""
    project = project_dir(event)
    config = load_config(project)
    if config is None:
        return 0
    command = command_of(event)
    hits = classify(command, config)
    if not hits:
        return 0

    response = event.get("tool_response")
    snippet = ""
    if isinstance(response, str):
        snippet = response
    elif response is not None:
        try:
            snippet = json.dumps(response, ensure_ascii=False)
        except (TypeError, ValueError):
            snippet = str(response)
    if len(snippet) > 400:
        snippet = snippet[:400] + "..."

    append_record(
        audit_path(project, config),
        {
            "ts": now(),
            "phase": "exec",
            "gate": hits[0][0],
            "command": command,
            "tool_response": snippet,
            **identity(event),
        },
    )
    return 0


def run_backstop(event: dict[str, Any]) -> int:
    """SubagentStop. Report a gated action that ran with no ask behind it.

    This detects, it does not prevent. By the time a seat stops, anything it
    pushed has already been pushed, and no hook can un-push it. What it can do
    is stop the seat from reporting a clean run while an ungated action sits in
    the log, which is the failure that would otherwise reach a human as a
    finished summary.

    When hooks do not fire inside a subagent at all, no exec record is written
    either and this finds nothing. That is a real limit and it is recorded in
    COMPATIBILITY.md rather than papered over here.
    """
    # Qoder sets this when the seat is already continuing because a stop hook
    # blocked it. Blocking again would loop forever on the same log, so the
    # second pass reports nothing and lets the seat finish.
    if event.get("stop_hook_active"):
        return 0

    project = project_dir(event)
    config = load_config(project)
    if config is None:
        return 0
    log = audit_path(project, config)
    if not log.is_file():
        return 0

    asks: set[str] = set()
    execs: list[dict[str, Any]] = []
    try:
        lines = log.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        if record.get("phase") == "ask":
            asked = record.get("tool_use_id")
            if isinstance(asked, str):
                asks.add(asked)
        elif record.get("phase") == "exec":
            execs.append(record)

    agent_id = event.get("agent_id")
    ungated = [
        record
        for record in execs
        if isinstance(record.get("tool_use_id"), str)
        and record["tool_use_id"] not in asks
        and (agent_id is None or record.get("agent_id") == agent_id)
    ]
    if not ungated:
        return 0

    listing = "\n".join(
        f"  - [{record.get('gate', '?')}] {record.get('command', '')}" for record in ungated
    )
    sys.stderr.write(
        "enterprise gate: this seat ran gated actions that never reached an "
        f"approval prompt:\n{listing}\n"
        "Report each one to the orchestrator as ungated. Do not describe the run "
        "as approved, and do not repeat the action.\n"
    )
    return 2


COMMANDS = {"gate": run_gate, "audit": run_audit, "backstop": run_backstop}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in COMMANDS:
        sys.stderr.write(
            f"usage: {Path(argv[0]).name} {{{'|'.join(sorted(COMMANDS))}}}\n"
        )
        return 2
    event = read_event()
    try:
        return COMMANDS[argv[1]](event)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - a gate must not crash a session
        # Fail closed on the gate path only. Crashing open would silently drop
        # the gate, and a stack trace in stderr is not something an agent can act
        # on, so the message names the fix instead.
        if argv[1] == "gate":
            sys.stderr.write(f"enterprise gate could not evaluate: {exc}\n")
            return 2
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
