import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionSupported } from "../src/graph";
import { tempDir } from "./temp";

export { tempDir };

/** A fresh git repo on branch main with one empty commit. */
export function makeRepo(): string {
  const dir = tempDir("estack-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("commit", "--allow-empty", "-m", "init");
  return dir;
}

import type { Exec, ExecResult } from "../src/exec";
import { realExec } from "../src/exec";

/** Scripted `gh` and `graphify` results. `gh` is keyed by the joined args; `graphify` by `graphify <args>` then `graphify`. Everything else runs for real. */
export function fakeExec(responses: Record<string, Partial<ExecResult>>): Exec {
  const scripted = (r: Partial<ExecResult>): ExecResult =>
    ({ code: 1, stdout: "", stderr: "no scripted response", timedOut: false, durationMs: 0, ...r });
  return {
    run(file, args, opts) {
      if (file === "gh") return scripted(responses[args.join(" ")] ?? {});
      if (file === "graphify") {
        const r = responses[`graphify ${args.join(" ")}`] ?? responses["graphify"];
        if (r) return scripted(r);
      }
      return realExec.run(file, args, opts);
    },
    shell: (command, opts) => realExec.shell(command, opts),
  };
}

function hasGraphify(): boolean {
  const r = realExec.run("graphify", ["--version"], { cwd: tmpdir(), timeoutMs: 10_000 });
  const v = r.code === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] : undefined;
  return v !== undefined && versionSupported(v);
}
export const HAS_GRAPHIFY: boolean = hasGraphify();

/** Write graphify-out/graph.json in Graphify's shape plus estack-files.json. */
export function writeFakeGraph(checkout: string, nodes: object[], links: object[], builtAt = "abc1234"): void {
  const out = join(checkout, "graphify-out");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "graph.json"), JSON.stringify({
    directed: true, multigraph: false,
    graph: { schema_version: 1, graphify_version: "0.9.121" },
    built_at_commit: builtAt, nodes, links,
  }));
  const files = [...new Set((nodes as { source_file?: string }[]).map((n) => n.source_file).filter((f): f is string => !!f))].sort();
  writeFileSync(join(out, "estack-files.json"), JSON.stringify({ built_at_commit: builtAt, graphify_version: "0.9.121", files }));
}
