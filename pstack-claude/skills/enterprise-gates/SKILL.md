---
name: enterprise-gates
description: Use before running git push, opening or merging a PR, deploying, changing infrastructure, or running a database migration or seed, and use whenever a shell command is refused or an approval prompt appears. Explains the enterprise gates, what a refusal means, and what to report.
---
# Enterprise approval gates

This plugin can ship approval gates that stop a destructive or outward-facing shell command and ask a human before it runs. They are enforced by Claude Code hooks, which sit outside the model, so no amount of reasoning inside a turn talks one out of firing.

A gate is only live in a repository that opted in by writing `.claude/enterprise/gates.json`. `/setup-enterprise` writes that file. In any other repository these gates do nothing at all.

## What gets gated

Three classes, each with a pattern list the project owns.

| Class | Typical commands |
|---|---|
| push | `git push`, `gh pr create`, `gh pr merge` |
| deploy | anything containing `deploy`, plus `kubectl apply`, `kubectl delete`, `kubectl rollout`, `terraform apply`, `terraform destroy`, `helm install`, `helm upgrade` |
| migration | anything containing `migrate`, `migration`, or `seed`, plus `alembic upgrade`, `prisma migrate`, `flyway migrate` |

Read-only commands are not gated. `kubectl get`, `git status`, and `terraform plan` run without a prompt.

The authoritative list is the project's own policy file, not this table. Read `.claude/enterprise/gates.json` when the distinction matters, since a project can narrow a class, widen it, or switch it off.

## When a gate fires

The command stops and a human is asked. Three outcomes are possible.

**Approved.** The command runs and an audit line is appended to `.claude/enterprise/approvals.jsonl`. Continue.

**Refused.** The command does not run. Report the refusal to whoever asked for the work, with the command and the gate class, and stop that line of work. Do not retry it, do not rephrase it to dodge the pattern, and do not split it into smaller commands that each look harmless. Working around a gate is the one response that turns a control into a decoration, and it is visible in the audit log as an action with no ask behind it.

**Ungated.** A gated command ran and nothing asked. That means the hooks are not firing, which is a broken control rather than a passed one. Say so in the report instead of treating the silence as permission.

## What to do before a gated action

Name the gate before running the command, in one line, so the human reading along is not surprised by a prompt.

Keep the command minimal and specific. `git push origin feature/x` is easier to approve than a compound line that pushes, tags, and deploys, and a compound command tripping several gates at once produces a prompt nobody can answer confidently.

Never batch a gated action into a longer shell command to avoid the prompt. If a step needs approval, let it ask on its own.

## What the gates do not cover

They match on the `Bash` tool only. A push performed through an MCP server, a file written directly by the `Write` tool, and anything a human types in their own terminal all go ungated. So does every action in a repository that never opted in.

A gate is a checkpoint on the paths someone thought to cover. It is not a sandbox, and describing it as one overstates what a reviewer can rely on.

## The protected boundary

Agent credentials cannot merge to a protected branch and cannot approve a deployment. Branch protection, required reviewers, CODEOWNERS enforcement, and CI quality gates are configured on the platform and nothing in this plugin writes or reads them, so a hook can stop a command inside a session and cannot make a branch protected. Where a workflow says a human merges or authorizes, that is a person holding the authority, not a seat reporting that it asked. Say which of the two you meant, because "gated" and "merged" read alike in a summary and are not alike in a repository.
