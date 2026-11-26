import { defineConfig } from "vitest/config";

// Only estack's own tests. The content trees (core/, adapters/claude-code/,
// pstack-qoder/, upstream/) ship Bun tests for their skills' scripts.
export default defineConfig({
  // The engine suites spawn git many times; a cold first run can pass 5s.
  test: { include: ["adapters/*.test.ts", "engine/test/*.test.ts"], testTimeout: 30_000 },
});
