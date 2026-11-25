---
name: setup
description: Turn the enterprise layer on for this repository. Writes the approval gate policy at .claude/enterprise/gates.json, seeds the knowledge index at .claude/enterprise/knowledge/index.md so retrieval is scoped instead of bulk, and writes the governance policy at .claude/enterprise/governance.json that says which change types need which review. Use for /setup, "enable approval gates", "turn on enterprise gates", "configure which commands need approval", or "set up enterprise knowledge and governance".
---

# Setup enterprise

The estack plugin ships an enterprise layer that stays dormant until a repository opts in. This skill is the opt-in. It writes up to three files, and each one does a different kind of work.

| File | What it controls | Enforced by |
|---|---|---|
| `.claude/enterprise/gates.json` | Which shell commands stop and ask a human | Claude Code hooks, outside the model |
| `.claude/enterprise/knowledge/index.md` | What the orchestrator reads, and only that | Nothing. It scopes retrieval |
| `.claude/enterprise/governance.json` | Which change types need which review | The orchestrator's plan |

Only the first is enforcement. Gates run in hooks, which sit outside the model, so no amount of reasoning inside a turn talks one out of firing. The other two shape what a run reads and what it plans, and a run that ignores them is not stopped by anything. Say which is which whenever you report on this file, because "configured" reads as "enforced" and here it usually is not.

Sections 1 to 6 set up the gates. Sections 7 and 8 seed the knowledge index and the governance policy, and a repository that only wants gates can stop after section 6.

## 1. Check the runtime first

Do this before writing anything. The gate script fails closed when it cannot evaluate a command, which is the safe direction for a gate and the wrong surprise for a user.

- Confirm `python3` is on PATH. If it is not, stop and say so. Every gated command would be refused, and the fix is to install python3 or not to opt in.
- Confirm the estack plugin is installed, since the hooks are registered from its manifest. Without it there is no hook to fire and this file does nothing.
- Say plainly that hook firing cannot be proven from here. Step 6 is the check that proves it.

## 2. Ask what to gate

Use `AskUserQuestion`. Three classes, each independently switchable.

| Class | What it catches by default |
|---|---|
| `push` | `git push`, `gh pr create`, `gh pr merge` |
| `deploy` | anything containing `deploy`, plus `kubectl apply`, `kubectl delete`, `kubectl rollout`, `terraform apply`, `terraform destroy`, `helm install`, `helm upgrade`, `helm uninstall` |
| `migration` | anything containing `migrate`, `migration`, or `seed`, plus `alembic upgrade`, `prisma migrate`, `flyway migrate`, and `psql` or `mysql` invoked with an inline command |

Show the pattern list for each class before asking, and invite edits. The defaults are a starting point, not a policy, and the deploy and migration patterns are the least portable part of this design because every team names those commands differently.

Read-only commands are deliberately absent. `kubectl get`, `git status`, and `terraform plan` are not gated, because a gate that fires on reading is a gate people turn off within a week.

Warn about the broad patterns. `*deploy*` matches any command with that substring, including a harmless one, so a false positive is possible. The prompt names the pattern that fired, which makes one diagnosable in a single line instead of mysterious. Offer to narrow any pattern the user thinks will misfire.

## 3. Ask where to write it

Project level, `.claude/enterprise/gates.json`, is the default and the right choice for a team repo, because it is committed and everyone gets the same gates.

User level is not available for this file. The gate script looks under the project directory only, so a personal policy would need `CLAUDE_PROJECT_DIR` tricks that are not worth it. When someone wants gates everywhere, tell them to run this skill in each repo, or to commit the file to a shared template.

## 4. Write the policy

Merge rather than overwrite when a policy already exists. Read it first, show the user what changes, and keep any pattern they added by hand.

```json
{
  "schema": 1,
  "gates": {
    "push": {
      "enabled": true,
      "label": "git push or open PR",
      "patterns": ["git push *", "gh pr create*", "gh pr merge*", "git push"]
    },
    "deploy": {
      "enabled": true,
      "label": "deploy or infrastructure change",
      "patterns": ["*deploy*", "kubectl apply*", "kubectl delete*"]
    },
    "migration": {
      "enabled": true,
      "label": "database migration or data change",
      "patterns": ["*migrate*", "*migration*", "*seed*", "alembic upgrade*"]
    }
  },
  "audit": ".claude/enterprise/approvals.jsonl"
}
```

