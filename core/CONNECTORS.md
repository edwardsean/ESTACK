# Connectors and external requirements

This plugin needs **no credentials, no API keys, no MCP servers, and no SaaS
accounts**. The manifest declares no `mcpServers`, and no agent file sets
`mcpServers`, `hooks`, or `permissionMode`, which Claude Code ignores on plugin
subagents anyway. The one thing it declares beyond skills and agents is
`hooks/hooks.json`, the approval gates, which stay dormant in every repository
that has not opted in.

## Required

| Dependency | Needed for | How to check |
|---|---|---|
| Claude Code with plugin support | Everything | `claude --version`, then `claude plugin list` after install |
| Claude Code v2.1.292 or later | The per-call `effort` parameter every dispatching skill passes from `{{estack:models_file}}` | `claude --version`. Older builds run each seat at its frontmatter effort |
| A git repository in the workspace | `isolation: worktree` on the panel seats, `{{estack:ns}}:estack-verifier`, and the five engineering seats, plus `isolation: "worktree"` on any other dispatch | `git rev-parse --show-toplevel` |
| `python3` on `PATH` in the hook environment | The approval gates, in a repository that opted in. The gate fails closed without it | `command -v python3` from the shell Claude Code runs hooks in |

If the workspace is not a git repository, a worktree-isolated seat gets no
isolated checkout. The seats are told to name their worktree path in their
report, so an empty path is the tell.

## Optional

| Dependency | Needed for | Notes |
|---|---|---|
| Network egress | `WebFetch` and `WebSearch` on `{{estack:ns}}:poteto-agent`, the panel seats, `{{estack:ns}}:estack-verifier`, `{{estack:ns}}:estack-explorer`, and `{{estack:ns}}:ent-integration-engineer` | Seats without those tools work fully offline |
| `gh` or Origin's `origin` CLI | The shipping, babysit, and autopilot playbooks | Forge access is the user's own credential, never the plugin's |
| A code review bot on the project | `skills/poteto-mode/references/bot-triage.md` | Bot-agnostic. Skip the step when there is none |
| MCP servers for a wiki or tracker | `/prd-rules` and `/recall` when the knowledge lives outside the repo | Configure them at user or project level. Plugin seats cannot declare them, so those steps dispatch `general-purpose`, which keeps the session's MCP servers |

## Explicitly not used

- **No MCP servers.** None declared, none referenced by any agent.
- **No cloud or remote execution.** All isolation is local git worktrees, and
  `/loop` lives in the session that armed it. Nothing continues with the laptop
  closed.
- **No external scheduler or webhook endpoint.** Upstream's `automations/` tree
  is not part of this package. Claude Code's `/schedule` cloud routines were not
  tested against it.
- **No `cursor-team-kit` dependency.** The instructions that used to call its
  skills state the intent in plain words.

## If something fails to load

1. Run `/reload-plugins`, or start a new session.
2. Run `/agents` and confirm the 28 `{{estack:ns}}:` seats are listed, and `/hooks` to
   confirm the three estack hooks.
3. `claude plugin validate <path-to-estack>` reports manifest and
   frontmatter problems. `python3 scripts/selftest.py` catches the same class of
   problem statically.
4. If a seat reports an unexpected model, check its line in
   `{{estack:models_file}}`, then `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` and
   `CLAUDE_CODE_EFFORT_LEVEL`, which override everything the file says.

## Related

- [README.md](./README.md) for install and usage
- [docs/MODEL-ROUTING.md](./docs/MODEL-ROUTING.md) for configuring seats
- [COMPATIBILITY.md](./COMPATIBILITY.md) for the full feature matrix
