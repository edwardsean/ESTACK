### Integration testing

**You own the seams.** Unit tests prove a service works on its own assumptions. This step proves two services agree about what they actually send each other, which is the part that fails in production and passes everywhere else.

1. List the seams before writing a test. Every boundary the change crosses, with the contract version each side believes it is implementing. A seam nobody listed is a seam nobody tested, and the list is what makes coverage a claim rather than a hope.
2. Test against the fixed contract, not against the implementation (**principle-test-behavior-not-implementation**). Where the two disagree, stop and route it back to **api-contract-design**, because a test written from the implementation locks in whatever the implementation happened to do.
3. Use the real driver wherever you can get one. Where you cannot, name the substitute and the blind spot it creates. A stub that always returns success has not tested the error path, and an in-memory double has not tested serialization, latency, or a partial failure.
4. Cover the failure shapes the contract promised. Timeouts, retries after a partial write, an out-of-order message, a response from the previous contract version. These are the cases the happy path suite reports as passing while the integration is broken.
5. Dispatch `estack:estack-verifier` for the seams whose failure is invisible until production, and let it prove the claim rather than restate it. The verifier is never the author of the code under test.
6. Route every failure back to the service that owns it. A failing seam is not fixed in the test, not retried until it goes green, and not waived by whoever wrote the change.

**Reply:** the seams tested, the contract version each was tested against, the real drivers used and the substitutes with their blind spots named, and the failures you routed back with the owning service for each.
