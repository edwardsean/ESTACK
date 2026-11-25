### PRD creation

**You own the document a stranger could build from.** Distinct from `/prd-rules`, which reads an existing PRD and extracts the confirmed business rules out of it. This playbook writes the PRD.

1. Start from the requirements analysis for this run when there is one. When the request arrived with a PRD already written, do not write a second one. Run **prd-rules** instead and route from there.
2. State the problem in one paragraph before any solution appears. Name the users, the observable behavior each of them gets, and the measure that says done. Implementation detail in a PRD is a decision made before the design step, and it will be defended later only because it was written down first.
3. Write behavior as checks that can fail, carried over from requirements analysis. A PRD whose acceptance section cannot be handed to QA is a statement of intent.
4. Record the contested readings, not just the winner. Where two readings of a rule were both defensible, write both, name who chose, and say what would change the answer. That record is what stops the same argument reopening in review.
5. Split out-of-scope from deferred. Out-of-scope will not be built. Deferred will be built later and needs an owner. One list called "not now" hides that difference.
6. Route any business rule that is still contested back through **prd-rules** step 4, which is the confirmation gate. A rule nobody confirmed does not enter the PRD as settled.

**Reply:** the PRD path, the contested readings with who resolved each, the deferred list with owners, and whether the governance policy attaches a review step to this change type.
