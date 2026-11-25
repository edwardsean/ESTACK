import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createServer } from "../src/mcp";
import { initRepo } from "../src/policy";
import { fakeExec, makeRepo } from "./helpers";

const PR = "https://github.com/o/r/pull/1";
const A = { session_id: "s1", agent_id: "A" };
const B = { session_id: "s1", agent_id: "B" };

async function connect(cwd: string, gh: Record<string, { code: number }> = {}) {
  const server = createServer(cwd, { exec: fakeExec(gh) });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: r.isError === true, text: r.content[0].text };
  };
  return { client, call };
}

function initedRepo(): string {
  const dir = makeRepo();
  initRepo(dir);
  const p = join(dir, ".estack", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^ {2}test:.*$/m, '  test:   "true"').replace(/^ {2}verify:.*$/m, '  verify: "true"'));
  return dir;
}

describe("mcp server", () => {
  test("lists exactly the four tools", async () => {
    const { client } = await connect(initedRepo());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["complete_step", "run_check", "start_task", "status"]);
  });

  test("not opted in returns isError with NOT_OPTED_IN text, server keeps working", async () => {
    const { call } = await connect(makeRepo());
    const r = await call("status", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^NOT_OPTED_IN: /);
    expect((await call("status", {})).isError).toBe(true);
  });

  test("drives a feature task end to end", async () => {
    const dir = initedRepo();
    const { call } = await connect(dir, { [`pr view ${PR} --json url`]: { code: 0 } });
    const started = await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d", actor: A });
    expect(started.isError).toBe(false);
    const id = JSON.parse(started.text).task.id;
    const step = async (s: string, evidence: unknown, actor = A) => {
      const r = await call("complete_step", { task_id: id, step: s, evidence, actor });
      expect(r.isError, r.text).toBe(false);
    };
    await step("plan", { kind: "note", text: "plan" });
    await step("reuse_check", { kind: "note", text: "nothing to reuse" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: dir, stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    await step("implement", { kind: "commit", sha });
    for (const s of ["test", "verify"]) {
      const r = await call("run_check", { task_id: id, step: s, actor: A });
      expect(r.isError, r.text).toBe(false);
      expect(JSON.parse(r.text).check.ok).toBe(true);
    }
    await step("review", { kind: "review", verdict: "approve", findings: "fine" }, B);
    await step("pr", { kind: "pr", url: PR });
    const final = JSON.parse((await call("status", { task_id: id })).text);
    expect(final.task.status).toBe("done");
    expect(final.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
    expect(final.evidence).toHaveLength(7);
    expect(final.evidence.every((x: { ok: boolean }) => x.ok)).toBe(true);
  });

  test("an engine error comes back as isError, not a thrown exception", async () => {
    const { call } = await connect(initedRepo());
    const t = JSON.parse((await call("start_task", { title: "t", type: "feature", goal: "g", done_check: "d" })).text);
    const r = await call("complete_step", { task_id: t.task.id, step: "implement", evidence: { kind: "commit", sha: "abcd" } });
    expect(r.isError).toBe(true);
    expect(r.text.startsWith("OUT_OF_ORDER")).toBe(true);
  });
});
