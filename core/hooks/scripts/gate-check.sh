#!/usr/bin/env bash
# PreToolUse entry point for the enterprise approval gate.
#
# The dormancy check is plain shell on purpose. This hook is registered against
# every Bash call, so a repo that never opted in pays one file test and one exit
# instead of an interpreter start. Policy itself lives in the project's
# .claude/enterprise/gates.json and is read by enterprise_hooks.py, which keeps
# one source of truth that /{{estack:ns}}:setup can widen per repo.
#
# This script fails closed. A gate that cannot evaluate is not a gate, and
# letting the action through would be the one failure mode nobody notices.
set -uo pipefail

input="$(cat)"
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Fast path: when CLAUDE_PROJECT_DIR is set and the project has no policy file,
# nothing downstream can decide otherwise, so exit before starting python3.
project="${CLAUDE_PROJECT_DIR:-}"
if [ -n "$project" ] && [ ! -f "$project/.claude/enterprise/gates.json" ]; then
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  cat >&2 <<'MSG'
enterprise gate: python3 is not on PATH, so this gate cannot evaluate the
command. Refusing it rather than letting it through ungated. Install python3,
or delete .claude/enterprise/gates.json to turn gates off in this repo.
MSG
  exit 2
fi

printf '%s' "$input" | python3 "$here/enterprise_hooks.py" gate
exit $?
