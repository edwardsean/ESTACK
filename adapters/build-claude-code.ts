// Generates the Claude Code plugin in adapters/claude-code/ from core/.
// Usage: tsx adapters/build-claude-code.ts [--check]
import { existsSync } from "node:fs";
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

function main(args: string[]): number {
  if (!existsSync(coreDir)) {
    console.error("error: core/ not found");
    return 2;
  }
  const tree = buildTree(coreDir, TOKENS);
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

process.exitCode = main(process.argv.slice(2));
