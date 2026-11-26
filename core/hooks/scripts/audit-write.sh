#!/usr/bin/env bash
# PostToolUse entry point. Appends the audit record for a gated command that
# actually ran, which by definition means a human approved it at the prompt.
#
# This script fails quiet. The action has already happened, so blocking here
# would punish a later tool call for an earlier one, and a missing log line is a
# far smaller problem than a session that stops making progress.
set -uo pipefail

input="$(cat)"
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

project="${CLAUDE_PROJECT_DIR:-}"
if [ -n "$project" ] && [ ! -f "$project/.claude/enterprise/gates.json" ]; then
  exit 0
fi

command -v python3 >/dev/null 2>&1 || exit 0

printf '%s' "$input" | python3 "$here/enterprise_hooks.py" audit
exit 0
