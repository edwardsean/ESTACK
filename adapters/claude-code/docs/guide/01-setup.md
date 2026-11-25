# Set up estack

In this page you install the plugin, pick which models estack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

This plugin ships its own marketplace file, so a local checkout installs in two commands. In a Claude Code session:

```text
/plugin marketplace add /path/to/estack
/plugin install estack@estack
```

Or from a shell, `claude plugin marketplace add /path/to/estack` then `claude plugin install estack@estack`. `claude plugin list` then shows `estack@estack` as enabled.

This copy is the Claude Code edition of pstack, cut from `https://github.com/cursor/plugins/tree/main/pstack`. Claude Code prefixes plugin skills and agents with the plugin name, so `/poteto-mode` is `/estack:poteto-mode`, and the bare `/poteto-mode` also works unless another plugin claims the name. Read [COMPATIBILITY.md](../../COMPATIBILITY.md) before you rely on a step that needs a bot code reviewer, a second machine, or a judge from another model vendor, because those are the things this edition does not have.

## Pick your models

Run:

```text
/estack:setup-models
```

[`/setup-models`](../../skills/setup-models/SKILL.md) reads which models the `Agent` tool accepts in your session, asks for a reasoning budget, shows you each seat (implementation, architecture, judgment, the review panels, verification), and asks what you want. Answer the questions. It writes one file, `~/.claude/rules/estack-models.md`, with one `<seat>: <model> <effort>` line per seat you changed. Claude Code loads that file into every session, and every estack skill that dispatches a seat passes the line's model and effort on the `Agent` call.

The defaults are the same as the `large` budget. Implementation and architecture run on `opus`, the three review panel seats run on `opus`, `sonnet`, and `inherit` so the panel is mixed whenever your chat runs a third model, and judgment and verification run on `inherit` and `sonnet`. Effort is `xhigh` for architecture and `high` everywhere else, and no seat ships above `xhigh`. `medium` lowers each seat's effort one step and `small` lowers it two, and both spend fewer tokens.

You only override what you care about. A seat with no line keeps the default in its agent file under the plugin's `agents/` directory. To restore a default, delete that seat's line. A rerun of `/setup-models` keeps any line you already wrote.

`inherit` means the seat runs on the chat's own model. The `Agent` tool cannot take `inherit` as a value, so the dispatcher passes the chat's alias instead. Upstream set panel size by writing a list of models on one seat, with one subagent per entry. This edition ships three panel seats, so the panel is three wide, and because the model is a per-call parameter a dispatcher can run one seat twice on two models when it wants a wider bakeoff. Setup also configures the three support seats, `estack:estack-explorer`, `estack:estack-mechanic`, and `estack:comment-sicko`, and `/swarm` workers run on `estack:estack-verifier` unless a slice writes product code.

## Accept the verification offers, or don't

At the end of setup, `/setup-models` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.claude/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to estack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

Then setup offers once to generate a formal verification skill with [`/create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md), unless the project already has one. Tests check the cases someone thought to write. A formal verification skill checks one key property of your code, such as "a job never runs twice at once", in every case within a stated scope. Say yes when your code has concurrency, retries, a state machine, or a parser, where a bug is costly and tests rarely reach the case that breaks. Otherwise say no, and run it later if that changes. [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers it.

After setup, start a new chat. Claude Code loads `~/.claude/rules/` when a session starts, so the new lines are in context from the first turn there. In the chat you are in, ask the agent to read the file and the next dispatch uses it.

## Keep the cost in check

estack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `/setup-models` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code seats is a good split.
- Set a seat to `inherit` so it runs on the chat's own model.
- Shorten a panel. Dispatch two of the three panel seats instead of all three.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/estack:poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt.

From here you can type normal follow-ups. Claude Code has no per-skill mode, so `/estack:poteto-mode` does not stay attached for the whole chat on its own. Typing it loads the skill for the turns that need it, and it fades as the chat moves on. When you want the discipline on every turn, put it in `CLAUDE.md` or a rule under `~/.claude/rules/`, which Claude Code loads into every session, and accept that it then applies to the casual turns too. Otherwise start each new task with `/estack:poteto-mode`.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
