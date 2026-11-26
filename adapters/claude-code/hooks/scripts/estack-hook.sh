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
printf '%s' "$input" | exec node --no-warnings "$(dirname "$0")/../../engine/estack.mjs" hook "$1"
