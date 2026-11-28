import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext { estackTempRoot: string }
}

/**
 * One folder for the whole run in the OS temp folder. engine/test/setup.ts points each test file's TMPDIR at it, so
 * every temp folder a test or a command it runs makes lands inside, and it is removed when the run ends.
 */
export default function setup(project: TestProject): () => void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "estack-test-run-")));
  project.provide("estackTempRoot", root);
  return () => rmSync(root, { recursive: true, force: true });
}
