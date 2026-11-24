### Autonomous run

**You own the exit condition. Define done, then drive to it without stopping.**

1. State the exit condition as a checkable predicate before the first iteration (tests green, repro fixed, all N PRs merged, pixel-diff zero).
2. Pick the wait mechanism, and know that it only waits inside this run. Qoder has no timer, so nothing re-enters this playbook after the turn ends. Do not promise the user an unattended run that outlives it. An event to watch (CI, a merge, a ref advancing) gets a blocking watcher subagent that polls until the event fires and returns once, on the `pstack-verifier` seat, with a stated ceiling on how long it polls and what it returns on timeout. No event gets an inline poll you drive yourself between iterations, sized to when the result is worth re-checking. Name the seat rather than a reasoning level, since each seat carries its own effort. When the ceiling is reached and the predicate is not met, stop and write a resume note per `pause-safely.md` so the next invocation continues rather than restarts.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help. Belt-and-suspenders that "might help" gets reverted, not left to ride.
   Sequence the work via the **sequence-verifiable-units** principle skill, verifying each unit before the next instead of batching checks at the end.
4. Mid-run discoveries that support the goal are yours. Address broken skills, related bugs, flaky verifiers, review noise, tooling failures, orphaned follow-ups, and fixable drift yourself via poteto-mode. Put out-of-band fixes in their own PR. Do not park reversible work for the human or use `AskUserQuestion`. Surface only irreversible actions, genuine product or preference calls no experiment can settle, or a real dead end. Keep the predicate as the main drive, and return to it after each side fix.
5. Checkpoint every iteration via the **show-me-your-work** skill, a row for what changed and whether the predicate moved.
6. Stop when the predicate is met. A plateau is not a stop, so keep going and pivot your approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory.

**Reply:** the exit condition, iterations run, what landed, what was discarded, final predicate state, and whether the run ended on the predicate or on a ceiling that needs a resume note.
