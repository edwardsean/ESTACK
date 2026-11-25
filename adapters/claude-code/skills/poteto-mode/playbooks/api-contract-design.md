### API contract design

**You own the surface other teams build against.** A contract is fixed so parallel work can start. Until it is fixed, every consumer is guessing and every guess becomes a change request later.

1. Name the consumers before writing a field. Dispatch `estack:ent-api-architect` with the list of services and clients that will call this, plus the one who will operate it. A contract designed against a single imagined caller is a private interface with a public URL.
2. Write it in whatever form the repository already uses, an IDL or schema file where one exists, prose with examples where one does not. Match the existing convention rather than introducing a second one, and put the file where the service's other contracts live.
3. Version from the first line. Decide what a breaking change means for this surface and write the compatibility rule down per field: which fields are additive-safe, which are frozen, which carry a deprecation window, and what happens to a client that ignores the window.
4. Cover the failure shapes, not just the success shape. Error codes, retry semantics, idempotency keys, pagination behavior past the last page, and what a timeout means about whether the write landed. Consumers integrate against the error path more often than the happy one.
5. Fix it and say when it stopped moving. Parallel dispatch is only safe after this point, per the orchestrator's rule that tasks must be independent. A contract still in flight is a shared dependency wearing a costume.
6. Route the consumers to **integration-testing** against this document, not against the implementation. Where the implementation and the contract disagree, one of them is wrong, and the contract is the thing that gets fixed.

**Reply:** the contract path and version, the per-field compatibility rules, the named consumers, the failure shapes covered, and the date it stopped moving.
