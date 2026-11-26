---
name: in-your-own-words
description: "Restate in your own words what you think the user's goals are and what problem they're trying to solve. Use for /in-your-own-words. Runs only when the user types /in-your-own-words, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "{{estack:ns}}:<seat>"`.

Restate in your own words what you think the user's goals are and what problem they're trying to solve.
