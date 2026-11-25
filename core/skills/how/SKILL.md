---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation. Runs only when the user types /how, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "{{estack:ns}}:<seat>"`.

# How

Explore the codebase to answer "how does X work?" questions.

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

## 1. Explain

Spawn one subagent with the `Agent` tool and `subagent_type: "{{estack:ns}}:estack-explorer"`. That seat is read-only by construction. It has `Read`, `Grep`, `Glob`, `Bash`, and web tools, and no write tools, so there is no per-call readonly flag to pass. Claude Code enforces the restriction through the agent's tool list instead. Give it the user's question and this brief:

> You are writing an architectural explanation for a senior engineer. Explore the codebase and write an explanation that a senior engineer unfamiliar with this area could read and walk away with a solid mental model. They should understand the architecture well enough to start working in it confidently. You have read-only access to the codebase. Report the model you ran on in your first line.

The seat's own contract already carries this brief. Send it anyway, so the answer does not change if a user repoints the seat's model in `{{estack:models_file}}`.

When the question is really "why is it shaped this way", use the **why** skill instead. That skill answers from the commit and PR record and runs inline in this chat by default. Hand it to `{{estack:ns}}:estack-explorer` when the record is large enough to need its own context, using the record-reading brief in that seat's contract.

## 2. Present

Present the subagent's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it. Keep the model line, since it is the only evidence of which model actually answered.