Set `enabled` to `false` for a class the user declined. Leaving it out is not the same, because the gate script treats a missing class as absent and a present one as configured, and an explicit `false` documents the decision.

`schema` must be `1`. A policy with any other value is refused by the gate, which is how a file from a future version fails loudly instead of being misread.

Patterns are shell globs matched case-sensitively against the command string. A pattern also matches when it appears after a shell prefix, so `git push *` catches `cd api && git push origin main`.

## 5. Handle the audit log

Approved actions are appended to the path in `audit`, one JSON line each, recording the timestamp, the gate class, the command, the session, the seat, and a truncated result.

Recommend gitignoring it. The log is per-machine session history, and a team that commits it gets a merge conflict on every concurrent push. Say that if they want a shared audit trail, the answer is to ship the log somewhere durable rather than to commit it, and that this skill does not do that.

Also note what the log cannot show. A command refused at the prompt never runs, so it never reaches `PostToolUse` and leaves only the `ask` line behind. An `ask` with no matching `exec` for the same `tool_use_id` is a denial or an abandoned run.

## 6. Prove it works

Do not report success on the strength of a written file. A policy file that nothing reads is indistinguishable from one that works.

Ask the user to run a gated command that cannot do damage, and confirm the prompt appears.

```bash
git push --dry-run
```

That matches the `push` class and pushes nothing. If the prompt appears, the hooks are live. If it does not, work through these in order.

1. Is the plugin installed, and does its manifest declare `hooks`?
2. Is the policy file at `.claude/enterprise/gates.json` relative to the project root Claude Code started in, rather than a subdirectory?
3. Is `python3` on PATH inside the environment Claude Code runs hooks in, which can differ from an interactive shell?
4. Did the hook error? Errors land in Claude Code's debug output rather than in the chat. Run `claude --debug`, or open `/hooks` to confirm the three estack hooks are registered.

Report which of these it was, or say that it is unresolved, rather than claiming the gates are active.

## 7. Seed the knowledge index

The orchestrator retrieves knowledge by deriving a query from the task class plus the touched services, then reading only the entries that match. That only works if something says where each kind of knowledge lives. Without an index a run either reads nothing or bulk-loads the repository, and bulk loading fills a delegate's context with material it will not use while crowding out the material it will.

Write `.claude/enterprise/knowledge/index.md`. One line per knowledge kind, each pointing at where it actually lives, a repository path or a URL.

Discover the locations rather than guessing them. Search the repository for each kind and propose what you find: a `docs/` or `architecture/` tree, a service list in a README, a CODEOWNERS file, an `openapi.yaml` or an `idl/` folder, a `migrations/` or `schema/` folder, an `adr/` folder, a `prd/` folder, existing rule cards under `.claude/skills/enterprise-*/`, an `integrations/` doc, a CI workflow folder. Show the user what you found and let them correct it. Where you find nothing, write `not indexed` and leave it.

```markdown
# Enterprise knowledge index

Written by /setup. One line per knowledge kind, pointing at where it
actually lives. Delete a line to drop that kind from retrieval. An entry reading
`not indexed` is a gap the orchestrator reports rather than fills in.

# schema: 1

architecture-docs: <path or URL>
microservice-catalog: <path or URL>
service-ownership-map: <path or URL>
api-documentation: <path or URL>
database-schemas: <path or URL>
adrs: <path or URL>
business-requirements: <path or URL>
business-rules: <path or URL>
integration-docs: <path or URL>
existing-workflows: <path or URL>
```

The `# schema: 1` line marks the format. Entries are kebab-case kinds so a query can match them mechanically, and the value is whatever a reader can open.

Two limits to state plainly. This indexes; it does not import. A company wiki, a Confluence space, and a Notion database stay where they are, and an entry pointing at one is a URL the run may or may not be able to fetch. And an index full of `not indexed` is not a failure, it is an honest picture of a repository that keeps its knowledge in someone's head. Report it as the second one.

## 8. Seed the governance policy

The governance policy says which change types need which review, and the orchestrator resolves it into named steps on the plan before it delegates anything. A review discovered after the work is done is a review that gets skipped.

