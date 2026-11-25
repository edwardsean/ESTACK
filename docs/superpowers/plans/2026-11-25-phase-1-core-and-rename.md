# Phase 1: core/ + generated Claude Code adapter + rename to estack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the harness content into an agent-neutral `core/`, generate the Claude Code plugin from it into `adapters/claude-code/`, and rename the plugin from `pstack` to `estack`, with behaviour otherwise unchanged.

**Architecture:** `core/` is the only place content is edited. A small TypeScript generator copies `core/` into `adapters/claude-code/`, replacing a fixed set of `{{estack:<name>}}` tokens with Claude Code values and copying binary files byte for byte. The generated tree is committed, because GitHub marketplace installs need it. A `--check` mode fails when the committed tree differs from what the generator would write, so hand edits in `adapters/` can't drift. The existing Python selftest, gate tests and hook scripts move into `core/` with the rest, renamed.

**Tech Stack:** Node 20+ (24 installed), TypeScript, `tsx` to run, `vitest` for tests. Python 3 for the existing selftest, which is kept as is apart from the rename.

**Spec:** `docs/superpowers/specs/2026-11-25-estack-engine-design.md`, sections 6 and 13 (phase 1).

## Global Constraints

- Plugin name `estack`. Skills are `/estack:<skill>`, seats are `estack:<seat>`.
- The models file is `~/.claude/rules/estack-models.md`.
- The root marketplace is named `estack` and its plugin entry has `"source": "./adapters/claude-code"`.
- Plugin and marketplace version: `0.1.0`.
- There are only two tokens: `{{estack:ns}}` → `estack` and `{{estack:models_file}}` → `~/.claude/rules/estack-models.md`. Any other `{{estack:...}}` is an error.
- Prose that says "Claude Code" is **not** made agent-neutral in this phase; that happens with the second adapter (phase 7).
- The approval gates keep their current behaviour and their current file, `.claude/enterprise/gates.json`, until phase 3 replaces them.
- No em dash (U+2014) or en dash (U+2013) in any file under `core/` except provenance docs, as enforced by the existing gate (`STYLE_PATTERNS`).
- No local absolute paths (`/Users/...`) in any committed file.

## Review Focus

1. **An unknown or misspelled token** such as `{{estack:nss}}` must fail the build and name the file; it must never ship unrendered. Owner: Task 1.
2. **A file deleted or renamed in `core/`** must disappear from `adapters/claude-code/`; stale seats or skills would still load. Owner: Task 1.
3. **Hook scripts must keep their executable bit**, or every hook fails at runtime with "permission denied". Owner: Task 1.
4. **Binary files** (`.png`, `.jpg`) must be copied byte for byte, never put through text rendering. Owner: Task 1.
5. **A leftover `pstack:` or `pstack-models` reference** in the generated plugin would dispatch to a seat that no longer exists. The selftest must fail on any. Owner: Task 3.

---

## File structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json` | Root Node project: scripts `build:claude`, `check:claude`, `test` |
| `adapters/generate.ts` | Agent-independent library: render tokens, build the file tree from `core/`, write it, diff it |
| `adapters/generate.test.ts` | vitest tests for the library |
| `adapters/build-claude-code.ts` | CLI: Claude Code token values, calls the library, `--check` mode |
| `core/` | All harness content (seeded from `pstack-claude/` in Task 2) |
| `core/scripts/content_gate.py` | The content gate (dash and vendor-coupling patterns), extracted from the retired lever |
| `adapters/claude-code/` | Generated. Never edited by hand |
| `.claude-plugin/marketplace.json` | Root marketplace, points at `./adapters/claude-code` |
| `tools/seed-core.mjs` | One-shot rename and seeding script, deleted in the same commit it is used in |

`pstack-qoder/` and `upstream/` stay unchanged as reference. `pstack-claude/` is deleted in Task 4 once the generated adapter passes.

---

### Task 1: Generator library and CLI

**Files:**
- Create: `package.json`, `tsconfig.json`, `adapters/generate.ts`, `adapters/generate.test.ts`, `adapters/build-claude-code.ts`
- Modify: `.gitignore` (add `node_modules/`)

