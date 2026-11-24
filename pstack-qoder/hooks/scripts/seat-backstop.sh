#!/usr/bin/env bash
# SubagentStop entry point. Checks whether the seat that just finished ran any
# gated command with no approval prompt behind it, and if so blocks the stop so
# the seat reports it instead of summarising a clean run.
#
# Detection, not prevention. Anything a seat already pushed stays pushed, and no
# hook can undo it. What this protects is the report a human reads next.
#
# Fails quiet. Blocking a seat because the checker itself broke would strand the
# session, and the audit log still holds the evidence either way.
set -uo pipefail

input="$(cat)"
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

project="${QODER_PROJECT_DIR:-}"
if [ -n "$project" ] && [ ! -f "$project/.qoder/enterprise/gates.json" ]; then
  exit 0
fi

command -v python3 >/dev/null 2>&1 || exit 0

printf '%s' "$input" | python3 "$here/enterprise_hooks.py" backstop
exit $?
