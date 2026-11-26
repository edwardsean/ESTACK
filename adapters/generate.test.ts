import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildTree, diffTree, renderText, writeTree } from "./generate";

const TOKENS = { ns: "estack" };
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "estack-gen-"));
  dirs.push(dir);
  return dir;
}

function put(root: string, rel: string, content: string | Buffer, mode = 0o644): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("renders known tokens", () => {
  expect(renderText("run /{{estack:ns}}:arena", TOKENS, "a.md")).toBe("run /estack:arena");
});

test("unknown token throws and names the file", () => {
  expect(() => renderText("{{estack:nss}}", TOKENS, "skills/x/SKILL.md")).toThrow(
    "skills/x/SKILL.md: unknown token {{estack:nss}}",
  );
});

test("non-estack braces are left alone", () => {
  expect(renderText("{{ user }}", TOKENS, "a.md")).toBe("{{ user }}");
});

test("binary files are copied byte for byte", () => {
  const core = tempDir();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x7b, 0x7b]);
  put(core, "img.png", bytes);
  expect(buildTree(core, TOKENS).get("img.png")?.content.equals(bytes)).toBe(true);
});

test("executable bit is preserved", () => {
  const core = tempDir();
  const out = tempDir();
  put(core, "hooks/x.sh", "#!/bin/sh\necho {{estack:ns}}\n", 0o755);
  writeTree(out, buildTree(core, TOKENS));
  expect(statSync(join(out, "hooks/x.sh")).mode & 0o111).not.toBe(0);
  expect(readFileSync(join(out, "hooks/x.sh"), "utf8")).toBe("#!/bin/sh\necho estack\n");
});

test("junk is excluded", () => {
  const core = tempDir();
  put(core, ".DS_Store", "x");
  put(core, "scripts/__pycache__/a.pyc", "x");
  put(core, "b.pyc", "x");
  put(core, "keep.md", "x");
  expect([...buildTree(core, TOKENS).keys()]).toEqual(["keep.md"]);
});

test("stale files are removed", () => {
  const core = tempDir();
  const out = tempDir();
  put(core, "a.md", "a");
  put(out, "old/old.md", "stale");
  const result = writeTree(out, buildTree(core, TOKENS));
  expect(result.removed).toEqual(["old/old.md"]);
  expect(existsSync(join(out, "old"))).toBe(false);
});

test("second write changes nothing", () => {
  const core = tempDir();
  const out = tempDir();
  put(core, "a.md", "a {{estack:ns}}");
  put(core, "hooks/x.sh", "x", 0o755);
  const tree = buildTree(core, TOKENS);
  writeTree(out, tree);
  expect(writeTree(out, tree)).toEqual({ written: [], removed: [] });
});

test("diffTree reports changed, missing and extra paths", () => {
  const core = tempDir();
  const out = tempDir();
  put(core, "a.md", "a");
  put(core, "b.md", "b");
  const tree = buildTree(core, TOKENS);
  writeTree(out, tree);
  writeFileSync(join(out, "a.md"), "edited by hand");
  rmSync(join(out, "b.md"));
  writeFileSync(join(out, "c.md"), "extra");
  expect(diffTree(out, tree)).toEqual(["a.md", "b.md", "c.md"]);
});

test("misspelled tokens fail instead of shipping", () => {
  for (const bad of ["{{estack:models-file}}", "{{estack:NS}}", "{{ estack:ns }}", "{{estack:ns}"]) {
    expect(() => renderText(`x ${bad} y`, TOKENS, "s.md")).toThrow("s.md: malformed token");
  }
});

test("text files without a known extension are rendered", () => {
  const core = tempDir();
  put(core, "bin/tool", "#!/bin/sh\necho {{estack:ns}}\n", 0o755);
  put(core, "data.tsv", "a\t{{estack:ns}}\n");
  const tree = buildTree(core, TOKENS);
  expect(tree.get("bin/tool")?.content.toString()).toBe("#!/bin/sh\necho estack\n");
  expect(tree.get("data.tsv")?.content.toString()).toBe("a\testack\n");
});

test("a token inside a binary file fails the build", () => {
  const core = tempDir();
  put(core, "blob.bin", Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("{{estack:ns}}")]));
  expect(() => buildTree(core, TOKENS)).toThrow("blob.bin: token in a binary file");
});

test("invalid UTF-8 is copied verbatim, not corrupted", () => {
  const core = tempDir();
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
  put(core, "note.md", latin1);
  expect(buildTree(core, TOKENS).get("note.md")?.content.equals(latin1)).toBe(true);
});
