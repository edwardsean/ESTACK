### Enterprise feature development

**You own a feature that crosses services and still lands as one coherent change.** This is the longest chain in the registry, and it is only the right chain when the feature genuinely spans more than one service or one team. A single-service feature runs **feature** instead.

1. Confirm the requirements exist and are testable. Run **requirements-analysis** when they do not, and **prd-creation** when the change is large enough that a stranger has to build from it. Skipping either is a decision to record, not a default.
2. Confirm the design and the reviews the governance policy attaches to it. Run **architecture-design**, then check `.claude/enterprise/governance.json` for whether this change type requires **architecture-review**, **security-assessment**, or a DBA step. Where the policy says none are required, say so and name the policy line you read, because a silent skip and a forgotten skip look identical afterwards.
3. Fix every contract before dispatching in parallel. Run **api-contract-design** on each boundary two teams will build against. Parallel work on a moving contract produces two correct implementations that do not talk to each other.
4. Dispatch one engineering seat per service, each with a context packet holding only that service's slice: its contract, its rules, its ownership constraints. Never the whole knowledge store. `{{estack:ns}}:ent-backend-engineer` for service code, `{{estack:ns}}:ent-frontend-engineer` for the web surface, `{{estack:ns}}:ent-mobile-engineer` for the client, `{{estack:ns}}:ent-integration-engineer` for the glue between them.
5. Sequence the work that is not independent. Anything sharing a migration, a schema, or a single deployable runs in order, not in parallel, and the shared piece lands first via **database-migration**.
6. Verify the seams, then enter delivery. Run **integration-testing** across every boundary you fixed a contract for, then hand the result to step 1 of the delivery pipeline in `skills/poteto-mode/SKILL.md`, which is implementation through independent verification before a PR is opened.

**Reply:** the chain steps you ran and the ones you skipped with the policy line behind each skip, the contracts fixed and their versions, the seat dispatched per service, and the integration evidence that the seams hold.
