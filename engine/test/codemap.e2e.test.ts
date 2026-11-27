import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { realExec, type Exec } from "../src/exec";
import { runHook } from "../src/hooks";
import { createServer } from "../src/mcp";
import { HAS_GRAPHIFY, fakeExec, makeRepo } from "./helpers";

const PR = "https://github.com/o/r/pull/1";
const CTO = { session_id: "s1" };
const W = { session_id: "s1", agent_id: "W" };
const R = { session_id: "s1", agent_id: "R" };

const HELPER = "export function formatInvoiceDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}

function fixture(mapFlags: string[], exec: Exec): string {
  const dir = makeRepo();
  write(dir, "src/utils.ts", HELPER);
  write(dir, "src/orders/invoice.ts", 'import { formatInvoiceDate } from "../utils";\nexport function invoiceLine(d: Date): string {\n  return "Invoice " + formatInvoiceDate(d);\n}\n');
  // A copy in a folder Graphify maps on its own (it skips dist/ and build/ itself): only the exclude list keeps it out.
  write(dir, "upstream/utils.js", "export function formatInvoiceDate(d) {\n  return d.toISOString().slice(0, 10);\n}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
  const status = main(["init", ...mapFlags], { cwd: dir, env: {}, out: () => {}, err: (s) => { throw new Error(s); }, exec });
  expect(status).toBe(0);
  const p = join(dir, ".estack", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, '  test:   "true"').replace(/^ {2}verify:.*$/m, '  verify: "true"'));
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "estack");
  return dir;
}

async function connect(cwd: string, exec: Exec) {
  const server = createServer(cwd, { exec });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { cwd, ...args } })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content[0].text };
  };
}

function rows(dir: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(dir, ".estack", "state.db"));
  try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
}

