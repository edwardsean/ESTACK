---
name: setup
description: Turn the enterprise layer on for this repository. Runs estack init to create the policy at .estack/policy.yaml and install git hooks, seeds the knowledge index at .claude/enterprise/knowledge/index.md so retrieval is scoped instead of bulk, and writes the governance policy at .claude/enterprise/governance.json that says which change types need which review. Use for /setup, "enable approval gates", "turn on enterprise gates", "configure which commands need approval", or "set up enterprise knowledge and governance".
---

# Setup enterprise

The estack plugin ships an enterprise layer that stays dormant until a repository opts in. This skill is the opt-in. It sets up up to three things, and each one does a different kind of work.

| File | What it controls | Enforced by |
|---|---|---|
| `.estack/policy.yaml` | Which edits need a task, which commands are denied, asked or automatic, which paths are protected | The engine, through Claude Code hooks and git hooks, outside the model |
| `.claude/enterprise/knowledge/index.md` | What the orchestrator reads, and only that | Nothing. It scopes retrieval |
| `.claude/enterprise/governance.json` | Which change types need which review | The orchestrator's plan |

Only the first is enforcement. The engine runs in hooks, which sit outside the model, so no amount of reasoning inside a turn talks one out of firing. The other two shape what a run reads and what it plans, and a run that ignores them is not stopped by anything. Say which is which whenever you report on this file, because "configured" reads as "enforced" and here it usually is not.

Sections 1 to 7 set up the gates. Sections 8 and 9 seed the knowledge index and the governance policy, and a repository that only wants gates can stop after section 7.

## 1. Check the runtime first

Do this before writing anything. The edit and shell-command hooks fail closed when the engine cannot run, which is the safe direction for a gate and the wrong surprise for a user.

- Confirm `node` is on PATH and is version 22.5 or newer, since the engine uses `node:sqlite`. If it is not, stop and say so. In an opted-in repository every edit and shell command would be refused, and the fix is to install Node or not to opt in.
- Confirm the repository is a git repository. The engine keeps its state in the main checkout and binds tasks to branches.
- Confirm the estack plugin is installed, since the hooks are registered from its manifest. Without it there is no hook to fire and the policy file does nothing.
- Say plainly that hook firing cannot be proven from here. Section 7 is the check that proves it.

## 2. Decide what the policy should say

`estack init` writes a default `.estack/policy.yaml`. Read it with the user before moving on, because the defaults are a starting point and not a policy.

| Part | What it does |
|---|---|
| `actions.auto` / `ask` / `deny` | Which actions run freely, need the owner's approval, or are refused |
| `patterns` | How a shell command maps to an action. Defaults cover `git_push`, `merge`, `deploy`, `db_migration` and `force_push_protected` |
| `task_types` | The steps each kind of task goes through |
| `protected_paths` | Paths nobody edits, such as `.env*` and the policy file itself |
| `exempt_paths` | Paths editable with no task, such as markdown and `docs/` |
| `commands.test`, `commands.verify` | What the engine itself runs for the test and verify steps. Set these to the real commands for this repository |
| `handover.threshold`, `handover.window_tokens` | Optional. The engine suggests a handover once the session's context passes `threshold` (a fraction, default `0.5`) of `window_tokens` (default `200000`) |

The `handover:` keys are optional and look like this:

```yaml
handover:
  threshold: 0.5
  window_tokens: 200000
```

If the owner runs a model with a 1M-token context, set `window_tokens: 1000000`. Otherwise the percentage reads too high and the engine suggests a handover far too early.

Show the pattern list for each action class and invite edits. The deploy and migration patterns are the least portable part of this design because every team names those commands differently. The defaults match command forms (`npm run deploy`, `terraform apply`, `prisma migrate deploy`, and so on), so a team that deploys or migrates through its own script name needs to add that pattern, and local dev migrations such as `prisma migrate dev` stay ungated. Offer to add or narrow any pattern the user thinks will miss or misfire.

