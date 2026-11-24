### Production incident management

**You own the clock and the communication, in that order.** Under an incident the temptation is to start reading code. Do not. The first output is what is broken for whom, and the first action is usually a rollback rather than a diagnosis.

1. State the break in one sentence from the user's side, with the blast radius. Which surface, which cohort, how many, since when. Where any of those is unknown, write unknown rather than a plausible number, because a guessed radius is what makes the wrong call look reasonable.
2. Dispatch `ent-sre` for the system view and `ent-observability` for the evidence, and tell both what the clock is. Neither seat controls the sequence and neither approves anything. The orchestrator keeps the plan and the state.
3. Check what changed inside the radius before checking what might be wrong. A deploy, a migration, a flag flip, a config edit, a dependency version. Most incidents are a recent change meeting a condition nobody tested, and the fastest fix is undoing the change.
4. Prefer rollback via **shipping** and say who authorized it. Deploy-class commands prompt a human under `.qoder/enterprise/gates.json`. Expedited approval means a named human reviewing faster, never a gate skipped and never a refusal rephrased. Where rollback is not possible, say why in one line, because "we cannot roll back" is the most expensive sentence in an incident and it deserves a reason on the record.
5. Run forensics after stabilization, not instead of it. Route to **runtime-forensics** for the process and **trace-forensics** for the request path, with the incident timeline handed over so the investigation does not start from nothing.
6. If the turn ends mid-incident, write a resume note per **pause-safely**. The next session inherits a live incident and has no memory of this one, so the note carries the break, the radius, what was tried, what was refused, and who is on the hook.
7. Close with the follow-up list, not the root cause. The root cause comes out of forensics and may take days. The follow-up list is what stops the same incident recurring next quarter.

**Reply:** the break and its radius with unknowns marked, the recent changes checked, the rollback decision and who authorized it, the gates that fired or were refused, the forensics handoff, and the follow-up list with an owner per item.
