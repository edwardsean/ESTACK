---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration. Runs only when the user types /swarm, or when the poteto-mode orchestrator routes to it."
disable-model-invocation: true
---

> Claude Code: pstack skills are manual-only, so the `Skill` tool refuses them. To run another pstack skill named here, read `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and follow it. Seats dispatch as `subagent_type: "pstack:<seat>"`.

# Swarm

## Start

Open a todo list with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Pick the worker seat. Workers verify, so they run on `pstack:pstack-verifier`. Read-only slices that only search and report run on `pstack:pstack-explorer` instead, and slices that write product code run on `pstack:poteto-agent`. Read `Swarm workers:` and the chosen seat's line in `~/.claude/rules/pstack-models.md` when that file exists, and pass that line's `model` and `effort` on every worker's call. For a model race, name the model per arm up front and pass a different `model` on each arm's call. A race that passes one model three times is not a model race, and you should say so.
4. Give each worker its own writable output when it writes. `pstack:pstack-verifier` carries `isolation: worktree`, so a worker that only edits code already has its own checkout. Anything that writes outside the repo needs an explicit path in the brief. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message with the `Agent` tool, one call per worker, `subagent_type` set to the seat chosen in step 3. Subagents run in the background by default, so the workers run concurrently and each notifies you when it finishes. There is no cloud environment and no cloud base branch, so every worker runs on this machine. Pass `isolation: "worktree"` on any worker call whose seat does not already carry it and whose slice writes.

When a worker must start from a branch that is not the default, say so in the brief and make the worker check it out itself, with the exact `git worktree add <path> <branch>` or `git checkout` command spelled out. A worktree from `isolation: "worktree"` starts from the current commit, so a different base is the worker's first command.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Ask each worker to name its model on its first line. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps. Collect the worktree paths the workers report so Phase D can merge or discard them deliberately.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, any worktree left behind, and the race rule when used.