**Interfaces:**
- Produces:
  ```ts
  export type Tokens = Record<string, string>;            // key "ns" renders {{estack:ns}}
  export interface TreeFile { content: Buffer; mode: number }
  export type Tree = Map<string, TreeFile>;              // key: posix path relative to root
  export const TEXT_SUFFIXES: ReadonlySet<string>;       // .md .json .sh .py .ts .txt .yaml .yml
  export function renderText(text: string, tokens: Tokens, file: string): string;
  export function buildTree(coreDir: string, tokens: Tokens): Tree;
  export function writeTree(outDir: string, tree: Tree): { written: string[]; removed: string[] };
  export function diffTree(outDir: string, tree: Tree): string[];   // sorted rel paths that differ, are missing, or are extra
  ```
  CLI: `npx tsx adapters/build-claude-code.ts` writes `adapters/claude-code/`. With `--check` it writes nothing, prints each differing path, and exits 1 if there are any. Claude Code tokens: `{ ns: "estack", models_file: "~/.claude/rules/estack-models.md" }`.

- [ ] **Step 1: Set up the Node project.** `package.json` with `"private": true`, `"type": "module"`, devDependencies `typescript`, `tsx`, `vitest`, `@types/node`, and scripts:
  ```json
  { "build:claude": "tsx adapters/build-claude-code.ts",
    "check:claude": "tsx adapters/build-claude-code.ts --check",
    "test": "vitest run" }
  ```
  Add a `tsconfig.json` with `strict: true`, `module`/`moduleResolution: "NodeNext"`, `noEmit: true`. Run `npm install`. Add `node_modules/` to `.gitignore`.

- [ ] **Step 2: Write the failing tests** in `adapters/generate.test.ts`. Each test builds fixtures in a `fs.mkdtempSync` directory:
  ```ts
  test("renders known tokens", () => {
    expect(renderText("run /{{estack:ns}}:arena", { ns: "estack" }, "a.md")).toBe("run /estack:arena");
  });
  test("unknown token throws and names the file", () => {
    expect(() => renderText("{{estack:nss}}", { ns: "estack" }, "skills/x/SKILL.md"))
      .toThrow("skills/x/SKILL.md: unknown token {{estack:nss}}");
  });
  test("non-estack braces are left alone", () => {
    expect(renderText("{{ user }}", { ns: "estack" }, "a.md")).toBe("{{ user }}");
  });
  test("binary files are copied byte for byte", () => {
    // core/img.png containing bytes [0x89,0x50,0x4e,0x47,0x7b,0x7b] -> tree entry equal to the same Buffer
  });
  test("executable bit is preserved", () => {
    // core/hooks/x.sh with mode 0o755 -> writeTree output file has (mode & 0o111) !== 0
  });
  test("junk is excluded", () => {
    // core/.DS_Store, core/scripts/__pycache__/a.pyc, core/b.pyc -> not in buildTree keys
  });
  test("stale files are removed", () => {
    // outDir has old.md that is not in the tree -> writeTree returns removed: ["old.md"] and the file is gone
  });
  test("second write changes nothing", () => {
    // writeTree twice -> second call returns { written: [], removed: [] }
  });
  test("diffTree reports changed, missing and extra paths", () => {
    // after writeTree: edit a.md, delete b.md, add c.md in outDir -> diffTree === ["a.md","b.md","c.md"]
  });
  ```

- [ ] **Step 3: Run the tests and make sure they fail.** Run `npx vitest run adapters/generate.test.ts`. Expected: FAIL, cannot import from `./generate`.

- [ ] **Step 4: Implement `adapters/generate.ts`** with the signatures above. Tokens match `/\{\{estack:([a-z_]+)\}\}/g`. Only files whose extension is in `TEXT_SUFFIXES` are decoded as UTF-8 and rendered. `writeTree` only writes a file when its content or its mode differs. It removes files in `outDir` that are not in the tree, then removes any directories left empty.

- [ ] **Step 5: Run the tests and make sure they pass.** Run `npx vitest run adapters/generate.test.ts`. Expected: 9 passed.

- [ ] **Step 6: Implement `adapters/build-claude-code.ts`.** It resolves `core/` and `adapters/claude-code/` relative to the repo root (from `import.meta.url`), so the output never contains absolute paths. Running it before `core/` exists must exit 2 with `error: core/ not found`.

- [ ] **Step 7: Commit.**
  ```bash
  git add package.json package-lock.json tsconfig.json .gitignore adapters/generate.ts adapters/generate.test.ts adapters/build-claude-code.ts
  git commit -m "Add the core-to-adapter generator"
  ```

---

### Task 2: Seed core/ from pstack-claude with the rename

**Files:**
- Create: `core/**` (from `pstack-claude/`), `tools/seed-core.mjs` (deleted again in Step 5)

**Interfaces:**
- Consumes: Task 1's `npm run build:claude`.
- Produces: `core/` containing tokens instead of names, and the renamed paths listed below. Later tasks use these names.

Path renames (relative to `pstack-claude/` → relative to `core/`):