describe.skipIf(!HAS_GRAPHIFY)("the utils.ts failure, end to end on real Graphify", () => {
  const read = (dir: string, actor: typeof W, file: string) =>
    runHook("pre-tool-use", { hook_event_name: "PreToolUse", session_id: actor.session_id, agent_id: actor.agent_id, cwd: dir, tool_name: "Read", tool_input: { file_path: join(dir, file) } }, { exec: realExec }) as any;
  const denied = (out: any) => out?.hookSpecificOutput?.permissionDecision === "deny";

  async function setup() {
    const dir = fixture(["--code-map", "on", "--exclude", "upstream/**"], realExec);
    const call = await connect(dir, realExec);
    const started = await call("start_task", { title: "orders", type: "feature", goal: "format invoice dates", done_check: "d", area: "src/orders", actor: CTO });
    expect(started.isError, started.text).toBe(false);
    return { dir, call, out: JSON.parse(started.text) };
  }

  test("the second task is shown the helper, never its copy", async () => {
    const { out } = await setup();
    const uses = out.context.uses as { symbol: string; file: string }[];
    expect(uses.some((u) => u.symbol === "formatInvoiceDate" && u.file === "src/utils.ts")).toBe(true);
    expect(JSON.stringify(out.context)).not.toContain("upstream/");
  });

  test("its worker is sent to the map once and its reviewer never", async () => {
    const { dir, call, out } = await setup();
    expect(denied(read(dir, W, "src/utils.ts"))).toBe(true);
    expect(denied(read(dir, W, "src/utils.ts"))).toBe(false);
    const found = await call("find_existing", { description: "format invoice date", actor: W });
    expect(found.isError, found.text).toBe(false);
    const id = out.task.id;
    expect((await call("complete_step", { task_id: id, step: "plan", evidence: { kind: "note", text: "plan" }, actor: W })).isError).toBe(false);
    expect((await call("complete_step", { task_id: id, step: "reuse_check", evidence: { kind: "note", text: "searched, helper exists" }, actor: W })).isError).toBe(false);
    expect(denied(read(dir, R, "src/utils.ts"))).toBe(false);
    const events = rows(dir, "SELECT actor FROM events WHERE kind = 'map_first_denied'");
    expect(events).toEqual([{ actor: "s1/W" }]);
  });

  test("the duplicate is flagged if written anyway, holds back verify until a different agent dismisses it, and is never matched against the copy", async () => {
    const { dir, call, out } = await setup();
    const id = out.task.id;
    await call("find_existing", { description: "format invoice date", actor: W });
    expect((await call("complete_step", { task_id: id, step: "plan", evidence: { kind: "note", text: "plan" }, actor: W })).isError).toBe(false);
    expect((await call("complete_step", { task_id: id, step: "reuse_check", evidence: { kind: "note", text: "searched" }, actor: W })).isError).toBe(false);
    write(dir, "src/orders/format.ts", "export function formatInvoiceDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "format invoice dates locally");
    const sha = git(dir, "rev-parse", "HEAD");
    expect((await call("complete_step", { task_id: id, step: "implement", evidence: { kind: "commit", sha }, actor: W })).isError).toBe(false);
    expect((await call("run_check", { task_id: id, step: "test", actor: W })).isError).toBe(false);

    expect(main(["map-hook", "post-commit"], { cwd: dir, env: {}, out: () => {}, err: () => {}, exec: realExec })).toBe(0);
    const dups = rows(dir, "SELECT * FROM duplicates");
    expect(dups.length).toBeGreaterThan(0);
    expect(dups[0]).toMatchObject({ new_symbol: "formatInvoiceDate", new_file: "src/orders/format.ts", existing_file: "src/utils.ts", status: "open" });
    expect(dups.some((d) => JSON.stringify(d).includes("upstream/"))).toBe(false);

    const refused = await call("run_check", { task_id: id, step: "verify", actor: W });
    expect(refused.isError).toBe(true);
    const dupId = dups[0].id;
    const byAuthor = await call("dismiss_duplicate", { duplicate_id: dupId, reason: "mine", actor: W });
    expect(byAuthor.isError).toBe(true);
    expect(byAuthor.text).toMatch(/^BAD_EVIDENCE: the task's author can't dismiss/);
    const byReviewer = await call("dismiss_duplicate", { duplicate_id: dupId, reason: "different date format needed", actor: R });
    expect(byReviewer.isError, byReviewer.text).toBe(false);
    const verified = await call("run_check", { task_id: id, step: "verify", actor: W });
    expect(verified.isError, verified.text).toBe(false);
  });
});

describe("the code map off, end to end", () => {
  test("with the map off every task type runs end to end", async () => {
    const gh = fakeExec({ [`pr view ${PR} --json headRefName`]: { code: 0, stdout: '{"headRefName":"main"}' }, graphify: { code: 127 } });
    const dir = fixture(["--code-map", "off"], gh);
    const call = await connect(dir, gh);
    for (const type of ["feature", "bugfix", "refactor"]) {
      const started = await call("start_task", { title: type, type, goal: "g", done_check: "d", actor: W });
      expect(started.isError, started.text).toBe(false);
      const id = JSON.parse(started.text).task.id;
      const step = async (s: string, evidence: unknown, actor = W) => {
        const r = await call("complete_step", { task_id: id, step: s, evidence, actor });
        expect(r.isError, `${type} ${s}: ${r.text}`).toBe(false);
      };
      const steps = (JSON.parse((await call("status", { task_id: id })).text).steps as { name: string }[]).map((s) => s.name);
      for (const s of steps) {
        if (s === "implement" || s === "fix") {
          git(dir, "commit", "--allow-empty", "-m", `${type} work`);
          await step(s, { kind: "commit", sha: git(dir, "rev-parse", "HEAD") });
        } else if (s === "test" || s === "verify" || s === "reproduce") {
          if (s === "reproduce") await step(s, { kind: "note", text: "reproduced" });
          else expect((await call("run_check", { task_id: id, step: s, actor: W })).isError).toBe(false);
        } else if (s === "review") await step(s, { kind: "review", verdict: "approve", findings: "fine" }, R);
        else if (s === "pr") await step(s, { kind: "pr", url: PR });
        else await step(s, { kind: "note", text: `${s} done` });
      }
      expect(steps).toContain("reuse_check");
      const final = JSON.parse((await call("status", { task_id: id })).text);
      expect(final.task.status, type).toBe("done");
    }
  });
});
