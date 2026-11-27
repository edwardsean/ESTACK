---
name: handover
description: "Record the session's state so a fresh session can continue it. Use when the engine says context is filling, or when the owner wants to /clear and keep going. Runs only when the user types /handover, optionally with a task id."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "estack:<seat>"`.

# Handover

Save what a fresh session needs to carry on, then let the owner clear the context. Record state and pointers. Do not summarise code in prose, because the next session re-reads the files itself.

Never hand over mid-step. Finish the step you are on first.

## Without a task id (the CTO's handover)

1. Stop dispatching new work. Wait for running workers to report, then review what they returned.
2. Call the estack `handover` tool with:
   - `goal`: the owner's goal for the session.
   - `plan`: the remaining work not yet started as a task, one item per entry.
   - `decisions`: each decision as `what` and `why`.
   - `open_questions`: what is still unanswered.
   - `files`: files that matter beyond the ones the tasks changed, such as a spec or a config the next session must read.
3. If the tool refuses because workers are busy, wait for them. Set `workers_done` only when you know those workers are really finished, such as a worker that has already reported or one that was cancelled.
4. Tell the owner in one line to run `/clear`. The new session resumes by itself.

This handover covers every open task bound to the session, so the new session picks up all of them.

## With a task id

Do the same for that one task. Call `handover` with `task_id`, plus `decisions`, `open_questions` and `files` for that task. Skip `goal` and `plan`. Then tell the owner to run `/estack:resume <task id>` in a fresh session, or `/clear` if it is the only task.

## Do not

- Do not write a prose recap of the code or the diff. The engine records steps, evidence and commits itself.
- Do not hand over with a step half done.
- Do not skip a decision because it seems obvious. The reason behind it is what the next session cannot re-derive.
