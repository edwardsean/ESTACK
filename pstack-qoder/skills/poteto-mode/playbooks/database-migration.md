### Database migration

**You own the data and the way back.** A schema change is the one edit in a chain that survives a revert, so it is written as two migrations before either one runs.

1. Dispatch `ent-database-architect` with the current schema, the target shape, and the data volume that decides whether an online change is possible at all. A migration that is fine on ten thousand rows and fatal on ten million is the same migration until someone counts.
2. Write the forward migration and the rollback together. A rollback written after a failure is an invention under pressure. Where the change is genuinely irreversible, a destructive column drop for example, say so in the migration file and make the forward step a two-phase one instead.
3. Split expansion, migration, and contraction into steps that each ship and roll back alone (**principle-sequence-verifiable-units**). Add the nullable column first, backfill, cut reads over, then drop the old column in a later release. One migration that adds and drops in the same pass has no safe point to stop at.
4. Make every step safe to run twice (**principle-make-operations-idempotent**). A half-applied migration that cannot be resumed is a half-applied migration that gets hand-edited in production.
5. Name the gate before you run it. Migration-class commands prompt a human under `.qoder/enterprise/gates.json`, and the rule at `rules/enterprise-gates.md` says what a refusal means. State the class and the exact command in one line so nobody is surprised by the prompt, and never rephrase a refused command to dodge the pattern.
6. Record the change in the knowledge index and, where it settles a modeling argument, in an ADR. The next person reads the schema, not this chat.

**Reply:** both migrations, the expansion and contraction split, the data shape each step was tested against, the rollback proof, and the command that will prompt the migration gate.
