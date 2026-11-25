#!/usr/bin/env python3
"""Behavioural tests for the enterprise approval gates.

These drive the real shell entry points in `hooks/scripts/` the way Claude Code
does, by piping a hook event as JSON on stdin with CLAUDE_PROJECT_DIR set, then
asserting the exit code and stdout. The events carry the fields Claude Code's
hooks reference documents for PreToolUse, PostToolUse, and SubagentStop. They
need no `claude` binary and no network.

What they cannot prove is that a live Claude Code session fires these hooks.
Claude Code documents that PreToolUse and PostToolUse fire for a subagent's tool
calls with `agent_id` and `agent_type` set, which settles the open question the
Qoder edition carried, but no live session has been observed doing it here.

Usage:
    python3 scripts/test-gates.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
HOOKS = PLUGIN_ROOT / "hooks" / "scripts"
sys.path.insert(0, str(HOOKS))

# The import below would otherwise drop a `hooks/scripts/__pycache__/*.pyc` into
# the tree being packaged, so running the test creates the junk it then fails on.
sys.dont_write_bytecode = True

import enterprise_hooks as eh  # noqa: E402  (needs HOOKS on sys.path first)

PASSED = 0
FAILED: list[str] = []


def ok(name: str) -> None:
    global PASSED
    PASSED += 1
    print(f"  ok      {name}")


def bad(name: str, detail: str) -> None:
    FAILED.append(f"{name}: {detail}")
    print(f"  FAIL    {name}\n            {detail}")


def check(name: str, condition: bool, detail: str = "") -> bool:
    if condition:
        ok(name)
    else:
        bad(name, detail or "assertion failed")
    return condition


class Sandbox:
    """A throwaway project directory, opted in or left dormant."""

    def __init__(self, *, opted_in: bool = True, config: dict[str, Any] | None = None):
        self.root = Path(tempfile.mkdtemp(prefix="estack-gates-"))
        self.enterprise = self.root / ".claude" / "enterprise"
        if opted_in:
            self.enterprise.mkdir(parents=True, exist_ok=True)
            self.write_config(config if config is not None else eh.default_config())

    def write_config(self, config: Any) -> None:
        self.enterprise.mkdir(parents=True, exist_ok=True)
        (self.enterprise / "gates.json").write_text(
            config if isinstance(config, str) else json.dumps(config), encoding="utf-8"
        )

    @property
    def log(self) -> Path:
        return self.enterprise / "approvals.jsonl"

    def records(self) -> list[dict[str, Any]]:
        if not self.log.is_file():
            return []
        out = []
        for line in self.log.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(json.loads(line))
        return out

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


HOOK_EVENT = {
    "gate-check.sh": "PreToolUse",
    "audit-write.sh": "PostToolUse",
    "seat-backstop.sh": "SubagentStop",
}


def run(script: str, event: dict[str, Any], box: Sandbox) -> tuple[int, str, str]:
    """Invoke a hook entry point exactly as Claude Code would.

    The envelope carries Claude Code's common input fields, so a script that
    started depending on one it does not get would fail here first.
    """
    payload = {
        "session_id": "s0",
        "transcript_path": str(box.root / "transcript.jsonl"),
        "cwd": str(box.root),
        "permission_mode": "default",
        "hook_event_name": HOOK_EVENT[script],
    }
    payload.update(event)
    env = dict(os.environ, CLAUDE_PROJECT_DIR=str(box.root))
    proc = subprocess.run(
        [str(HOOKS / script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def bash_event(command: str, **extra: Any) -> dict[str, Any]:
    return {"tool_name": "Bash", "tool_input": {"command": command}, **extra}


def ask_of(stdout: str) -> dict[str, Any] | None:
    """The hookSpecificOutput blob, or None when the hook stayed silent."""
    if not stdout.strip():
        return None
    return json.loads(stdout).get("hookSpecificOutput")


# ---------------------------------------------------------------------------


def test_dormant_project_is_untouched() -> None:
    box = Sandbox(opted_in=False)
    try:
        code, out, _ = run("gate-check.sh", bash_event("git push origin main"), box)
        check(
            "a repo that never opted in is not gated",
            code == 0 and out.strip() == "",
            f"exit={code} stdout={out!r}",
        )
        check(
            "a dormant repo gets no audit log",
            not box.log.exists(),
            "approvals.jsonl was created in a repo with no policy",
        )
    finally:
        box.close()


def test_push_asks_and_names_its_pattern() -> None:
    box = Sandbox()
    try:
        code, out, _ = run(
            "gate-check.sh",
            bash_event("git push origin main", tool_use_id="t1", agent_type="estack:poteto-agent"),
            box,
        )
        ask = ask_of(out)
        check("git push exits 0 and emits a decision", code == 0 and ask is not None, f"exit={code} out={out!r}")
        if not ask:
            return
        check(
            "the decision is an interactive ask",
            ask.get("permissionDecision") == "ask",
            f"got {ask.get('permissionDecision')!r}",
        )
        # hookSpecificOutput requires hookEventName, so it is asserted
        # separately rather than folded into the shape check above.
        check(
            "hookEventName is PreToolUse, as hookSpecificOutput requires",
            ask.get("hookEventName") == "PreToolUse",
            f"got {ask.get('hookEventName')!r}",
        )
        reason = ask.get("permissionDecisionReason", "")
        check(
            "the reason names the pattern that fired, so a false positive is diagnosable",
            "git push *" in reason,
            reason,
        )
    finally:
        box.close()


def test_ungated_commands_pass_silently() -> None:
    box = Sandbox()
    try:
        for command in ("ls -la", "npm test", "kubectl get pods", "git status", "cat README.md"):
            code, out, _ = run("gate-check.sh", bash_event(command), box)
            check(
                f"{command!r} is not gated",
                code == 0 and out.strip() == "",
                f"exit={code} out={out!r}",
            )
    finally:
        box.close()


def test_all_three_gate_classes_fire() -> None:
    box = Sandbox()
    try:
        cases = {
            "push": "git push origin main",
            "deploy": "kubectl apply -f k8s/deploy.yaml",
            "migration": "alembic upgrade head",
        }
        for gate, command in cases.items():
            _, out, _ = run("gate-check.sh", bash_event(command), box)
            ask = ask_of(out)
            check(
                f"{command!r} trips the {gate} gate",
                ask is not None and ask.get("permissionDecision") == "ask",
                f"got {out!r}",
            )
    finally:
        box.close()


def test_shell_prefix_does_not_hide_a_push() -> None:
    box = Sandbox()
    try:
        command = "cd services/api && git push origin main"
        _, out, _ = run("gate-check.sh", bash_event(command), box)
        check(
            "a push behind a shell prefix is still caught",
            ask_of(out) is not None,
            "the leading-wildcard fallback did not fire",
        )
    finally:
        box.close()


def test_non_bash_tool_is_ignored() -> None:
    box = Sandbox()
    try:
        event = {"tool_name": "Write", "tool_input": {"file_path": "/tmp/x"}}
        code, out, _ = run("gate-check.sh", event, box)
        check(
            "a Write call is not gated by a Bash policy",
            code == 0 and out.strip() == "",
            f"exit={code} out={out!r}",
        )
    finally:
        box.close()


def test_project_can_disable_a_class() -> None:
    config = eh.default_config()
    config["gates"]["push"]["enabled"] = False
    box = Sandbox(config=config)
    try:
        _, out, _ = run("gate-check.sh", bash_event("git push origin main"), box)
        check(
            "a project that disables a class really loses it",
            out.strip() == "",
            f"the shipped default overrode project policy: {out!r}",
        )
    finally:
        box.close()


def test_project_can_add_a_custom_pattern() -> None:
    # The plugin declares no `if` pre-filter, precisely so this works. A hardcoded
    # `if` in hooks/hooks.json would stop the hook firing at all and this
    # pattern would silently do nothing.
    config = eh.default_config()
    config["gates"]["deploy"]["patterns"].append("make release*")
    box = Sandbox(config=config)
    try:
        _, out, _ = run("gate-check.sh", bash_event("make release VERSION=1.2"), box)
        check(
            "a pattern a project added is honoured with no plugin change",
            ask_of(out) is not None,
            "custom pattern never fired, so gates.json is not the only source of truth",
        )
    finally:
        box.close()


def test_malformed_policy_fails_closed() -> None:
    box = Sandbox(opted_in=False)
    try:
        box.write_config("{ this is not json")
        code, _, err = run("gate-check.sh", bash_event("git push origin main"), box)
        check(
            "an unparseable policy blocks rather than allowing",
            code == 2 and "gates.json" in err,
            f"exit={code} stderr={err!r}",
        )

        box.write_config(json.dumps({"schema": 999, "gates": {}}))
        code, _, err = run("gate-check.sh", bash_event("git push origin main"), box)
        check(
            "a policy from a future schema blocks and says to re-run setup",
            code == 2 and "Re-run /estack:setup." in err,
            f"exit={code} stderr={err!r}",
        )
    finally:
        box.close()


def test_ask_then_exec_is_clean() -> None:
    box = Sandbox()
    try:
        event = bash_event(
            "git push origin main", tool_use_id="t1", session_id="s1", agent_id="a1"
        )
        run("gate-check.sh", event, box)
        run("audit-write.sh", dict(event, tool_response={"success": True}), box)

        records = box.records()
        phases = [r["phase"] for r in records]
        check(
            "an approved push leaves one ask and one exec record",
            phases == ["ask", "exec"],
            f"got {phases}",
        )
        check(
            "both records carry the same tool_use_id, which is what correlates them",
            len({r.get("tool_use_id") for r in records}) == 1,
            str(records),
        )

        code, out, _ = run(
            "seat-backstop.sh",
            {"agent_id": "a1", "agent_type": "estack:poteto-agent", "stop_hook_active": False},
            box,
        )
        check(
            "a seat that asked before pushing is not accused",
            code == 0 and out.strip() == "",
            f"exit={code} out={out!r}",
        )
    finally:
        box.close()


def test_backstop_flags_an_ungated_push() -> None:
    box = Sandbox()
    try:
        # No gate-check run, so no ask record exists. This is the shape a bypass
        # takes if PreToolUse does not fire inside a subagent session.
        run(
            "audit-write.sh",
            bash_event(
                "git push --force origin main",
                tool_use_id="t9",
                session_id="s1",
                agent_id="a1",
                agent_type="estack:poteto-agent",
                tool_response={"success": True},
            ),
            box,
        )
        code, _, err = run(
            "seat-backstop.sh",
            {"agent_id": "a1", "agent_type": "estack:poteto-agent", "stop_hook_active": False},
            box,
        )
        check(
            "an exec with no ask behind it blocks the seat from stopping",
            code == 2,
            f"exit={code} stderr={err!r}",
        )
        check(
            "the block names the ungated command",
            "git push --force origin main" in err,
            err,
        )
    finally:
        box.close()


def test_backstop_is_scoped_and_cannot_loop() -> None:
    box = Sandbox()
    try:
        run(
            "audit-write.sh",
            bash_event("git push origin main", tool_use_id="t9", agent_id="a1"),
            box,
        )

        code, _, _ = run(
            "seat-backstop.sh",
            {"agent_id": "a2", "agent_type": "estack:estack-judge", "stop_hook_active": False},
            box,
        )
        check("a different seat is not blamed for another's push", code == 0, f"exit={code}")

        # SubagentStop blocking keeps the seat running, so honouring this flag is
        # what stops the same log blocking the same seat forever.
        code, _, _ = run(
            "seat-backstop.sh",
            {"agent_id": "a1", "agent_type": "estack:poteto-agent", "stop_hook_active": True},
            box,
        )
        check(
            "stop_hook_active prevents an endless block loop",
            code == 0,
            f"exit={code}, the guard is missing",
        )
    finally:
        box.close()


def test_dormant_project_skips_audit_and_backstop() -> None:
    box = Sandbox(opted_in=False)
    try:
        code, out, _ = run("audit-write.sh", bash_event("git push origin main"), box)
        check("a dormant repo writes no audit record", code == 0 and not box.log.exists(), f"exit={code}")
        code, _, _ = run("seat-backstop.sh", {"agent_id": "a1", "stop_hook_active": False}, box)
        check("a dormant repo is never blocked at seat stop", code == 0, f"exit={code}")
    finally:
        box.close()


def test_audit_truncates_a_huge_response() -> None:
    box = Sandbox()
    try:
        run(
            "audit-write.sh",
            bash_event(
                "git push origin main",
                tool_use_id="t1",
                tool_response={"output": "x" * 5000},
            ),
            box,
        )
        records = box.records()
        if not check(
            "a gated exec is logged",
            bool(records),
            "no record written, so truncation cannot be checked",
        ):
            return
        record = records[-1]
        check(
            "a large tool_response is truncated rather than bloating the log",
            len(record.get("tool_response", "")) <= 403,
            f"len={len(record.get('tool_response', ''))}",
        )
    finally:
        box.close()


def test_default_config_is_not_shared_state() -> None:
    # Regression. default_config() used to hand back the module-level defaults by
    # reference, so one caller disabling a gate disabled it for every later
    # caller in the process. The failing tests looked like an audit bug and were
    # not, which is what makes the aliasing worth pinning down directly.
    first = eh.default_config()
    first["gates"]["push"]["enabled"] = False
    first["gates"]["deploy"]["patterns"].append("make release*")

    second = eh.default_config()
    check(
        "editing one default_config does not change the next",
        second["gates"]["push"]["enabled"] is True
        and "make release*" not in second["gates"]["deploy"]["patterns"],
        "default_config still returns shared mutable state",
    )


def test_hooks_manifest_is_claude_code_shaped() -> None:
    manifest = json.loads((PLUGIN_ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    hooks = manifest.get("hooks", {})
    check(
        "hooks.json declares exactly PreToolUse, PostToolUse, and SubagentStop",
        sorted(hooks) == ["PostToolUse", "PreToolUse", "SubagentStop"],
        f"got {sorted(hooks)}",
    )
    allowed = {"type", "command", "timeout", "statusMessage", "async", "if", "once"}
    for event, groups in hooks.items():
        for group in groups:
            for handler in group.get("hooks", []):
                extra = set(handler) - allowed
                check(
                    f"{event} handler uses only documented fields",
                    not extra,
                    f"undocumented: {sorted(extra)}",
                )
                command = handler.get("command", "")
                check(
                    f"{event} handler resolves its script through CLAUDE_PLUGIN_ROOT",
                    "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/" in command,
                    command,
                )
                script = command.split("/hooks/scripts/")[-1].strip('"')
                path = HOOKS / script
                check(
                    f"{event} script {script} exists and is executable",
                    path.is_file() and os.access(path, os.X_OK),
                    str(path),
                )
    check(
        "the Bash-only events match on Bash",
        all(g.get("matcher") == "Bash" for e in ("PreToolUse", "PostToolUse") for g in hooks.get(e, [])),
        "a PreToolUse or PostToolUse group lost its Bash matcher",
    )


def test_ask_payload_is_exactly_the_documented_shape() -> None:
    box = Sandbox()
    try:
        _, out, _ = run("gate-check.sh", bash_event("git push origin main", tool_use_id="t1"), box)
        blob = json.loads(out) if out.strip() else {}
        check(
            "stdout is one JSON object with hookSpecificOutput only",
            list(blob) == ["hookSpecificOutput"],
            f"top-level keys {list(blob)}",
        )
        inner = blob.get("hookSpecificOutput", {})
        check(
            "hookSpecificOutput carries hookEventName, permissionDecision, permissionDecisionReason",
            sorted(inner) == ["hookEventName", "permissionDecision", "permissionDecisionReason"],
            f"keys {sorted(inner)}",
        )
    finally:
        box.close()


def test_subagent_tool_call_is_attributed() -> None:
    # Claude Code fires PreToolUse inside a subagent with agent_id and agent_type
    # set. The ask record has to carry both so the backstop can scope by seat.
    box = Sandbox()
    try:
        run(
            "gate-check.sh",
            bash_event("git push origin feat", tool_use_id="t5", agent_id="a7", agent_type="estack:ent-devops-engineer"),
            box,
        )
        records = box.records()
        check(
            "an ask from inside a seat records the seat's agent_id and agent_type",
            bool(records) and records[0].get("agent_id") == "a7"
            and records[0].get("agent_type") == "estack:ent-devops-engineer",
            str(records),
        )
    finally:
        box.close()


TESTS = [
    test_dormant_project_is_untouched,
    test_push_asks_and_names_its_pattern,
    test_ungated_commands_pass_silently,
    test_all_three_gate_classes_fire,
    test_shell_prefix_does_not_hide_a_push,
    test_non_bash_tool_is_ignored,
    test_project_can_disable_a_class,
    test_project_can_add_a_custom_pattern,
    test_malformed_policy_fails_closed,
    test_ask_then_exec_is_clean,
    test_backstop_flags_an_ungated_push,
    test_backstop_is_scoped_and_cannot_loop,
    test_dormant_project_skips_audit_and_backstop,
    test_audit_truncates_a_huge_response,
    test_default_config_is_not_shared_state,
    test_hooks_manifest_is_claude_code_shaped,
    test_ask_payload_is_exactly_the_documented_shape,
    test_subagent_tool_call_is_attributed,
]


def main() -> int:
    print(f"plugin: {PLUGIN_ROOT}")
    print("\nenterprise approval gates")
    for test in TESTS:
        test()

    print()
    if FAILED:
        print(f"FAILURES ({len(FAILED)})")
        for item in FAILED:
            print(f"  {item}")
        print(f"\nfailed {len(FAILED)}, passed {PASSED}")
        return 1
    print(f"passed {PASSED}, failed 0")
    print("PASS: the gate scripts behave correctly against recorded hook events")
    print("Not proven here: that a live Claude Code session fires these hooks.")
    print("That needs one gated command in an opted-in repo; see /estack:setup step 6.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
