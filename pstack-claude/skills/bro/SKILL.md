---
name: bro
description: "Restate the last message in plain human language, with no jargon. Runs only when the user types /bro, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: pstack skills are manual-only, so the `Skill` tool refuses them. To run another pstack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "pstack:<seat>"`.

Restate your last message. Stop using jargon and speak coherently. State it more simply and concisely, like one human talking to another.
