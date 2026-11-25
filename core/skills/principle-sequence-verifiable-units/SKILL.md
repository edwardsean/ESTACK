---
name: principle-sequence-verifiable-units
description: "Apply to multi-step work (sweeps, migrations, runs of similar edits) and to how you stack commits and PRs. Break work into small units that each end in a verifiable state, check each before the next, and order delivery so the sequence proves itself to a reviewer. Runs only when the user types /principle-sequence-verifiable-units, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "{{estack:ns}}:<seat>"`.

# Sequence work into verifiable units

Order work as small units that each end in a state you can check, and do not advance until the current one is green.

In a sweep, migration, or run of similar edits, each unit is a bracket: known-good state, one change, run the check, proceed. Run the per-unit check even when a tool does the edits.

Deliver in the order that proves the work: the failing test first, then the fix. The subtraction before the reshape. The baseline before the treatment. Each commit lands on its own.
