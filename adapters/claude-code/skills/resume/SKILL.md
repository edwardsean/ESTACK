---
name: resume
description: "Pick up from a recorded handover in a fresh session. Use after /clear or in a new session, optionally with a task id. Runs only when the user types /resume, or when the engine's start-of-session hint tells the session to resume."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "estack:<seat>"`.

# Resume

Continue work from the state the last session recorded.

1. Call the estack `resume` tool. Pass the task id if one was given.
2. Read every file it lists before changing anything. The recorded state says where things stood, not what the code says now.
3. Tell the owner, briefly: the goal, the remaining plan, and each task's next step.
4. Continue under the rules in `${CLAUDE_PLUGIN_ROOT}/skills/poteto-mode/SKILL.md`. Trust the recorded steps and decisions, and re-read the code.

If `resume` reports nothing to resume, say so and ask the owner what to work on.