Read-only commands are deliberately absent. `kubectl get`, `git status`, and `terraform plan` are not gated, because a gate that fires on reading is a gate people turn off within a week.

## 3. Ask where it lives

The policy is project level, `.estack/policy.yaml`, and should be committed so everyone gets the same rules. There is no user-level policy. When someone wants gates everywhere, tell them to run this skill in each repository, or to commit the file to a shared template.

`.estack/state.db` is per-machine task state. Make sure it is gitignored, and say so.

## 4. Set up the code map

The code map is a Graphify index of the repository that lets agents see existing code before they write new code. It is optional and can be off. Do this before running init, since the choices go into the policy.

- Run `graphify --version`. If it is missing, or the version is outside `>=0.9.121,<0.10`, show the owner the install command (`uv tool install "graphifyy>=0.9.121,<0.10"`) and let them choose: install it first, or set up with the map off (`--code-map off`).
- Run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/engine/estack.mjs" map suggest`. It lists folders and files that look like build output, vendored code or generated code. Walk the owner through each suggestion, folder by folder, and keep any generated code their own code calls into, such as a generated database or API client, since agents need to see it. Pass the confirmed list to init as `--exclude "<glob>,<glob>"`.

These choices apply on first setup only. Init never overwrites an existing policy, and `.estack/policy.yaml` is protected, so any later change to `code_map` is the owner's to make.

## 5. Run init

Run the engine's init in the project root:

```bash
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/engine/estack.mjs" init --engine "${CLAUDE_PLUGIN_ROOT}/engine/estack.mjs"
```

Add `--code-map off` if the owner chose no map, and `--exclude "<globs>"` with the confirmed list. Without `--code-map`, the map turns on when a supported Graphify is found and stays off otherwise. Init prints a message only when the map is off because Graphify was not found. When the map is on, the build line is the signal.

Report each line it prints. It creates `.estack/policy.yaml` and `.estack/brief.md`, and it installs the git hooks `pre-commit` and `pre-push`, which run the same engine so a commit or push made by an agent through git itself is checked too. They act only when an agent runs git (`CLAUDECODE=1`), and the owner's own terminal is never checked. If it prints `git hooks not installed: core.hooksPath is set`, the repository routes hooks through its own directory. Say so, and tell the user that git-level enforcement is off until they call `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/engine/estack.mjs" git-hook pre-commit` and `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/engine/estack.mjs" git-hook pre-push` from their own hooks (with `CLAUDE_PLUGIN_ROOT` replaced by the plugin's real path, and the pre-push hook's stdin passed through). The Claude Code hooks still apply either way. If it chained an existing hook, say so.

`.estack/brief.md` is for the owner to fill in: it is where the project's goals and constraints go, and the engine does not write them for you. Init is safe to re-run and never overwrites an existing file. The repository is opted in once `.estack/policy.yaml` exists.

With the map on, init builds it and prints the folder shares, the biggest folders by share of the map. Show them and ask whether any big folder is a copy of other code, such as a vendored library or a mirrored package. If one is, tell the owner to edit the `exclude:` line under `code_map` in `.estack/policy.yaml` to include the glob, for example `exclude: ["upstream/**"]` (add it to the existing list if there is one), and let them make the edit themselves. The agent cannot edit that file.

Then tell the owner to commit `.estack/` themselves. Report that they should run, in their own terminal:

```bash
git add .estack && git commit -m "Add estack policy"
```

The agent must not try to commit it: the git pre-commit hook refuses any agent commit that touches the protected `.estack/policy.yaml` ("commit touches protected .estack/policy.yaml"). Future edits to `policy.yaml` are likewise the owner's to make and commit.

When the owner edits the policy later, the change takes effect on the next hook with no restart.

## 6. Retire the old policy

