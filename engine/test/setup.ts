import { afterAll, inject } from "vitest";
import { removeTempDirs } from "./temp";

// The run's temp folder (engine/test/global-setup.ts): os.tmpdir() here and in every command a test runs resolve to it.
const root = inject("estackTempRoot");
if (root) process.env.TMPDIR = root;

afterAll(removeTempDirs);
