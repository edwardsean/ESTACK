---
name: principle-minimize-reader-load
description: "Apply when reviewing or shaping code that's hard to trace. Count layers between question and answer, and hidden state in the reader's head; collapse one-caller wrappers and shrink mutable scope. Runs only when the user types /principle-minimize-reader-load, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: pstack skills are manual-only, so the `Skill` tool refuses them. To run another pstack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "pstack:<seat>"`.

# Minimize Reader Load

Reader load is the work a reader must do to understand code. It has two independent axes: layers to trace between the question and the answer, and hidden or mutable state to hold in their head. Guard both.

- Collapse layers that only forward: wrappers with one caller, adapters with no second implementation, pass-through methods. Inline them.
- Shrink state scope: returns over mutations, locals over fields, fields over module state, module state over globals. Derive instead of sync.
- Name an invariant once at the boundary, not in every consumer.

The test: can a new reader answer "where does X come from?" and "what can change X?" in under 30 seconds? If not, cut layers or cut state.
