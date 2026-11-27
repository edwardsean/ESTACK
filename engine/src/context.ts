import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Tokens in the context window as of the newest main-thread assistant entry in the transcript
 * (input + cache read + cache creation), or null when it can't be told.
 */
export function contextTokens(transcriptPath: string): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // started mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.type !== "assistant" || o.isSidechain === true) continue;
      const u = o.message?.usage;
      if (!u || typeof u !== "object") continue;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function contextRatio(transcriptPath: string | undefined, windowTokens: number): number | null {
  if (!transcriptPath || !(windowTokens > 0)) return null;
  const t = contextTokens(transcriptPath);
  return t === null ? null : t / windowTokens;
}
