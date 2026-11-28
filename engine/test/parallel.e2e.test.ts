import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { runHook } from "../src/hooks";
import { createServer } from "../src/mcp";
import { initRepo } from "../src/policy";
import { fakeExec, makeRepo, writeFakeGraph, tempDir } from "./helpers";

// Phase 6 done-when, end to end: a feature, two dependent workers, a helper built once, holds, grants and outcomes,
// driven through the MCP server, the hooks and the CLI the way agents and the owner would.

const S1 = { session_id: "s1" };
const S2 = { session_id: "s2" };
const agent = (id: string) => ({ session_id: "s1", agent_id: id });
const URL1 = "https://github.com/o/r/pull/1";
const URL2 = "https://github.com/o/r/pull/2";
const UTILS = "src/utils.ts";
const UTILS_START = ["// shared helpers", "export function noop(): void {}", "", "", "", "export function tail(): void {}", ""].join("\n");

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("phase 6 done-when", { timeout: 120_000 }, () => {
  let main_: string;
  let origin: string;
  const gh: Record<string, { code: number; stdout?: string }> = {};
  let call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;

  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    expect(r.isError, `${name}: ${r.text}`).toBe(false);
    return JSON.parse(r.text);
  };
  const db = <T>(fn: (d: DatabaseSync) => T): T => {
    const d = new DatabaseSync(join(main_, ".estack", "state.db"));
    try { return fn(d); } finally { d.close(); }
  };
  const edit = (cwd: string, who: { session_id: string; agent_id?: string }, rel: string) =>
    runHook("pre-tool-use", {
      hook_event_name: "PreToolUse", session_id: who.session_id, ...(who.agent_id ? { agent_id: who.agent_id } : {}),
      cwd, tool_name: "Edit", tool_input: { file_path: join(cwd, rel) },
    }, { exec: fakeExec(gh) }) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null;
  const write = (cwd: string, rel: string, content: string) => {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), content);
  };
  const commit = (cwd: string, msg: string): string => {
    git(cwd, "add", "-A");
    git(cwd, "commit", "-m", msg);
    return git(cwd, "rev-parse", "HEAD");
  };
  const setMap = (on: boolean) => {
    const p = join(main_, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace(/enabled: (true|false)/, `enabled: ${on}`));
  };
  const startFeature = async (title: string, actor: object) => {
    const v = await ok("start_task", { title, type: "feature", goal: `${title} goal`, done_check: `${title} works`, worktree: true, cwd: main_, actor });
    return { id: v.task.id as number, cwd: v.worktree_path as string, branch: v.task.branch as string };
  };
  const startWorker = async (id: number) => {
    const v = await ok("start_task", { task_id: id, worktree: true, cwd: main_, actor: S1 });
    return { id, cwd: v.worktree_path as string, branch: v.task.branch as string };
  };
  const step = (id: number, actor: object, name: string, evidence: object) => ok("complete_step", { task_id: id, step: name, evidence, actor });
  const check = (id: number, actor: object, name: string) => ok("run_check", { task_id: id, step: name, actor });
  /** plan to review; a reviewer other than the author approves. The worker or feature has committed `sha`. */
  async function steps(id: number, actor: object, sha: string, opts: { reuse?: boolean } = {}) {
    await step(id, actor, "plan", { kind: "note", text: "plan" });
    if (opts.reuse !== false) await step(id, actor, "reuse_check", { kind: "note", text: "nothing to reuse" });
    await step(id, actor, "implement", { kind: "commit", sha });
    await check(id, actor, "test");
    await check(id, actor, "verify");
    await step(id, agent("R"), "review", { kind: "review", verdict: "approve", findings: "looks good" });
  }
  const mergeInto = async (feature: { cwd: string; branch: string }, worker: { id: number; branch: string }) => {
    git(feature.cwd, "merge", "--no-ff", "-m", `merge ${worker.branch}`, worker.branch);
    await step(worker.id, S1, "merge", { kind: "merged" });
  };

  let f1: { id: number; cwd: string; branch: string };
  let w1: { id: number; cwd: string; branch: string };
  let w2: { id: number; cwd: string; branch: string };
  let w2Id = 0;
  let w1Id = 0;
  let w1Sha = "";
  let w2Sha = "";
  let f2: { id: number; cwd: string; branch: string };
  let w3: { id: number; cwd: string; branch: string };
  let f3: { id: number; cwd: string; branch: string };
  let w3Sha = "";

  beforeAll(async () => {
    main_ = makeRepo();
    git(main_, "config", "commit.gpgsign", "false");
    origin = tempDir("estack-origin-");
    git(origin, "init", "--bare", "-b", "main");
    write(main_, UTILS, UTILS_START);
    initRepo(main_);
    const p = join(main_, ".estack", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, '  test:   "true"').replace(/^ {2}verify:.*$/m, '  verify: "true"'));
    commit(main_, "start");
    git(main_, "remote", "add", "origin", origin);
    git(main_, "push", "-u", "origin", "main");
    const server = createServer(main_, { exec: fakeExec(gh) });
    const client = new Client({ name: "test", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    call = async (name, args) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: r.isError === true, text: r.content[0].text };
    };
  });

  test("the dependent worker waits for the foundation, then builds on it, and the helper is built once", async () => {
    f1 = await startFeature("Invoices", S1);
    expect(f1.branch).toMatch(/^feat\/\d+-invoices$/);
    expect(f1.cwd).toBe(join(main_, ".estack", "worktrees", `${f1.id}-invoices`));

    const planned = await ok("plan_tasks", {
      parent_task_id: f1.id, actor: S1,
      tasks: [
        { title: "Date helper", type: "feature", goal: "add the invoice date helper", done_check: "helper exists", area: [UTILS], adds: ["formatInvoiceDate"] },
        { title: "Order screen", type: "feature", goal: "show orders with dates", done_check: "orders render", area: ["src/orders"], depends_on: ["#1"] },
      ],
    });
    expect(planned.overlaps).toEqual([]);
    w1Id = planned.tasks[0].task.id;
    w2Id = planned.tasks[1].task.id;

    const early = await call("start_task", { task_id: w2Id, worktree: true, cwd: main_, actor: S1 });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/^DEPENDENCY: /);

    w1 = await startWorker(w1Id);
    expect(w1.branch).toMatch(/^task\/\d+-date-helper$/);
    await step(w1.id, agent("W1"), "plan", { kind: "note", text: "plan" });
    await step(w1.id, agent("W1"), "reuse_check", { kind: "note", text: "no helper yet" });
    expect(edit(w1.cwd, agent("W1"), UTILS)).toBeNull();
    write(w1.cwd, UTILS, `${UTILS_START}export function formatInvoiceDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}\n`);
    w1Sha = commit(w1.cwd, "add formatInvoiceDate");
    await step(w1.id, agent("W1"), "implement", { kind: "commit", sha: w1Sha });
    await check(w1.id, agent("W1"), "test");
    await check(w1.id, agent("W1"), "verify");
    await step(w1.id, agent("R"), "review", { kind: "review", verdict: "approve", findings: "fine" });
    await mergeInto(f1, w1);

    // The merge moved W1's hold on the file to its feature.
    const status = await ok("status", { actor: S1 });
    expect(status.claims).toContainEqual(expect.objectContaining({ kind: "file", target: UTILS, task_id: f1.id }));

    w2 = await startWorker(w2Id);
    expect(readFileSync(join(w2.cwd, UTILS), "utf8")).toContain("export function formatInvoiceDate");

    // The helper is found, not rebuilt: the map (switched on for the search) points at it.
    setMap(true);
    writeFakeGraph(w2.cwd, [
      { id: "file", label: "utils.ts", source_file: UTILS, source_location: "L1" },
      { id: "f", label: "formatInvoiceDate()", source_file: UTILS, source_location: "L7" },
    ], [{ source: "file", target: "f", relation: "contains", confidence: "EXTRACTED", source_file: UTILS, source_location: "L7" }], git(w2.cwd, "rev-parse", "HEAD"));
    try {
      const found = await ok("find_existing", { description: "format invoice date", task_id: w2.id, cwd: w2.cwd, actor: agent("W2") });
      expect(found.matches[0]).toMatchObject({ symbol: "formatInvoiceDate", file: UTILS });
      const claimed = await ok("claim_symbol", { task_id: w2.id, name: "formatInvoiceDate", file: "src/orders/dates.ts", actor: agent("W2") });
      expect(claimed).toMatchObject({ status: "exists", file: UTILS });
      await step(w2.id, agent("W2"), "plan", { kind: "note", text: "plan" });
      await step(w2.id, agent("W2"), "reuse_check", { kind: "note", text: "reuse formatInvoiceDate from src/utils.ts" });
    } finally {
      setMap(false);
      rmSync(join(w2.cwd, "graphify-out"), { recursive: true, force: true });
    }
    expect(db((d) => d.prepare("SELECT COUNT(*) c FROM duplicates").get() as { c: number }).c).toBe(0);
  });

  test("a task's own feature never blocks it", async () => {
    // The feature holds src/utils.ts after W1's merge; W2 is the feature's child.
    expect(edit(w2.cwd, agent("W2"), UTILS)).toBeNull();
    expect(edit(w2.cwd, agent("W2"), "src/orders/index.ts")).toBeNull();
    write(w2.cwd, "src/orders/index.ts", `import { formatInvoiceDate } from "../utils";\nexport const today = (): string => formatInvoiceDate(new Date());\n`);
    w2Sha = commit(w2.cwd, "orders use formatInvoiceDate");
    await step(w2.id, agent("W2"), "implement", { kind: "commit", sha: w2Sha });
    await check(w2.id, agent("W2"), "test");
    await check(w2.id, agent("W2"), "verify");
    await step(w2.id, agent("R"), "review", { kind: "review", verdict: "approve", findings: "fine" });
    await mergeInto(f1, w2);
  });

  test("an edit to a held file is denied until the owning CTO allows it", async () => {
    f2 = await startFeature("Reports", S1);
    const planned = await ok("plan_tasks", {
      parent_task_id: f2.id, actor: S1,
      tasks: [{ title: "Report header", type: "feature", goal: "change the shared header comment", done_check: "header changed", area: ["src/reports"] }],
    });
    w3 = await startWorker(planned.tasks[0].task.id);

    const denied = edit(w3.cwd, agent("W3"), UTILS);
    expect(denied?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toContain(`held by task #${f1.id}`);
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toContain("report to your CTO");

    const held = await ok("claim_status", { path: UTILS, actor: S1 });
    expect(held.holder).toMatchObject({ task_id: f1.id, title: "Invoices" });
    expect(held.diff).toContain("formatInvoiceDate");

    const byWorker = await call("allow_edit", { task_id: w3.id, path: UTILS, reason: "header tweak", actor: agent("W3") });
    expect(byWorker.isError).toBe(true);
    expect(byWorker.text).toMatch(/^OWNER_ONLY: /);

    await ok("allow_edit", { task_id: w3.id, path: UTILS, reason: "header tweak", actor: S1 });
    expect(edit(w3.cwd, agent("W3"), UTILS)).toBeNull();
    write(w3.cwd, UTILS, readFileSync(join(w3.cwd, UTILS), "utf8").replace("// shared helpers", "// shared helpers (documented)"));
    w3Sha = commit(w3.cwd, "document the shared helpers");
  });

  test("across two CTOs only the owner can allow", async () => {
    f3 = await startFeature("Billing", S2);
    const denied = edit(f3.cwd, S2, UTILS);
    expect(denied?.hookSpecificOutput?.permissionDecision).toBe("deny");

    const byCto = await call("allow_edit", { task_id: f3.id, path: UTILS, reason: "need it", actor: S2 });
    expect(byCto.isError).toBe(true);
    expect(byCto.text).toMatch(/^OWNER_ONLY: .*estack allow --task/);

    const out: string[] = [];
    const err: string[] = [];
    const io = (env: NodeJS.ProcessEnv) => ({ cwd: main_, env, out: (s: string) => out.push(s), err: (s: string) => err.push(s), exec: fakeExec(gh) });
    const args = ["allow", "--task", String(f3.id), "--path", UTILS, "--reason", "billing needs the date helper"];
    expect(main(args, io({ CLAUDECODE: "1" }))).toBe(1);
    expect(err.join("")).toMatch(/owner-only/);
    expect(edit(f3.cwd, S2, UTILS)?.hookSpecificOutput?.permissionDecision).toBe("deny");

    expect(main(args, io({}))).toBe(0);
    expect(out.join("")).toContain(`allowed task ${f3.id} to edit ${UTILS}`);
    expect(edit(f3.cwd, S2, UTILS)).toBeNull();
  });

  test("the feature ends in one PR containing both workers' work", async () => {
    // W3 finishes into the second feature; both features run their own steps.
    await steps(w3.id, agent("W3"), w3Sha);
    await mergeInto(f2, w3);
    const f2Sha = git(f2.cwd, "rev-parse", "HEAD");
    await steps(f2.id, S1, f2Sha);
    gh[`pr view ${URL2} --json headRefName`] = { code: 0, stdout: JSON.stringify({ headRefName: f2.branch }) };
    await step(f2.id, S1, "pr", { kind: "pr", url: URL2 });

    const f1Sha = git(f1.cwd, "rev-parse", "HEAD");
    await steps(f1.id, S1, f1Sha);
    gh[`pr view ${URL1} --json headRefName`] = { code: 0, stdout: JSON.stringify({ headRefName: f1.branch }) };
    await step(f1.id, S1, "pr", { kind: "pr", url: URL1 });

    const log = git(main_, "log", "--format=%H", f1.branch).split("\n");
    expect(log).toContain(w1Sha);
    expect(log).toContain(w2Sha);
    const view = await ok("status", { task_id: f1.id, actor: S1 });
    expect(view.task.status).toBe("done");
    expect(view.evidence).toContainEqual(expect.objectContaining({ kind: "pr", ok: true }));
    // One pull request: the workers have none.
    const prs = db((d) => d.prepare("SELECT task_id FROM evidence WHERE kind = 'pr' AND ok = 1 ORDER BY task_id").all() as { task_id: number }[]);
    expect(prs.map((r) => r.task_id)).toEqual([f1.id, f2.id]);
  });

  test("the grant and its outcome are recorded", async () => {
    const grants = () => db((d) => d.prepare("SELECT task_id, path, reason, by, outcome FROM claim_grants ORDER BY id").all() as Record<string, unknown>[]);
    expect(grants()).toEqual([
      { task_id: w3.id, path: UTILS, reason: "header tweak", by: "s1/main", outcome: null },
      { task_id: f3.id, path: UTILS, reason: "billing needs the date helper", by: "owner", outcome: null },
    ]);

    // Nothing is judged while the features are still open pull requests.
    await ok("status", { actor: S1 });
    expect(grants().map((g) => g.outcome)).toEqual([null, null]);

    // Both features reach main.
    git(main_, "merge", "--no-ff", "-m", "merge invoices", f1.branch);
    git(main_, "merge", "--no-ff", "-m", "merge reports", f2.branch);
    git(main_, "push", "origin", "main");
    gh[`pr view ${f1.branch} --json mergeable`] = { code: 0, stdout: JSON.stringify({ mergeable: "MERGEABLE" }) };
    await ok("status", { actor: S1 });

    // W3's grant ends clean: its holder (the first feature) and its own feature both merged. Billing's never merged.
    expect(grants().map((g) => g.outcome)).toEqual(["clean", null]);
    const events = db((d) => d.prepare("SELECT task_id, payload_json p FROM events WHERE kind = 'grant_outcome'").all() as { task_id: number; p: string }[]);
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe(w3.id);
    expect(JSON.parse(events[0].p).outcome).toBe("clean");
    // The merged feature gave up its hold (the file passes to Billing, the open task the owner allowed in) and its worktree.
    const after = await ok("claim_status", { path: UTILS, actor: S1 });
    expect(after.holder).toMatchObject({ task_id: f3.id });
    expect(existsSync(f1.cwd)).toBe(false);
  });
});
