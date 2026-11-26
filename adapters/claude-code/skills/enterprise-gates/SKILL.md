---
name: enterprise-gates
description: Use before editing source files, running git push, opening or merging a PR, deploying, changing infrastructure, or running a database migration, and use whenever an edit or shell command is denied or an approval prompt appears. Explains the estack hooks, what a denial means, and what to report.
---
# Enterprise gates

In a repository that opted in, the estack engine runs inside Claude Code hooks and git hooks. They sit outside the model, so no amount of reasoning inside a turn talks one out of firing.

A repository is opted in when `.estack/policy.yaml` exists. `/estack:setup` creates it through `estack init`. In any other repository the hooks do nothing at all. The policy file is the authority on what is gated, so read it when the distinction matters, since a project can move an action between `auto`, `ask` and `deny` and can change the patterns.

## What is blocked, and why

| What | Rule | Why |
|---|---|---|
| Editing source files | Needs an open task bound to this session. Start one with the `start_task` tool (title, type, goal, done_check) | Work that no task owns has no steps and no evidence |
| Editing protected paths | Always denied, such as `.env*`, secrets folders, `.git`, and the policy file | These are the controls themselves |
| `git push`, `gh pr create` | Needs verify evidence on the task for the branch, then the owner's approval | A push is outward-facing and hard to take back |
| Merge, deploy, database migration | The owner's approval, every time | Same reason, with a bigger blast radius |
| Force push to a protected branch | Denied | Not recoverable |
| Anything that touches `.estack/state.db`, runs `estack skip`, `cancel` or `override`, uses `--no-verify`, or changes `core.hooksPath` or git hooks config | Always denied, and not configurable | These would switch the gates off |

Markdown, `docs/` and the project brief are exempt from the task rule. Read-only commands are not gated.

## Roles

The main session, which holds the owner's attention, gets the `ask` prompt for push, merge, deploy and migration. A worker seat never does. Its attempt is denied, because a worker has no owner to ask. **Workers never push.** A worker reports its commits back to the orchestrator, and the orchestrator decides.

## When a hook denies something

A denial is an answer, not an obstacle. Report it to whoever asked for the work, with the command or path and the reason the hook gave, and stop that line of work. Do not retry it, rephrase it to dodge a pattern, split it into smaller commands that each look harmless, or reach for a different tool to do the same thing. Routing around a gate turns a control into a decoration, and the engine's event log shows an action with no ask behind it.

The usual fixes are ordinary. A denied edit means starting a task. A denied push for missing verify evidence means running `run_check` with step `verify`. Do those, and only those.

There is an owner override for a push when no task fits: `estack override git_push --reason ...`. **Only the owner runs it, from their own terminal.** An agent never runs it, never suggests running it as a way past a denial, and never edits the policy to loosen a rule. If the owner decides to use it, they will say so.

## When a prompt appears

`ask` means the owner decides. Name the action in one line before running it so the prompt is not a surprise, keep the command minimal and specific, and never fold a gated action into a longer shell line to avoid the prompt. `git push origin feature/x` is easier to approve than a compound line that pushes, tags and deploys.

If a gated command ran and nothing asked or denied, the hooks are not firing. That is a broken control rather than a passed one. Say so in the report instead of treating the silence as permission.

## What the hooks do not cover

They match edit tools, `Bash` and the estack MCP tools. A push made through some other MCP server, and anything a human types in their own terminal, are outside the Claude Code hooks. The git hooks catch a commit or push from a terminal only when `estack init` installed them, and not when `core.hooksPath` pointed elsewhere. Every action in a repository that never opted in goes ungated too.

A gate is a checkpoint on the paths someone thought to cover. It is not a sandbox, and describing it as one overstates what a reviewer can rely on.

## The protected boundary

Agent credentials cannot merge to a protected branch and cannot approve a deployment. Branch protection, required reviewers, CODEOWNERS enforcement, and CI quality gates are configured on the platform and nothing in this plugin writes or reads them, so a hook can stop a command inside a session and cannot make a branch protected. Where a workflow says a human merges or authorizes, that is a person holding the authority, not a seat reporting that it asked. Say which of the two you meant, because "gated" and "merged" read alike in a summary and are not alike in a repository.
