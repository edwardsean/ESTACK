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
    for (const c of ["estack allow --task 1 --path a --reason x", "estack release --path a --reason x", "env -i PATH=$PATH node /x/estack.mjs allow --task 1 --with 2 --reason x", "node /x/estack.mjs release --path a --reason x"]) {
      expect(classifyCommand(c, policy), c).toMatchObject({ kind: "deny", action: "owner_only", hardcoded: true });
    }
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

describe("phase 3 review fixes", () => {
  const v = (c: string) => classifyCommand(c, policy);

  test("F2 git commit -n skips pre-commit, so short -n clusters are denied", () => {
    for (const c of ["git commit -n -m x", "git commit -nm x", "git commit -an", "git commit -anm x"]) {
      expect(v(c), c).toMatchObject({ kind: "deny", action: "disable_hooks", hardcoded: true });
    }
    for (const c of ['git commit -m "fix n"', "git commit --amend", "git commit -m x"]) {
      expect(v(c), c).toEqual({ kind: "none" });
    }
  });

  test("F3 core.hookspath is caught in any case", () => {
    for (const c of ["git -c core.hookspath=/dev/null commit -m x", "git -c CORE.HOOKSPATH=/dev/null commit -m x"]) {
      expect(v(c), c).toMatchObject({ kind: "deny", action: "disable_hooks", hardcoded: true });
    }
  });

  test("F4 touching CLAUDECODE is denied", () => {
    for (const c of ["CLAUDECODE= git commit -m x", "env -u CLAUDECODE git push", "unset CLAUDECODE; git push origin feat"]) {
      expect(v(c), c).toMatchObject({ kind: "deny", action: "disable_hooks", hardcoded: true });
    }
  });

  test("F5 git global options and extra spaces do not hide a push", () => {
    for (const c of ["git -C . push origin feat", "git -c a=b push", "git  push", "git --no-pager push", "git --git-dir=.git push", "git --work-tree . push"]) {
      expect(v(c), c).toMatchObject({ kind: "ask", action: "git_push" });
    }
    expect(v("git -C . status")).toEqual({ kind: "none" });
  });

  test("F8 deploy and migration patterns are command forms, not substrings", () => {
    for (const c of ["ls db/migrations", "grep -rn deploy src", "git log --grep=migrate", "prisma migrate dev"]) {
      expect(v(c), c).toEqual({ kind: "none" });
    }
    expect(v("prisma migrate deploy")).toMatchObject({ kind: "ask", action: "db_migration" });
    expect(v("npx prisma migrate deploy")).toMatchObject({ kind: "ask", action: "db_migration" });
    expect(v("npm run deploy")).toMatchObject({ kind: "ask", action: "deploy" });
  });

  test("default migration patterns catch db:migrate scripts in npm, pnpm and yarn", () => {
    for (const c of ["npm run db:migrate", "npm run migrate", "pnpm run db:migrate", "pnpm db:migrate", "yarn db:migrate", "yarn migrate"]) {
      expect(v(c), c).toMatchObject({ kind: "ask", action: "db_migration" });
    }
    expect(v("npm run test")).toEqual({ kind: "none" });
  });

  test("C1 force push with the flag after the refspec is denied", () => {
    for (const c of ["git push origin main --force", "git push origin main -f", "git push origin +main", "git push origin master --force", "git push origin +master"]) {
      expect(v(c), c).toMatchObject({ kind: "deny", action: "force_push_protected", hardcoded: false });
    }
  });

  test("C2 sqlite3 on state.db from inside .estack is denied", () => {
    expect(v("cd .estack && sqlite3 state.db 'select 1'")).toMatchObject({ kind: "deny", action: "engine_state", hardcoded: true });
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

describe("git options with quoted values", () => {
  const policy = parsePolicy(DEFAULT_POLICY_YAML);
  test.each([
    `git -C "dir with space" push origin feat`,
    `git -C 'dir with space' push origin feat`,
    `git -c user.name="A B" push origin feat`,
    `git --git-dir="a b/.git" push origin feat`,
    `git --work-tree 'a b' push origin feat`,
  ])("%s is classified as a push", (cmd) => {
    expect(classifyCommand(cmd, policy)).toMatchObject({ kind: "ask", action: "git_push" });
  });
  test("a quoted -C path doesn't hide commit -n", () => {
    expect(classifyCommand(`git -C "d e" commit -n -m x`, policy)).toMatchObject({ kind: "deny", action: "disable_hooks" });
  });
  test("a quoted -C path on a harmless command stays silent", () => {
    expect(classifyCommand(`git -C "d e" status`, policy)).toEqual({ kind: "none" });
  });
});
