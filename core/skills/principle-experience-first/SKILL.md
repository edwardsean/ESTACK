---
name: principle-experience-first
description: "Apply when product, UX, or feature-scope tradeoffs come up. Choose user delight over implementation convenience; ship fewer polished features over more rough ones. Runs only when the user types /principle-experience-first, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "{{estack:ns}}:<seat>"`.

# Experience First

When implementation convenience conflicts with user delight, choose delight.

- Every feature, control, and option must be justified
- Ship less, ship better (polished experience with three features beats rough one with ten)
- Prototype before committing (design decisions are cheaper in throwaway HTML than production code)
- Get the details right (transitions, alignment, spacing, feedback, error states)
- Tighten the core loop (every feature should serve the central workflow or get out of the way)

The user is whoever consumes the work. For a UI that is the end user. For a library or an internal API it is the colleague who imports it. The engineer who maintains the code next is a user too. Weigh their experience the same way, and explain impact from their perspective.

Foundations should serve the experience. Foundational thinking governs the *sequence* of work. This principle governs the *target*.
