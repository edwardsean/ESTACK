#!/usr/bin/env bash
# Validation entry point for the pstack-qoder port.
#
# The static half always runs and needs nothing but Python 3. The runtime half
# needs the Qoder CLI and is skipped with a message when it is absent, because a
# skipped check that says it was skipped beats a check that quietly passes.
#
# Usage:
#   scripts/selftest.sh                static checks, plus qodercli when present
#   scripts/selftest.sh --rebuild      also rebuild from upstream and re-gate
#   scripts/selftest.sh --install      also install into a temp cwd and verify
#                                      discovery. Mutates nothing permanent.
#
# Exit status is 0 when every check passed, 1 when any failed, and 2 on a bad
# argument.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REBUILD=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --install) INSTALL=1 ;;
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
# Not named `head`, which is a command this script also calls.
section() { printf '\n%s\n' "$1"; }

echo "plugin: $ROOT"

# ---------------------------------------------------------------------------
# Static conformance. This is the real gate, and it always runs.
# ---------------------------------------------------------------------------

section "1. static conformance (scripts/selftest.py)"
if python3 scripts/selftest.py; then
  pass "manifest, frontmatter, links, paths, seats, playbooks, workflow, Cursor-isms, packaging"
else
  fail "scripts/selftest.py reported failures above"
fi

# ---------------------------------------------------------------------------
# Enterprise gate behaviour. Needs nothing but Python 3, but it drives the real
# hook entry points over recorded events, so it is the half that proves the
# gates decide correctly rather than merely parse.
# ---------------------------------------------------------------------------

section "2. enterprise gate behaviour (scripts/test-gates.py)"
if python3 scripts/test-gates.py; then
  pass "gate, audit, and backstop scripts against recorded hook events"
else
  fail "scripts/test-gates.py reported failures above"
fi

# ---------------------------------------------------------------------------
# Reproducibility. Opt-in, because it writes to the tree.
# ---------------------------------------------------------------------------

section "3. rebuild from upstream (opt-in)"
if [[ "$REBUILD" -eq 1 ]]; then
  UPSTREAM="${PSTACK_UPSTREAM:-$ROOT/../upstream/pstack}"
  if [[ -d "$UPSTREAM" ]]; then
    if python3 scripts/port-from-upstream.py "$UPSTREAM"; then
      pass "rebuilt and gated clean from $UPSTREAM"
      echo "       re-running static conformance against the rebuilt tree"
      if python3 scripts/selftest.py >/dev/null; then
        pass "rebuilt tree still conforms"
      else
        fail "rebuilt tree does not conform"
      fi
    else
      fail "the lever exited non-zero"
    fi
  else
    fail "PSTACK_UPSTREAM or ../upstream/pstack not found: $UPSTREAM"
  fi
else
  skip "pass --rebuild to prove the port regenerates from upstream"
fi

# ---------------------------------------------------------------------------
# Offline manifest validator, when the create-plugin skill is installed.
# ---------------------------------------------------------------------------

section "4. Qoder offline plugin validator"
VALIDATOR="$(ls -1 "$HOME"/.qoder/plugins/cache/*/*/skills/create-plugin/scripts/validate_qoder_plugin.py 2>/dev/null | head -n 1)"
if [[ -n "$VALIDATOR" ]]; then
  if python3 "$VALIDATOR" "$ROOT"; then
    pass "validate_qoder_plugin.py ($VALIDATOR)"
  else
    fail "validate_qoder_plugin.py reported issues"
  fi
else
  skip "validate_qoder_plugin.py not found under ~/.qoder/plugins/cache"
fi

# ---------------------------------------------------------------------------
# Runtime half. Needs the CLI.
# ---------------------------------------------------------------------------

