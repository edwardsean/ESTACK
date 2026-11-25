import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { bundleEngine } from "./build-claude-code";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the bundle is deterministic", () => {
  expect(bundleEngine(root).equals(bundleEngine(root))).toBe(true);
});

test("the bundle has no absolute home paths", () => {
  expect(bundleEngine(root).toString("utf8")).not.toContain("/Users/");
});

test("the bundled CLI runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "estack-bundle-"));
  try {
    const bundle = join(dir, "estack.mjs");
    writeFileSync(bundle, bundleEngine(root));
    const repo = join(dir, "repo");
    expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
    const r = spawnSync("node", ["--no-warnings", bundle, "status"], { cwd: repo, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("estack: not an estack repository: run /estack:setup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
