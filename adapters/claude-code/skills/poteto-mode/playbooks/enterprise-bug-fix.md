### Enterprise bug fix

**You own the fix and the review the policy attaches to it.** This is **bug-fix** plus the governance step, and it is not a license to make a small fix large. Most bug fixes never leave the first two delegation modes, and this playbook is the one that says so out loud.

1. Reproduce before anything else. Follow **bug-fix** and do not leave it until the failure is observable on demand. A fix for an unreproduced bug is a guess with a commit message, and the review steps downstream will spend their effort on the wrong thing.
2. Read the governance policy for the touched services. `.claude/enterprise/governance.json` says which change types require architecture review, security approval, or DBA review, and which of those are advisory plan steps rather than enforced gates. A bug fix in a payments path and a bug fix in a log formatter are the same size of diff and not the same size of risk.
3. Attach only the reviews the policy names. Dispatch each to a seat that did not write the fix, `estack:ent-code-reviewer` for the diff, `estack:ent-security-engineer` where the policy asks for security approval. An author approving its own fix is the failure mode the whole seat design exists to prevent.
4. Check whether the bug violates a business rule card. When it does, the fix is incomplete until the card says what the rule is, because the code was wrong about a rule nobody had confirmed. Offer **prd-rules** once to extract and confirm it, and record whether the offer was taken.
5. Enter delivery at step 1 of the pipeline, with the review findings resolved or explicitly accepted by a named human. An accepted finding is not a closed finding, and the report has to show which it was.

**Reply:** the reproduction and the mechanism behind the failure, the review steps the policy attached and what each found, the business rule card implicated if any, and anything a human accepted rather than the team fixed.
