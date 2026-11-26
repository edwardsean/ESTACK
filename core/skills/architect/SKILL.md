---
name: architect
description: "Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for /architect, 'architect this', 'design this', or non-trivial work where jumping to code would lock in the wrong shape. Runs only when the user types /architect, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "{{estack:ns}}:<seat>"`.

# Architect

Before writing code, trace every system the change touches, then sketch two different shapes for it (types, signatures, module boundaries) and pick the one where each piece of state has one owner, each task has one way to do it, and callers need to know least. Redesign instead of patching if workarounds repeat.

For a large or contested design, run the **arena** skill instead of sketching alone.

## The seat

This chat runs the sketch by default. Delegate to the `{{estack:ns}}:estack-architect` seat through the `Agent` tool, with `subagent_type: "{{estack:ns}}:estack-architect"`, when the design spans more systems than one turn holds comfortably, or when the shape should be argued by a seat that will not write the code it constrains.

That seat carries the architecture model and the highest effort of any seat in this port, so delegating is how a design gets the planning model rather than whatever model the chat happens to run. Claude Code could pass a model per call, but the seat also carries the architecture brief and the tool list, which is why it stays a seat.

Give the delegate file pointers rather than inlined context, plus these:

- The systems the change touches, by path.
- The constraint you cannot move.
- The done predicate, meaning two shapes sketched and one picked, with the fact that decided it.

Ask it to report the model it ran on in its first line, and cite that in your summary. The dispatcher can pass a different `model` on the `Agent` call, so the configured default is not evidence of what produced the design.
