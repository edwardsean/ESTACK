---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape. Runs only when the user types /arena, or when the poteto-mode orchestrator routes to it."
---
# Arena

Open a todo list with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. They are the three panel seats, `pstack-panel-1`, `pstack-panel-2`, and `pstack-panel-3`. Qoder binds a model to an agent rather than to a call, so each seat is one model and `/setup-pstack` is what changes them. Read `Panel diversity:` in `.qoder/rules/pstack-models.md` when that file exists, and say in the synthesis note which model each seat actually reported running on. Keep at least two runners. Spawn more seats for multiple design directions, and run one seat twice when the work is generation-bound rather than judgment-sensitive. If two seats report the same model, the panel has no diversity there. Say so rather than pretending the arms were independent.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill. The three panel seats already carry `isolation: worktree`, so a candidate that only writes code needs no path of its own. Give one to any candidate that produces a document or a report file.

## Phase B: Fan out

Spawn all N runners in one message with the `Agent` tool, one call per seat. One message is the whole of Qoder's parallelism here. There is no per-call background flag and no cloud environment, so the calls run as Qoder schedules them and you get every result when the message returns. Each prompt carries the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected. Tell each runner to report its model on its first line.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, spawn one read-only judge on the `pstack-judge` seat. The judge is never the author of a candidate, and it should not run on the model that is driving this chat. `/setup-pstack` records what it chose under `Judge independence from the parent model:` in `.qoder/rules/pstack-models.md`. Qoder cannot check that at dispatch time, so ask the judge to report its model and compare it yourself. When the check did not hold, say that in the synthesis note instead of implying the judge was independent. While you read in Phase D, the judge scores each candidate, by path label, on each rubric criterion and recommends a base.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the model each seat reported running on, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
