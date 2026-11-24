# Connectors and external requirements

This plugin needs **no credentials, no API keys, no MCP servers, and no SaaS
accounts**. The manifest declares no `mcpServers` and no `hooks`, and no agent
file sets either. Qoder's plugin safety policy would strip them anyway.

Nothing here is a placeholder waiting for a token. This file exists to state that
plainly and to list the things the plugin does depend on, so a failure has
somewhere obvious to look.

## Required

| Dependency | Needed for | How to check |
|---|---|---|
| A Qoder account with model access | Every seat. `model: performance`, `efficient`, `lite`, and `auto` are aliases that resolve against your account | Run `/model`, Qoder's model wizard, and confirm the aliases you care about resolve to something |
| A git repository in the workspace | `isolation: worktree` on `pstack-panel-1`, `-2`, `-3`, and `pstack-verifier`. Also the orchestrator's own worktree steps | `git rev-parse --show-toplevel` |
| Folder trust on the project | Project-level and local-level `settings.json` are ignored in an untrusted directory, so a shared team override silently does not apply | Qoder's trust prompt, or `security.folderTrust.enabled` in settings |

If the workspace is not a git repository, the four worktree-isolated seats cannot
get an isolated checkout. Dispatch still runs, but the isolation guarantee that
keeps a panel arm's work separate from the others is gone. The orchestrator is
told to name the worktree path in its report, so an empty path is the tell.

## Optional

| Dependency | Needed for | Notes |
|---|---|---|
| `qodercli` on `PATH` | Local install (`qodercli plugin install --scope local`), `qoder agents list`, and the runtime half of `scripts/selftest.sh` | `selftest.sh` detects its absence and skips those checks with a message rather than failing. It was absent on the machine that built this port |
| Network egress | The `WebFetch` and `WebSearch` tools on `poteto-agent`, `pstack-panel-1`, `-2`, `-3`, `pstack-verifier`, and `pstack-explorer` | Seats that lack those tools work fully offline. `pstack-architect`, `pstack-judge`, `pstack-mechanic`, and `comment-sicko` never reach the network |
| Background subagent sessions enabled in settings | Any agent carrying `background: true` | No agent in this plugin sets it. The orchestrator is told not to promise a detached run, because the flag is a per-agent default and not something a caller can request per dispatch |
| A code review bot on the project | `skills/poteto-mode/references/bot-triage.md` | Bot-agnostic. Upstream's version was written for Cursor Bugbot, which does not exist in Qoder. The ported file triages a report from whatever reviewer the project actually runs, and says to skip the step when there is none |

## Explicitly not used

Recorded so nobody goes looking, or worse, assumes one of these is wired up:

- **No MCP servers.** None declared in the manifest, none referenced by any
  agent's `mcpServers` field. Adding one to a plugin agent would be stripped by
  the plugin safety policy, so it has to be configured at the user or project
  level instead.
- **No hooks on agents.** The plugin safety policy strips `hooks` from an agent's
  frontmatter, so no seat can carry one. The plugin manifest can declare them,
  and this port does, since `hooks/enterprise-gates.json` ships the approval
  gates. What hooks still cannot do is re-enter a run on a schedule. Every
  documented event is a lifecycle or filesystem event and none is a timer, so the
  wake loop upstream's overnight runs depended on has no equivalent.
  `asyncRewake` comes closest. A background hook that exits 2 has the CLI inject
  a system reminder and wake the model, but a lifecycle event still has to start
  that hook, so it can watch for something inside a run and cannot restart one
  from nothing. This path is documented rather than verified here, because
  `qodercli` is not installed on the machine the port was built on.
- **No external scheduler or webhook endpoint.** Upstream's `automations/` tree
  is excluded from this package. Wiring a cron job to drive the IDE is not
  recommended and was not tested: a headless trigger has no session to run in.
- **No cloud or remote execution environment.** All isolation is local git
  worktrees. Nothing continues running with the laptop closed.
- **No `cursor-team-kit` dependency.** Upstream called `/deslop`, `control-ui`,
  and `control-cli` from that separate vendor plugin. None is ported, none is
  required, and the instructions that used to call them now state the intent in
  plain words. See [COMPATIBILITY.md](./COMPATIBILITY.md).

## If something fails to load

1. `/agents reload`, or start a new chat.
2. Confirm the ten `pstack-*` seats plus `poteto-agent` and `comment-sicko`
   appear under the Plugin source in `/agents`, or in `qoder agents list`.
3. Check the `/agents` panel for load errors. A malformed frontmatter block is
   the usual cause, and `python3 scripts/selftest.py` catches that class of
   problem statically before you ever install.
4. If a seat dispatches but reports an unexpected model, check
   `agents.overrides` at all three settings levels. Local overrides project,
   project overrides user, and a stale entry from an earlier `/setup-pstack` run
   keeps pinning the old model until you delete it or run setup again.

## Related

- [README.md](./README.md) for install and usage
- [docs/MODEL-ROUTING.md](./docs/MODEL-ROUTING.md) for configuring seats
- [COMPATIBILITY.md](./COMPATIBILITY.md) for the full feature matrix
