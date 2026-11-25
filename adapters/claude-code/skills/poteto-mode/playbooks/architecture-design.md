### Architecture design

**You own the shape before the code.** This is the design step of an enterprise chain, and it dispatches the architecture family rather than doing the design inline.

1. Trace every system the change touches before drawing anything. Read the service catalog and ownership map from `.claude/enterprise/knowledge/index.md` when the repository has one. A design that only covers the service you were pointed at is how a cross-service feature becomes three half-integrations.
2. Dispatch `estack:ent-system-architect` with a context packet holding the requirements, the touched services, and the binding constraints. Add `estack:ent-api-architect` when a service boundary moves, and `estack:ent-database-architect` when the data model moves. Say which seats you dispatched and which you deliberately did not.
3. Sketch two genuinely different shapes, not one shape and a strawman (**principle-exhaust-the-design-space**). Name the failure mode each one is good at surviving and the one it is bad at.
4. Fix contracts before anyone builds against them. Where two teams would otherwise start in parallel, run **api-contract-design** here and treat its output as the boundary both sides code to.
5. Name the schema change and its way back. Where the design implies a migration, run **database-migration** so the forward path and the rollback are written together rather than the rollback improvised at 2am.
6. Record the decision as an ADR and add its path to the knowledge index. A design that lives only in this chat is a design the next person will rediscover wrongly (**principle-encode-lessons-in-structure**).

**Reply:** the chosen shape, the rejected one and the reason it lost, the contracts now fixed, the rollback path, and the ADR location. Name the seats that produced it.