| From | To |
|---|---|
| `agents/pstack-<x>.md` (architect, explorer, judge, mechanic, verifier, panel-1, panel-2, panel-3) | `agents/estack-<x>.md` |
| `skills/setup-pstack/` | `skills/setup-models/` |
| `skills/setup-enterprise/` | `skills/setup/` |
| `skills/pstack-seats/` | `skills/estack-seats/` |
| `scripts/port-from-qoder.py`, `scripts/port-report.json`, `PROGRESS.md`, `PORTING-NOTES.md`, `.claude-plugin/marketplace.json`, `.gitignore` | not copied |

Text substitutions, applied in this order to every text file:

| # | Pattern | Replacement |
|---|---|---|
| 1 | `~/.claude/rules/pstack-models.md` | `{{estack:models_file}}` |
| 2 | `pstack-models` | `estack-models` |
| 3 | `pstack-(architect\|explorer\|judge\|mechanic\|verifier\|panel-)` (regex) | `estack-$1` |
| 4 | `setup-pstack` | `setup-models` |
| 5 | `setup-enterprise` | `setup` |
| 6 | `pstack-seats` | `estack-seats` |
| 7 | `pstack:` | `{{estack:ns}}:` |
| 8 | the frontmatter `name:` line of each renamed agent or skill | its new name |

- [ ] **Step 1: Write `tools/seed-core.mjs`.** It copies `pstack-claude/` to `core/` (refusing to run if `core/` already exists), applies the path renames and the substitution table, and prints every remaining line that matches `\bpstack\b`, as `path:line: text`.

- [ ] **Step 2: Run it.** Run `node tools/seed-core.mjs`. Expected: `core/` exists, and a list of remaining `pstack` lines is printed.

- [ ] **Step 3: Resolve each remaining `pstack` line by hand in `core/`.**
  - Where it refers to **this plugin**, write `estack`. Examples: "the pstack plugin", "pstack skills are manual-only", the manifest `name`, script docstrings like "Static conformance for the Claude Code edition of pstack".
  - Where it refers to **upstream**, keep `pstack`. Examples: "pstack by Lauren Tan", the `cursor/plugins/tree/main/pstack` URL, "upstream pstack 0.15.43".
  - Set `core/.claude-plugin/plugin.json` to `"name": "estack"` and `"version": "0.1.0"`. Its description must credit pstack by Lauren Tan.

- [ ] **Step 4: Generate the adapter and confirm the rename is complete.** Run:
  ```bash
  npm run build:claude
  grep -rn "pstack:\|pstack-models\|setup-pstack\|setup-enterprise" adapters/claude-code
  ```
  Expected: the build exits 0, and grep prints nothing.

- [ ] **Step 5: Delete the seeding script and commit.** The selftest isn't expected to pass yet; that's Task 3.
  ```bash
  rm tools/seed-core.mjs
  git add core adapters/claude-code
  git commit -m "Seed core/ from pstack-claude and rename the plugin to estack"
  ```

---

### Task 3: Selftest and gate tests run against the generated adapter

**Files:**
- Create: `core/scripts/content_gate.py`
- Modify: `core/scripts/selftest.py`, `core/scripts/selftest.sh`, `core/scripts/test-gates.py`, then regenerate `adapters/claude-code/`

**Interfaces:**
- Consumes: the names from Task 2.
- Produces: `content_gate.gate_tree(root: Path, failures: list[str]) -> None`; `adapters/claude-code/scripts/selftest.sh` exits 0.

- [ ] **Step 1: Extract the gate.** Move these from `pstack-claude/scripts/port-from-qoder.py` into `core/scripts/content_gate.py`, unchanged apart from taking `root` as a parameter instead of the module global:
  - `STYLE_PATTERNS`, `FORBIDDEN_PATTERNS`, `GATE_SKIPS`, `GATE_SKIP_PREFIXES`, `GATE_SUFFIXES`, `GATE_ALLOW`
  - `strip_allowed`, `gate_file`, `gate_tree`

  Remove `"PORTING-NOTES.md"` and `"PROGRESS.md"` from `GATE_SKIPS`, since those files no longer ship. Then change `check_gate()` in `selftest.py` to `import content_gate` from its own directory and call `content_gate.gate_tree(PLUGIN_ROOT, failures)`.

- [ ] **Step 2: Add the leftover-name guard to `selftest.py`.** Add a `check_no_old_names()` that fails for any line in a shipped file matching `pstack:`, `pstack-models`, `setup-pstack` or `setup-enterprise`. Call it from `main()`.

