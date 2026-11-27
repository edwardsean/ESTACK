#!/bin/sh
# Single entry point for every estack Claude Code hook. Dormant (exit 0, no
# output, no Node start) unless .estack/policy.yaml exists in the project.
input="$(cat)"
dir="${CLAUDE_PROJECT_DIR:-}"
cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [ ! -f "$dir/.estack/policy.yaml" ] && [ ! -f "$cwd/.estack/policy.yaml" ]; then exit 0; fi
if ! command -v node >/dev/null 2>&1; then
  case "$1" in pre-tool-use) printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"estack: node is not on PATH, so this repository'"'"'s gates cannot run"}}';; esac
  exit 0
fi
engine="$(dirname "$0")/../../engine/estack.mjs"
if [ "$1" != "pre-tool-use" ]; then
  printf '%s' "$input" | exec node --no-warnings "$engine" hook "$1"
fi
# PreToolUse gates fail closed: if the engine cannot run, a non-zero exit would
# be a non-blocking error to Claude Code, so turn it into a deny.
errf="$(mktemp 2>/dev/null || echo /dev/null)"
out="$(printf '%s' "$input" | node --no-warnings "$engine" hook "$1" 2>"$errf")"
code=$?
if [ "$code" -ne 0 ]; then
  # The useful line is Node's message line ("Error: ...", "TypeError: ..."; it prints a file:line
  # header and the source line first), else any line naming an Error, else the last non-empty
  # line, else the exit status.
  line="$(grep -m1 '^[A-Za-z_.]*Error' "$errf" 2>/dev/null)"
  [ -n "$line" ] || line="$(grep -m1 'Error' "$errf" 2>/dev/null)"
  [ -n "$line" ] || line="$(grep -v '^[[:space:]]*$' "$errf" 2>/dev/null | tail -n1)"
  msg="$(printf '%s' "$line" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
  [ -n "$msg" ] || msg="exit $code"
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"estack: the engine could not run ('"$msg"'); fix the estack install or Node version (needs 22.5+)"}}'
  [ "$errf" = /dev/null ] || rm -f "$errf"
  exit 0
fi
[ "$errf" = /dev/null ] || rm -f "$errf"
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
