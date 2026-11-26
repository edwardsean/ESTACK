---
name: no-comments
description: "Spawn Comment Sicko, fix accepted findings, and offer encodings for claimed constraints. Runs only when the user types /no-comments, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: estack skills are manual-only, so the `Skill` tool refuses them. To run another estack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "estack:<seat>"`.

# No comments

Spawn Comment Sicko. Act on accepted findings.

Defer to Comment Sicko's fresh perspective.

**Port note.** In this build the `estack:comment-sicko` seat is read-only. It has `Read`, `Grep`, `Glob`, and `Bash`, and no write tools, so it reports comments to delete and symbols to reshape and never edits anything. You own every edit. Its `deletion count` is the count of comments it flagged, not the count it removed, and there is no diff to inspect from it. Upstream shipped the same contract in its README while its agent file claimed write access. This port resolves that contradiction toward read-only, so a runaway reviewer cannot touch the tree.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Spawn the `Agent` tool with `subagent_type: "estack:comment-sicko"`. Pass the scope. Pick each subagent's seat and reasoning level for the job. Start from the seat's line in `~/.claude/rules/estack-models.md` and pass `effort` on the `Agent` call, higher than the line when the job needs it. See the Subagents section of the **poteto-mode** skill. Do not restate its rules.
2. Inspect its report. It proposes and you dispose, so read every flag against the code yourself before acting. Reject application-code edits it should not have proposed, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, trace their symbol or run `/why` on it. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Revert and rerun one rejected report with the failure named. Reject a second, report it open, and fail `/no-comments`.
3. Apply the accepted deletions yourself. The seat flagged them and cannot remove them, so nothing lands until you edit. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run `/architect` once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the count of comments flagged and the count you actually deleted, restored comments, reruns, architect sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