- [ ] **Step 3: Update `selftest.py` for the new layout.**
  - `check_manifest()` requires `name == "estack"`.
  - The marketplace check reads `PLUGIN_ROOT.parent.parent / ".claude-plugin/marketplace.json"` and requires an entry named `estack` with `source == "./adapters/claude-code"`. It skips with a printed note when that file is absent, so the plugin folder can still be checked on its own.
  - The sets and regexes at lines 62 to 75 and 349 to 381 of the original use the new seat and skill names. Literal `pstack:` became `{{estack:ns}}:` in Task 2, so check the generated file reads `estack:`.

- [ ] **Step 4: Update `selftest.sh`.**
  - Delete section 5 (the lever re-run) and the `--rebuild` flag.
  - Add a section that runs `npm run --silent check:claude` from the repo root (`$ROOT/../..`), skipped with a message when `npm` is absent.
  - `test-gates.py` already has `agent_type` values renamed by Task 2. Run it to confirm.

- [ ] **Step 5: Add the root marketplace now**, because the selftest reads it. Write `.claude-plugin/marketplace.json` with name `estack`, owner `Edward Alexander`, and one plugin entry: `name: "estack"`, `source: "./adapters/claude-code"`, `version: "0.1.0"`, author Lauren Tan.

- [ ] **Step 6: Regenerate and run every check.**
  ```bash
  npm run build:claude && npm test
  (cd adapters/claude-code && bash scripts/selftest.sh)
  claude plugin validate .
  ```
  Expected:
  - `npm test`: 9 passed.
  - `selftest.sh`: `passed N, failed 0`.
  - The marketplace validator: `Validation passed`.

  Also: `python3 adapters/claude-code/scripts/test-gates.py` reports 46 passed, the same count as before the rename.

- [ ] **Step 7: Commit.**
  ```bash
  git add core adapters/claude-code .claude-plugin
  git commit -m "Run the selftest and gate tests against the generated estack plugin"
  ```

---

### Task 4: Retire pstack-claude/, update the README and diagrams, verify a live install

**Files:**
- Delete: `pstack-claude/`
- Modify: `README.md`, `docs/images/how-it-works.svg`, `docs/images/build-chain.svg`, `docs/images/how-it-works.png`, `docs/images/build-chain.png`

- [ ] **Step 1: Delete `pstack-claude/`.** Then confirm nothing outside `pstack-qoder/`, `upstream/` and `docs/superpowers/` still points at it:
  ```bash
  git rm -rq pstack-claude
  grep -rn "pstack-claude" --exclude-dir=node_modules --exclude-dir=.git . | grep -v "^./pstack-qoder/\|^./upstream/\|^./docs/superpowers/"
  ```
  Expected: no output.

- [ ] **Step 2: Update `README.md`.**
  - Install: `/plugin install estack@estack`, then `/estack:setup-models` and `/estack:setup`.
  - Every `/pstack:` becomes `/estack:`.
  - Layout block: `core/`, `adapters/claude-code/` (generated), `adapters/*.ts`, `pstack-qoder/` and `upstream/` (reference).
  - "Rebuild and check everything": `npm install && npm run build:claude && npm test && (cd adapters/claude-code && bash scripts/selftest.sh)`.
  - Add the rule: edit `core/`, never `adapters/claude-code/`.

- [ ] **Step 3: Update the diagrams.**
  - In `how-it-works.svg`, change `You: /pstack:poteto-mode` to `You: /estack:poteto-mode`.
  - Redraw `build-chain.svg` as three boxes: `core/` ("you edit this") → `adapters/build-claude-code.ts` → `adapters/claude-code/` ("generated plugin"). Keep the existing style.
  - Re-render both PNGs with the same method used before: pad to a square viewBox, `qlmanage -t -s <2×max side>`, then `sips -c <h> <w>`. Open each PNG to check nothing is cropped.

- [ ] **Step 4: Live install check.** In a scratch directory, run:
  ```bash
  claude plugin marketplace add <repo root>
  claude plugin install estack@estack
  claude plugin list
  ```
  Expected: `estack@estack` listed, enabled. Then start `claude` in that directory and check:
  - `/agents` lists the `estack:` seats.
  - `/hooks` lists the PreToolUse, PostToolUse and SubagentStop hooks.

  Afterwards, run `claude plugin marketplace remove estack`. Record the result in the commit message. If the live check cannot be run, say so there rather than claiming it.

- [ ] **Step 5: Final check and commit.**
  ```bash
  npm run check:claude && npm test && (cd adapters/claude-code && bash scripts/selftest.sh)
  grep -rn "/Users/" --exclude-dir=node_modules --exclude-dir=.git . | grep -v "Users/you"
  git add -A && git commit -m "Retire pstack-claude/, point the README and diagrams at estack"
  ```
  Expected: all checks pass, and the grep prints nothing.