If `.claude/enterprise/gates.json` exists, it is superseded. Nothing reads it any more, and an old `approvals.jsonl` next to it is history only. Tell the owner, and offer to delete both. Do not delete them unasked, and do not port the old patterns silently: show the old patterns and offer to merge any the owner added by hand into `.estack/policy.yaml` under `patterns`.

## 7. Prove it works

Do not report success on the strength of a written file. A policy file that nothing reads is indistinguishable from one that works.

Ask the user to try an edit to a source file, such as `src/probe.ts`, before starting a task. The edit should be denied with a message telling the agent to call `start_task`. Then ask for a gated command that cannot do damage:

```bash
git push --dry-run
```

That matches the `git_push` action. In the main session it should prompt the owner or be denied for lack of verify evidence, and nothing is pushed. If neither happens, work through these in order.

1. Is the plugin installed, and does its manifest declare `hooks`?
2. Does `.estack/policy.yaml` exist at the project root Claude Code started in, rather than a subdirectory?
3. Is `node` on PATH inside the environment Claude Code runs hooks in, which can differ from an interactive shell?
4. Did the hook error? Errors land in Claude Code's debug output rather than in the chat. Run `claude --debug`, or open `/hooks` to confirm the estack hooks are registered.

With the code map on, also check two things. Start a task with `start_task` and an `area` (a folder), and it should return context for that area. Then, in a fresh task, a Read or Grep before `reuse_check` should be denied once, until a `find_existing` or `context_for` search has run.

Report which of these it was, or say that it is unresolved, rather than claiming the gates are active.

## 8. Seed the knowledge index

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

## 9. Seed the governance policy

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
      "enforcedBy": ["hook:git_push"]
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
      "enforcedBy": ["hook:db_migration"]
    },
    "auth-payments-or-pii": {
      "architecture": "required",
      "security": "required",
      "dba": "advisory",
      "enforcedBy": ["hook:git_push"]
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

## 10. Say what this plugin cannot enforce

Some of what an enterprise architecture calls a gate lives on the platform and is out of reach here. Branch protection, required reviewers, CODEOWNERS enforcement, and CI quality gates are all configured in the forge and the pipeline, and nothing in this plugin writes or reads them. A hook can stop a command inside a session. It cannot make a branch protected.

Say so whenever this skill writes a governance policy that names a review, so nobody reads `required` here and assumes the platform is checking it too. The honest split is that this plugin plans and prompts, and the platform enforces.

## 11. Report

Tell the user what was written and what each file does, keeping enforcement and intention visibly separate.

- That `.estack/policy.yaml` exists, which action classes are `auto`, `ask` and `deny`, and the test and verify commands set.
- Whether git hooks were installed, chained, or skipped, and why.
- The pattern list for each action class, since that is the actual policy.
- That edits to the policy take effect on the next hook, with no restart. Registering the hooks in the first place is the plugin's job and happens when the plugin loads.
- That the hooks apply to every session in this repository, not only to runs of `/poteto-mode`. A plain chat that tries to edit source with no task, or to `git push`, gets the same answer. That is intended, and it surprises people.
- Which knowledge kinds got a real location and which read `not indexed`, since the second list is the work left to do.
- Which change types carry a `required` review backed only by `plan`, named explicitly, because those are the ones a team believes are gated and are not.
- What the gates cannot stop. Anything a human types in their own terminal is never checked, since the git hooks act only when an agent runs git. A push made through an MCP server that is not estack's own, and any tool the hook matcher does not list, go ungated. Say so rather than letting "gated" imply "contained".

## Turning it off

Delete `.estack/policy.yaml` and the hooks go dormant, exiting on a single file test without starting Node. The git hooks stay in `.git/hooks` until removed, and they too do nothing without a policy. An absent knowledge index makes the orchestrator report that it has no store rather than inventing one, and an absent governance policy makes it attach no review steps and say so. To keep the file and relax a rule, move the action between `auto`, `ask` and `deny` in the policy.
