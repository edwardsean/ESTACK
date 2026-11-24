### Security assessment

**You own the question an attacker would ask.** Read-only by design. This step produces findings, not patches, because a seat that can edit the code it is auditing has an incentive to make the audit pass.

1. Dispatch `ent-security-engineer`, which carries no write tools, with the change under review, the trust boundaries it crosses, and the data classification of what it touches. Where the assessment needs to run a scanner, the seat runs it and reports; it does not remediate.
2. Enumerate the new attack surface first. Every endpoint added, every input now parsed, every secret now read, every permission now checked, every queue or webhook now accepted from outside. A finding count without a surface count tells a reviewer nothing about coverage.
3. Check against the repository's own stated security requirements before checking against a generic list. Load the matching entries from `.qoder/enterprise/knowledge/index.md` and any business rule card that constrains the data. A control the platform already enforces is worth recording as present, and worth naming as absent when it is assumed rather than verified.
4. Classify each finding by exploitability and blast radius, not by severity label. Who can reach it, what do they need already, what do they get, and how far does it spread. "High" is a guess until those four are answered.
5. Turn the blocking findings into gates on the plan. A finding that stays in a report is a finding that ships. Name the gate, the step it blocks, and the human who has to accept it if the team decides to ship anyway.
6. Say what you did not check. An assessment that lists only what it covered invites the reader to assume the rest is clean.

**Reply:** the attack surface enumerated, findings by exploitability and blast radius, the control that answers each, which findings became gates on the plan, and the checks deliberately skipped.
