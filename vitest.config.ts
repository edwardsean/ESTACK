import { defineConfig } from "vitest/config";

// Only estack's own tests. The content trees (core/, adapters/claude-code/,
// pstack-qoder/, upstream/) ship Bun tests for their skills' scripts.
export default defineConfig({
  test: { include: ["adapters/*.test.ts", "engine/test/*.test.ts"] },
});
