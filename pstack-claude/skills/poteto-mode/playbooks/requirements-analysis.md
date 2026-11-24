### Requirements analysis

**You own the boundary between what was asked and what will be built.** A requirement that cannot fail a test is a wish, not a requirement.

1. Read the request and the touched services. Pull only the matching entries from `.claude/enterprise/knowledge/index.md` when the repository has one, plus the business rule cards at `.claude/skills/enterprise-*/SKILL.md` for the domain. Absence of a card is a gap to report, not a license to invent the rule.
2. Separate what was stated from what was assumed. Every assumed behavior gets a named owner to ask, and until it is answered it stays listed as open rather than designed around.
3. Write each requirement as an observable behavior with a check that can fail. "The service handles cancellation" is prose. "Canceling an order releases its reserved stock in one transaction" is a requirement.
4. Mark the non-goals. A scope line that only lists what is in scope filters nothing.
5. Hand the result to the orchestrator as the input to PRD creation, or straight to Architecture design when the change is small enough that a PRD would be ceremony.

**Reply:** the requirements with their failing checks, the assumptions still open and who owns each, the non-goals, and which chain step comes next.
