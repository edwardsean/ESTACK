import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Kept on globalThis so the setup file and the test file share one list even if each loads its own copy of this module.
const made: string[] = ((globalThis as { __estackTempDirs?: string[] }).__estackTempDirs ??= []);

/** A fresh folder in the OS temp folder, symlinks resolved. engine/test/setup.ts removes it when the test file ends. */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** Remove every folder tempDir made so far in this test file. */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
