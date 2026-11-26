### Enterprise release management

**You own the order things land in, and the authority to say stop.** Nothing here merges anything. This step sequences the release and resolves who authorizes it, then hands each landing to **shipping** under that authorization.

1. Enumerate the ship order as a dependency list, not a schedule. Migrations before the code that reads the new shape, contracts before their consumers, flags before the behavior they hide. Write down why each edge exists, because an unexplained edge gets reordered by whoever lands second.
2. Give every node an owner and a rollback. A step in the sequence that nobody can revert is a step that turns a bad release into a bad week. Where a node cannot be rolled back, say so in the sequence and put the decision in front of a human before it runs, per **database-migration** for the schema case.
3. Resolve the authorization from `.claude/enterprise/governance.json` rather than assuming it. Record who approved, when, and what exactly they approved. An authorization that cannot be attributed is an authorization nobody will honor when the release goes wrong.
4. Name the gates that will fire. Push-class and deploy-class commands prompt the owner under `.estack/policy.yaml`, and `skills/enterprise-gates/SKILL.md` says what a refusal means. Announce each gate before the command so the prompt is expected, and never rephrase a refused command to slip past the pattern.
5. Sequence the landings with **shipping**, one node at a time, only after step 3 produced an authorization for it. **shipping** never merges on its own authority and neither does this playbook.
6. Hand the release to monitoring with the measure that says it failed. Name the metric, the threshold, and how long to watch. A release nobody is watching is a release that reports its own status through user complaints.

**Reply:** the dependency order with the reason for each edge, the owner and rollback per node, who authorized what and when, the gates that fired or were refused, and the monitoring measure handed off.
