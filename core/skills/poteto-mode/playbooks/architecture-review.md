### Architecture review

**You own the second pair of eyes, and they must not be the author's.** This step joins a chain only when the governance policy requires it for this change type. Check `.claude/enterprise/governance.json` first and say plainly when it does not, so the skip is a decision on the record rather than an omission.

1. Resolve whether this change type requires architecture review. When the policy marks it advisory, run it as a plan step and report the findings without blocking. When the policy marks it enforced, it is a gate and the chain does not continue past it unresolved.
2. Dispatch the review to a seat that did not produce the design. `{{estack:ns}}:ent-system-architect` reviewing its own output is not a review, and neither is the orchestrator summarizing what it already agreed with. Where the design came from `{{estack:ns}}:ent-system-architect`, send the review to `{{estack:ns}}:ent-code-reviewer` or to a different architecture seat with the author's reasoning withheld from the packet.
3. Review against the binding constraints, not against taste. Load the ADRs, the service ownership map, and any platform standard the repository names. "I would have used a queue" is a preference. "This crosses a team boundary the ownership map says is not ours to write to" is a finding.
4. Classify every finding as blocking, advisory, or wrong. Wrong means the reviewer misread the design, and saying so out loud is part of the output, because it stops the author fixing a problem that does not exist.
5. Return the findings. The reviewer does not edit the design and does not approve it. Approval belongs to the human gate named in the governance policy, and a reviewer that signs its own verdict has removed the check the step existed to provide.

**Reply:** findings by class, the constraints each was checked against, the seat that produced them, and disclosure of whether that seat ran on the same model as the author.