section "5. Qoder CLI compatibility"
# Derived from disk rather than written down, so a seat added later is checked
# without this file being edited. The static half already proved every one of
# these files parses as an agent.
SEAT_COUNT=$(find agents -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
QODERCLI="$(command -v qodercli 2>/dev/null || true)"
if [[ -z "$QODERCLI" ]]; then
  skip "qodercli is not on PATH, so no runtime check was possible"
  echo "       this is the half that proves Qoder discovers and dispatches the"
  echo "       seats. Install the CLI and re-run, or do it by hand in a session:"
  echo "         /agents reload, then check the Plugin tab lists all $SEAT_COUNT seats"
else
  if "$QODERCLI" plugin validate "$ROOT"; then
    pass "qodercli plugin validate"
  else
    fail "qodercli plugin validate"
  fi

  EXPECTED_SKILLS=$(find skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
  LISTED="$("$QODERCLI" --cwd "$ROOT" --setting-sources project skills list 2>/dev/null || true)"
  if [[ -n "$LISTED" ]]; then
    FOUND=0
    for name in poteto-mode architect arena swarm interrogate tdd how why unslop setup-pstack; do
      if printf '%s' "$LISTED" | grep -q "$name"; then
        FOUND=$((FOUND + 1))
      else
        fail "qodercli skills list does not show /$name"
      fi
    done
    if [[ "$FOUND" -eq 10 ]]; then
      pass "the 10 core workflows are discoverable (of $EXPECTED_SKILLS skills on disk)"
    fi
  else
    skip "qodercli skills list returned nothing; discovery may need an install"
  fi

  if [[ "$INSTALL" -eq 1 ]]; then
    SMOKE_CWD="$(mktemp -d)"
    echo "       smoke cwd: $SMOKE_CWD"
    if "$QODERCLI" --cwd "$SMOKE_CWD" plugin install --scope local "$ROOT"; then
      pass "plugin install --scope local"
      AGENTS="$("$QODERCLI" --cwd "$SMOKE_CWD" agents list 2>/dev/null || true)"
      MISSING=0
      for path in agents/*.md; do
        seat="$(basename "$path" .md)"
        if ! printf '%s' "$AGENTS" | grep -q "$seat"; then
          fail "agent $seat was not discovered after install"
          MISSING=$((MISSING + 1))
        fi
      done
      [[ "$MISSING" -eq 0 ]] && pass "all $SEAT_COUNT seats discovered after install"

      printf '%s' "$AGENTS" | grep -qi shadowed \
        && fail "a seat is shadowed, which means a same-name agent outranks the plugin copy"

      "$QODERCLI" --cwd "$SMOKE_CWD" plugin uninstall --scope local pstack-qoder >/dev/null 2>&1 \
        && pass "uninstalled the smoke copy"
    else
      fail "plugin install --scope local"
    fi
    rm -rf "$SMOKE_CWD"
  else
    skip "pass --install to verify seat discovery in a throwaway cwd"
  fi
fi

# ---------------------------------------------------------------------------
# Packaging hygiene. Cheap, and it is what stops junk shipping.
# ---------------------------------------------------------------------------

section "6. packaging hygiene"
JUNK="$(find . -name .DS_Store -o -name '__MACOSX' -o -name '__pycache__' \
        -o -name 'settings.local.json' -o -name '*.pyc' | head -n 5)"
if [[ -n "$JUNK" ]]; then
  fail "local state in the package: $JUNK"
else
  pass "no .DS_Store, __pycache__, .pyc, or settings.local.json"
fi
for banned in .cursor-plugin .claude-plugin .codex-plugin; do
  if [[ -e "$banned" ]]; then
    fail "$banned/ at the plugin root competes with .qoder-plugin/"
  fi
done
[[ -f .qoder-plugin/plugin.json ]] && pass ".qoder-plugin/plugin.json present" \
                                   || fail ".qoder-plugin/plugin.json missing"

# ---------------------------------------------------------------------------

printf '\n%s\n' "passed $PASSED, failed $FAILED, skipped $SKIPPED"
if [[ "$FAILED" -gt 0 ]]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
exit 0
