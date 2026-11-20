---
name: principle-encode-lessons-in-structure
description: "Apply when you catch yourself writing the same instruction a second time, or notice a recurring correction. Encode the rule as a lint, metadata flag, runtime check, or script instead of more text. Runs only when the user types /principle-encode-lessons-in-structure, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: pstack skills are manual-only, so the `Skill` tool refuses them. To run another pstack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "pstack:<seat>"`.
# Encode Lessons in Structure

If the lesson needs judgment and cannot be encoded, make the instruction more prominent and add an example of the failure mode.

**Corollary:** If the fix is structural, only use the structural fix. The instruction is the symptom.
