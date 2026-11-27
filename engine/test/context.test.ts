import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TRANSCRIPT_TAIL_BYTES, contextRatio, contextTokens } from "../src/context";
import { parsePolicy, DEFAULT_POLICY_YAML } from "../src/policy";

const dir = mkdtempSync(join(tmpdir(), "estack-ctx-"));
let n = 0;
function file(lines: unknown[] | string): string {
  const p = join(dir, `t${n++}.jsonl`);
  writeFileSync(p, typeof lines === "string" ? lines : lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}
const asst = (usage: object, side = false) => ({ type: "assistant", isSidechain: side, message: { usage } });

test("sums input, cache read and cache creation tokens of the newest main-thread assistant entry", () => {
  const p = file([
    asst({ input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, output_tokens: 9 }),
    { type: "user", message: {} },
    asst({ input_tokens: 2, cache_read_input_tokens: 654850, cache_creation_input_tokens: 990, output_tokens: 561 }),
    { type: "user", message: {} },
  ]);
  expect(contextTokens(p)).toBe(655842);
  expect(contextTokens(file([asst({ input_tokens: 5 })]))).toBe(5);
});

test("sidechain entries are ignored", () => {
  const p = file([asst({ input_tokens: 100 }), asst({ input_tokens: 999999 }, true)]);
  expect(contextTokens(p)).toBe(100);
});

test("a missing, empty or malformed transcript is null", () => {
  expect(contextTokens(join(dir, "nope.jsonl"))).toBeNull();
  expect(contextTokens(file(""))).toBeNull();
  expect(contextTokens(file("not json\n{broken\n"))).toBeNull();
  expect(contextTokens(file([{ type: "user" }]))).toBeNull();
  expect(contextRatio(undefined, 200000)).toBeNull();
});

test("only the tail of a large transcript is read", () => {
  const filler = JSON.stringify({ type: "user", pad: "x".repeat(1000) });
  const old = JSON.stringify(asst({ input_tokens: 777 }));
  const count = Math.ceil(TRANSCRIPT_TAIL_BYTES / filler.length) + 10;
  const p = file(old + "\n" + Array(count).fill(filler).join("\n") + "\n");
  expect(contextTokens(p)).toBeNull();
  const q = file(old + "\n" + Array(count).fill(filler).join("\n") + "\n" + JSON.stringify(asst({ input_tokens: 42 })) + "\n");
  expect(contextTokens(q)).toBe(42);
});

test("ratio uses the window", () => {
  const p = file([asst({ input_tokens: 50000, cache_read_input_tokens: 50000 })]);
  expect(contextRatio(p, 200000)).toBe(0.5);
  expect(contextRatio(p, 400000)).toBe(0.25);
});

test("handover settings default to 0.5 and 200000 and reject bad values", () => {
  expect(parsePolicy(DEFAULT_POLICY_YAML).handover).toEqual({ threshold: 0.5, window_tokens: 200000 });
  const ok = parsePolicy(DEFAULT_POLICY_YAML + "handover:\n  threshold: 0.7\n  window_tokens: 1000000\n");
  expect(ok.handover).toEqual({ threshold: 0.7, window_tokens: 1000000 });
  for (const bad of ["threshold: 0", "threshold: 1.5", "window_tokens: 0", "window_tokens: 1.5", "window_tokens: -5"]) {
    const key = bad.split(":")[0];
    expect(() => parsePolicy(DEFAULT_POLICY_YAML + `handover:\n  ${bad}\n`), bad).toThrow(new RegExp(`POLICY_INVALID|handover\\.${key}`));
    try { parsePolicy(DEFAULT_POLICY_YAML + `handover:\n  ${bad}\n`); } catch (x: any) {
      expect(x.code).toBe("POLICY_INVALID");
      expect(x.message).toContain(`handover.${key}`);
    }
  }
});
