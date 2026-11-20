# Progress

Port of pstack-qoder to a Claude Code plugin. Updated at each milestone.

- [x] Lever `scripts/port-from-qoder.py` written, first run seeded the tree
- [x] Gate clean (80 rules, 15 hand-owned files)
- [x] Manifest, marketplace, hooks.json; `claude plugin validate .` passes
- [x] Self-tests ported (`selftest.py`, `test-gates.py` 46 assertions, `selftest.sh`)
- [x] Provenance docs (README, COMPATIBILITY, PORTING-NOTES, CONNECTORS, MODEL-ROUTING)
- [x] Verification: lever idempotent, hook smoke test, leftover grep

Not done, by design: installing the plugin into the user's Claude Code config.
Open: no live session has dispatched a seat or fired a gate.
