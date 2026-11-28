import { defineConfig } from "vitest/config";

// Only estack's own tests. The content trees (core/, adapters/claude-code/,
// pstack-qoder/, upstream/) ship Bun tests for their skills' scripts.
export default defineConfig({
  // The engine suites spawn git many times; a cold first run can pass 5s.
  // .estack/ holds task worktrees, which carry copies of these tests.
  test: {
    include: ["adapters/*.test.ts", "engine/test/*.test.ts"],
    exclude: [".estack/**", "**/node_modules/**"],
    testTimeout: 30_000,
    // Every temp folder a test makes is removed: per test file (tempDir in engine/test/temp.ts) and with the run's folder.
    globalSetup: ["engine/test/global-setup.ts"],
    setupFiles: ["engine/test/setup.ts"],
  },
});
