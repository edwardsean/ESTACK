---
name: principle-foundational-thinking
description: "Apply before writing logic: choosing core types and data structures, sequencing scaffold-vs-feature work, asking what concurrent actors share. Get the data structures right so downstream code becomes obvious. Runs only when the user types /principle-foundational-thinking, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "estack:<seat>"`.

# Foundational Thinking

Get the data shape right before writing logic. Define core types early, trace every access pattern, and choose structures that match the dominant paths. DRY the structure, not every line.

Before sharing state between actors, ask what happens if another actor modifies it concurrently. If the answer is not "nothing", isolate.

Scaffold first. Whatever helps every later phase (CI, tests, shared types) goes first, after removing dead code. Keep commits small and single-purpose.
