#!/usr/bin/env bash
# Validation entry point for the Claude Code edition of pstack.
#
# The static half always runs and needs nothing but Python 3. The plugin
# validator needs the `claude` CLI and is skipped with a message when it is
# absent, because a skipped check that says it was skipped beats a check that
# quietly passes.
#
# Usage:
#   scripts/selftest.sh   static checks, engine hook smoke test,
#                         `claude plugin validate` and the generator check
#                         when their tools are present
#
# Never installs the plugin and never touches ~/.claude. Exit status is 0 when
# every check passed, 1 when any failed, and 2 on a bad argument.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PASSED=0
FAILED=0
SKIPPED=0
pass() { PASSED=$((PASSED + 1)); printf '  ok      %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL    %s\n' "$1"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf '  skip    %s\n' "$1"; }
section() { printf '\n%s\n' "$1"; }

echo "plugin: $ROOT"

section "1. static conformance (scripts/selftest.py)"
if python3 scripts/selftest.py; then
  pass "manifest, frontmatter, links, seats, playbooks, enterprise roster, workflow, hooks, gate"
else
  fail "scripts/selftest.py reported failures above"
fi

section "2. engine hook smoke test (PreToolUse Write, opted-in repo and dormant repo)"
if ! command -v node >/dev/null 2>&1; then
  skip "node not on PATH"
else
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/estack-smoke.XXXXXX")"
  mkdir -p "$tmp/on" "$tmp/off"
  for r in on off; do
    git -C "$tmp/$r" init -q
  done
  (cd "$tmp/on" && node --no-warnings "$ROOT/engine/estack.mjs" init >/dev/null 2>&1)
  event() {
    printf '{"session_id":"s1","transcript_path":"%s/t.jsonl","cwd":"%s","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"%s/src/a.ts","content":"x"},"tool_use_id":"toolu_smoke"}' "$1" "$1" "$1"
  }
  on_out="$(event "$tmp/on" | CLAUDE_PROJECT_DIR="$tmp/on" hooks/scripts/estack-hook.sh pre-tool-use 2>/dev/null)"; on_code=$?
  off_out="$(event "$tmp/off" | CLAUDE_PROJECT_DIR="$tmp/off" hooks/scripts/estack-hook.sh pre-tool-use 2>/dev/null)"; off_code=$?
  echo "  opted in : exit=$on_code stdout=$on_out"
  echo "  dormant  : exit=$off_code stdout=${off_out:-<empty>}"
  if [ "$on_code" = 0 ] && printf '%s' "$on_out" | grep -q '"permissionDecision":"deny"'; then
    pass "opted-in repo: a Write with no open task is denied"
  else
    fail "opted-in repo did not emit a deny"
  fi
  if [ "$off_code" = 0 ] && [ -z "$off_out" ] && [ ! -e "$tmp/off/.estack" ] && [ -z "$(ls -A "$tmp/off" | grep -v '^\.git$')" ]; then
    pass "dormant repo: silent, exit 0, nothing written"
  else
    fail "dormant repo was not left alone"
  fi
  rm -rf "$tmp"
fi

section "3. plugin validator (claude plugin validate)"
if command -v claude >/dev/null 2>&1; then
  if out="$(claude plugin validate . 2>&1)" && printf '%s' "$out" | grep -q "Validation passed"; then
    pass "claude plugin validate . -> Validation passed"
  else
    printf '%s\n' "$out" | tail -20
    fail "claude plugin validate reported problems"
  fi
else
  skip "claude CLI not on PATH"
fi

section "4. generated plugin matches core/ (npm run check:claude)"
REPO="$(cd "$ROOT/../.." && pwd)"
if [ ! -f "$REPO/package.json" ]; then
  skip "no estack repository root above this folder"
elif ! command -v npm >/dev/null 2>&1; then
  skip "npm not on PATH"
elif (cd "$REPO" && npm run --silent check:claude); then
  pass "adapters/claude-code is exactly what core/ generates"
else
  fail "adapters/claude-code differs from core/; run npm run build:claude"
fi

printf '\npassed %d, failed %d, skipped %d\n' "$PASSED" "$FAILED" "$SKIPPED"
[ "$FAILED" = 0 ]