Write `.claude/enterprise/governance.json`. Ask the user which change types matter to them and what each one needs, offering the shape below as a starting point rather than a policy.

```json
{
  "schema": 1,
  "reviews": {
    "architecture": { "seat": "ent-system-architect", "neverTheAuthor": true },
    "security": { "seat": "ent-security-engineer", "neverTheAuthor": true },
    "dba": { "seat": "ent-database-architect", "neverTheAuthor": true }
  },
  "changeTypes": {
    "cross-service-feature": {
      "architecture": "required",
      "security": "advisory",
      "dba": "none",
      "enforcedBy": ["hook:push"]
    },
    "single-service-feature": {
      "architecture": "advisory",
      "security": "none",
      "dba": "none",
      "enforcedBy": ["plan"]
    },
    "bug-fix": {
      "architecture": "none",
      "security": "none",
      "dba": "none",
      "enforcedBy": ["plan"]
    },
    "schema-change": {
      "architecture": "advisory",
      "security": "none",
      "dba": "required",
      "enforcedBy": ["hook:migration"]
    },
    "auth-payments-or-pii": {
      "architecture": "required",
      "security": "required",
      "dba": "advisory",
      "enforcedBy": ["hook:push"]
    },
    "infrastructure": {
      "architecture": "advisory",
      "security": "required",
      "dba": "none",
      "enforcedBy": ["hook:deploy"]
    }
  }
}
```

Each review is `none`, `advisory`, or `required`. `advisory` is a plan step the orchestrator should run and may skip with a recorded reason. `required` is a plan step it must run and must report on.

`neverTheAuthor` is the invariant that makes a review worth running. The seat named there must not be the seat that produced the work, and `estack:ent-security-engineer` and `estack:ent-code-reviewer` carry no write tools at all for exactly that reason.

Read `enforcedBy` carefully before describing any of this as a gate. `plan` means nothing outside the model stops the change, so a `required` review under `plan` is a strong instruction and not a control. Only a `hook:` entry names something enforced, and it is enforced against a command class rather than against the review itself. A change type whose only backing is `plan` still relies on the run doing what it said.

`schema` must be `1`. Change types are open-vocabulary, so a team can rename them, add their own, and drop any of the six above. The orchestrator matches on the class it assigned in step 2 of its loop, and an unrecognized class gets the strictest treatment the file defines rather than the loosest.

## 9. Say what this plugin cannot enforce

Some of what an enterprise architecture calls a gate lives on the platform and is out of reach here. Branch protection, required reviewers, CODEOWNERS enforcement, and CI quality gates are all configured in the forge and the pipeline, and nothing in this plugin writes or reads them. A hook can stop a command inside a session. It cannot make a branch protected.

Say so whenever this skill writes a governance policy that names a review, so nobody reads `required` here and assumes the platform is checking it too. The honest split is that this plugin plans and prompts, and the platform enforces.

## 10. Report

Tell the user what was written and what each file does, keeping enforcement and intention visibly separate.

- The policy path, and which classes are on and off.
- The pattern list for each enabled class, since that is the actual policy.
- That edits to the policy file take effect on the next gated command, with no restart, because the gate script reads the file every time it runs. Registering the hooks in the first place is the plugin's job and happens when the plugin loads.
- That the gates apply to every session in this repository, not only to runs of `/poteto-mode`. A plain chat that tries `git push` gets the same prompt. That is intended, and it surprises people.
- Which knowledge kinds got a real location and which read `not indexed`, since the second list is the work left to do.
- Which change types carry a `required` review backed only by `plan`, named explicitly, because those are the ones a team believes are gated and are not.
- What the gates cannot stop. Anything a human types in their own terminal, any tool that is not `Bash`, and a push made through an MCP server all go ungated. Say so rather than letting "gated" imply "contained".

## Turning it off

Delete the file you want gone. An absent `.claude/enterprise/gates.json` is the dormant state for the hooks, which then exit on a single file test without starting an interpreter. An absent knowledge index makes the orchestrator report that it has no store rather than inventing one, and an absent governance policy makes it attach no review steps and say so. Set `enabled` to `false` per gate class to keep the file and drop a class.
