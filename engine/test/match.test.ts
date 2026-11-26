import { describe, expect, test } from "vitest";
import { classifyCommand, isExempt, isProtected, pathMatches } from "../src/match";
import { DEFAULT_POLICY_YAML, parsePolicy } from "../src/policy";

const policy = parsePolicy(DEFAULT_POLICY_YAML);

describe("command matching", () => {
  test("plain commands are none", () => {
    for (const c of ["git status", "npm test", "ls -la", "kubectl get pods", "cat README.md"]) {
      expect(classifyCommand(c, policy)).toEqual({ kind: "none" });
    }
  });

  test("git push is ask git_push", () => {
    expect(classifyCommand("git push origin feat", policy)).toMatchObject({ kind: "ask", action: "git_push" });
  });

  test("a push behind a shell prefix is still caught", () => {
    expect(classifyCommand("cd api && git push origin feat", policy)).toMatchObject({ kind: "ask", action: "git_push" });
  });

  test("force push to main is deny, not ask", () => {
    expect(classifyCommand("git push --force origin main", policy)).toMatchObject({
      kind: "deny",
      action: "force_push_protected",
      hardcoded: false,
    });
  });

  test("hard-coded denials win over policy and are flagged", () => {
    expect(classifyCommand("sqlite3 .estack/state.db 'select 1'", policy)).toMatchObject({
      kind: "deny", action: "engine_state", hardcoded: true,
    });
    expect(classifyCommand("estack override push --reason x", policy)).toMatchObject({
      kind: "deny", action: "owner_only", hardcoded: true,
    });
    expect(classifyCommand("git push --no-verify origin feat", policy)).toMatchObject({
      kind: "deny", action: "disable_hooks", hardcoded: true,
    });
    expect(classifyCommand("git -c core.hooksPath=/dev/null commit -m x", policy)).toMatchObject({
      kind: "deny", action: "disable_hooks", hardcoded: true,
    });
  });

  test("a policy with an empty deny list still applies hard-coded denials", () => {
    const open = { ...policy, actions: { auto: [], ask: [], deny: [] } };
    expect(classifyCommand("git push --no-verify origin feat", open)).toMatchObject({ kind: "deny", hardcoded: true });
    expect(classifyCommand("git push origin feat", open)).toEqual({ kind: "none" });
  });
});

describe("path matching", () => {
  test("path globs: ** spans dirs, * stays in a segment, no-slash matches basename", () => {
    expect(pathMatches("docs/a/b.md", "docs/**")).toBe(true);
    expect(pathMatches("src/a.ts", "src/*.ts")).toBe(true);
    expect(pathMatches("src/x/a.ts", "src/*.ts")).toBe(false);
    expect(pathMatches("api/.env.local", ".env*")).toBe(true);
    expect(pathMatches("secrets/k", "**/secrets/**")).toBe(true);
  });

  test("exempt and protected use the policy", () => {
    expect(isExempt("README.md", policy)).toBe(true);
    expect(isExempt("src/a.ts", policy)).toBe(false);
    expect(isProtected(".estack/policy.yaml", policy)).toBe(true);
    expect(isProtected("api/.env", policy)).toBe(true);
  });
});
