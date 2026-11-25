// Builds an adapter's file tree from core/. Agent independent: an adapter
// supplies only its token values and its output directory.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

export type Tokens = Record<string, string>;
export interface TreeFile {
  content: Buffer;
  mode: number;
}
export type Tree = Map<string, TreeFile>;

export const TEXT_SUFFIXES: ReadonlySet<string> = new Set([".md", ".json", ".sh", ".py", ".ts", ".txt", ".yaml", ".yml"]);

const TOKEN = /\{\{estack:([a-z_]+)\}\}/g;
const JUNK_NAMES = new Set([".DS_Store", "__pycache__"]);

export function renderText(text: string, tokens: Tokens, file: string): string {
  return text.replace(TOKEN, (_match, name: string) => {
    const value = tokens[name];
    if (value === undefined) throw new Error(`${file}: unknown token {{estack:${name}}}`);
    return value;
  });
}

function isJunk(name: string): boolean {
  return JUNK_NAMES.has(name) || name.endsWith(".pyc");
}

function walk(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isJunk(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

export function buildTree(coreDir: string, tokens: Tokens): Tree {
  const tree: Tree = new Map();
  for (const rel of walk(coreDir)) {
    const path = join(coreDir, rel);
    const raw = readFileSync(path);
    const content = TEXT_SUFFIXES.has(extname(rel)) ? Buffer.from(renderText(raw.toString("utf8"), tokens, rel), "utf8") : raw;
    tree.set(rel, { content, mode: statSync(path).mode & 0o777 });
  }
  return tree;
}

function matches(path: string, file: TreeFile): boolean {
  if (!existsSync(path)) return false;
  return (statSync(path).mode & 0o777) === file.mode && readFileSync(path).equals(file.content);
}

function removeEmptyDirs(dir: string, root: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name), root);
  }
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
}

export function writeTree(outDir: string, tree: Tree): { written: string[]; removed: string[] } {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [rel, file] of tree) {
    const path = join(outDir, rel);
    if (matches(path, file)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
    chmodSync(path, file.mode);
    written.push(rel);
  }
  const removed = walkAll(outDir).filter((rel) => !tree.has(rel));
  for (const rel of removed) rmSync(join(outDir, rel));
  removeEmptyDirs(outDir, outDir);
  return { written, removed };
}

// Unlike walk(), sees junk files too, so stray junk in the output counts as extra.
function walkAll(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkAll(root, path));
    else files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

export function diffTree(outDir: string, tree: Tree): string[] {
  const differing = new Set<string>();
  for (const [rel, file] of tree) if (!matches(join(outDir, rel), file)) differing.add(rel);
  if (existsSync(outDir)) for (const rel of walkAll(outDir)) if (!tree.has(rel)) differing.add(rel);
  return [...differing].sort();
}
