# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

Install from Qoder's plugin marketplace, or from a checkout with the CLI:

```text
qodercli plugin install --scope local /path/to/pstack-qoder
```

Qoder then lists the plugin as enabled.

This copy is the Qoder port of pstack, cut from `https://github.com/cursor/plugins/tree/main/pstack`. Upstream also ships adapters for other editors, and those prefix every command with the plugin name. This port has no prefix, so you type each command in this guide exactly as written. Read [COMPATIBILITY.md](../../COMPATIBILITY.md) before you rely on a step that needs a scheduled trigger, a bot code reviewer, or a second machine, because those are the three things Qoder does not have.

## Pick your models

Run:

```text
/setup-pstack
```

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) asks which models your Qoder account can reach, asks for a reasoning budget, shows you each seat (implementation, architecture, judgment, the review panels, verification), and asks what you want. Answer the questions. It writes two things. `agents.overrides` in `settings.json` is what actually changes the models, and `~/.claude/rules/pstack-models.md` is a small rule every pstack skill reads so it can report the truth about what ran.

The defaults are the same as the `large` budget. Implementation and architecture run on the `opus` alias, the three review panel seats run on `opus`, `sonnet`, and `auto` so the panel is genuinely mixed, and judgment and verification run on `auto` and `sonnet`. Effort is `xhigh` for architecture and `high` everywhere else, and no seat ships above `xhigh`. Those aliases resolve to whatever model Qoder maps them to on your account, so read the concrete names off your own model picker rather than trusting a page to name them. `medium` lowers each seat's effort one step and `small` lowers it two, and both spend fewer tokens.

You only override what you care about. A seat with no entry in `agents.overrides` keeps the default in its agent file under the plugin's `agents/` directory. To restore a default, delete that seat's entry. A rerun of `/setup-pstack` keeps any seat whose model differs from the default. When a plugin update changes a default, an override written before the update still pins the old one until you run `/setup-pstack` again. That run replaces the old defaults it recognizes, tells you which, and keeps your other choices. To drop a pin it does not recognize, delete that seat's entry first.

You might be wondering what happens if you use Auto. Set a seat to `inherit` and that agent follows the session model instead of carrying its own. `auto` means something different in Qoder, because it is a real alias that lets Qoder pick per turn rather than following you, so the two are not interchangeable the way they were upstream. Upstream also set panel size by writing a list of models on one seat, with one subagent per entry. Qoder binds one model to one agent, so this port ships three panel seats and the panel is three wide. A wider panel means authoring more agents under `agents/`. Setup also configures the three support seats, `pstack:pstack-explorer`, `pstack:pstack-mechanic`, and `pstack:comment-sicko`, and `/swarm` workers run on `pstack:pstack-verifier` unless a slice writes product code.

## Accept the verification offers, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.claude/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to pstack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

Then setup offers once to generate a formal verification skill with [`/create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md), unless the project already has one. Tests check the cases someone thought to write. A formal verification skill checks one key property of your code, such as "a job never runs twice at once", in every case within a stated scope. Say yes when your code has concurrency, retries, a state machine, or a parser, where a bug is costly and tests rarely reach the case that breaks. Otherwise say no, and run it later if that changes. [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers it.

After setup, start a new chat. Both the override and the rule apply to new sessions, so neither change reaches the chat you are in. If a seat still reports its old model in the new chat, restart Qoder, because Qoder documents no reload path for `agents.overrides` in the IDE.

## Keep the cost in check

pstack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `/setup-pstack` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code seats is a good split.
- Set a seat to `inherit` so it runs on the chat's own model.
- Shorten a panel. Dispatch two of the three panel seats instead of all three.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt.

From here you can type normal follow-ups. Qoder has no per-skill mode, so `/poteto-mode` does not stay attached for the whole chat on its own. Typing it loads the skill for the turns that need it, and it fades as the chat moves on. When you want the discipline on every turn, put it in a rule under `.qoder/rules/`, which is the mechanism Qoder does reload every turn, and accept that it then applies to the casual turns too. Otherwise start each new task with `/poteto-mode`.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
