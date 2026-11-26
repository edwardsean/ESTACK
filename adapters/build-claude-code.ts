// Generates the Claude Code plugin in adapters/claude-code/ from core/.
// Usage: tsx adapters/build-claude-code.ts [--check]
import { buildSync } from "esbuild";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree, diffTree, writeTree, type Tokens } from "./generate";

const TOKENS: Tokens = {
  ns: "estack",
  models_file: "~/.claude/rules/estack-models.md",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = join(root, "core");
const outDir = join(root, "adapters", "claude-code");

// Bundles the engine CLI into one self-contained ESM file. Deterministic: no
// timestamps, and paths are relative to root (absWorkingDir) so none leak in.
export function bundleEngine(projectRoot: string): Buffer {
  const result = buildSync({
    absWorkingDir: projectRoot,
    entryPoints: ["engine/src/cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    legalComments: "none",
    outfile: "estack.mjs",
    banner: {
      js: "#!/usr/bin/env -S node --no-warnings\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    external: ["node:*"],
  });
  return Buffer.from(result.outputFiles[0].contents);
}

function main(args: string[]): number {
  if (!existsSync(coreDir)) {
    console.error("error: core/ not found");
    return 2;
  }
  const tree = buildTree(coreDir, TOKENS);
  tree.set("engine/estack.mjs", { content: bundleEngine(root), mode: 0o755 });
  if (args.includes("--check")) {
    const differing = diffTree(outDir, tree);
    for (const rel of differing) console.log(`differs: adapters/claude-code/${rel}`);
    console.log(differing.length ? `${differing.length} files differ; run npm run build:claude` : "adapters/claude-code is up to date");
    return differing.length ? 1 : 0;
  }
  const { written, removed } = writeTree(outDir, tree);
  console.log(`adapters/claude-code: ${tree.size} files, ${written.length} written, ${removed.length} removed`);
  return 0;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
