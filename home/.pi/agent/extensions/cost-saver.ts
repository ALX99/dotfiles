/**
 * Cost Saver Extension for pi
 *
 * Reproduces two high-impact cost-saving measures from the Dirac harness:
 *
 * 1. FILE SIZE GUARD      – Blocks full-file reads > 50 KB before they hit the
 *    context window, forcing the model to use offset/limit.
 *
 * 2. FILE HASH DEDUP      – Computes a SHA-256 hash of every full-file read.
 *    If the model re-reads an unchanged file, the tool is blocked with a
 *    cheap "no changes" message instead of flooding the context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_FULL_READ_BYTES = 50 * 1024; // 50 KB

function sha256Short(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/* ======================================================================== */
/*  Extension factory                                                       */
/* ======================================================================== */

export default function(pi: ExtensionAPI) {
  // absolute path -> hash of the last successful full-file read
  const fileHashCache = new Map<string, string>();

  /* -------------------------------------------------------------------- */
  /*  1. File size guard + hash dedup (intercept read tool calls)         */
  /* -------------------------------------------------------------------- */

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("read", event)) return;

    const { path, offset, limit } = event.input;

    // If the model is already being surgical, let it through.
    if (offset !== undefined || limit !== undefined) return;

    const absPath = resolve(ctx.cwd, path || "");

    // ---- File size guard ----
    let fileStats;
    try {
      fileStats = await stat(absPath);
    } catch {
      return; // File doesn't exist; let the real tool return the error.
    }

    if (!fileStats.isFile()) return;

    if (fileStats.size > MAX_FULL_READ_BYTES) {
      return {
        block: true,
        reason:
          `File size is ${(fileStats.size / 1024).toFixed(0)}KB, which exceeds the ${MAX_FULL_READ_BYTES / 1024}KB limit for full-file reads. ` +
          `Do not retry a full read. First, use grep to find concrete words, symbols, or error text relevant to your task. ` +
          `Then read only the matching ranges and their surrounding context with offset/limit.`,
      };
    }

    // ---- Hash dedup ----
    const cachedHash = fileHashCache.get(absPath);
    if (cachedHash) {
      let currentHash: string | undefined;
      try {
        const buffer = await readFile(absPath);
        currentHash = sha256Short(buffer);
      } catch {
        return; // Let the real tool handle read errors.
      }

      if (currentHash === cachedHash) {
        return {
          block: true,
          reason:
            `No changes have been made to the file since your last read (hash: ${cachedHash}). ` +
            `Use offset/limit if you need to re-examine specific sections.`,
        };
      }
    }
  });

  /* -------------------------------------------------------------------- */
  /*  2. Remember hashes from successful full-file reads                    */
  /* -------------------------------------------------------------------- */

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read") return;
    if (event.isError) return;

    const input = event.input as { path?: string; offset?: number; limit?: number };
    if (input.offset !== undefined || input.limit !== undefined) return;

    const absPath = resolve(ctx.cwd, input.path || "");

    try {
      const buffer = await readFile(absPath);
      fileHashCache.set(absPath, sha256Short(buffer));
    } catch {
      // Ignore read errors here; the tool already handled them.
    }
  });


  /* -------------------------------------------------------------------- */
  /*  3. Clean up on session end                                            */
  /* -------------------------------------------------------------------- */

  pi.on("session_compact", () => {
    // Compaction discards old context, so cached hashes are stale —
    // allow re-reading files that the agent can no longer "remember".
    fileHashCache.clear();
  });

  pi.on("session_shutdown", () => {
    fileHashCache.clear();
  });
}
