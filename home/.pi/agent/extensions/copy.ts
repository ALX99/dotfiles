import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export interface ClipboardCandidate {
  command: string;
  args: string[];
}

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object";
}

export function extractAssistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") {
    return "";
  }

  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    if (block.text.length > 0) {
      textBlocks.push(block.text);
    }
  }

  return textBlocks.join("\n\n");
}

export function findLastAssistantText(entries: readonly unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message") {
      continue;
    }

    const text = extractAssistantText(entry.message);
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

export function getClipboardCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCandidate[] {
  if (platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }

  if (platform === "win32") {
    return [{ command: "clip.exe", args: [] }];
  }

  if (platform === "linux") {
    const candidates: ClipboardCandidate[] = [];
    if (env.WAYLAND_DISPLAY) {
      candidates.push({ command: "wl-copy", args: [] });
    }
    candidates.push(
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    );
    return candidates;
  }

  return [];
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const candidates = getClipboardCandidates();
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      await runClipboardCommand(candidate, text);
      return;
    } catch (error) {
      errors.push(formatClipboardError(candidate.command, error));
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No clipboard command configured for ${process.platform}`);
  }

  throw new Error(`Clipboard copy failed: ${errors.join("; ")}`);
}

async function runClipboardCommand(candidate: ClipboardCandidate, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, candidate.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // The child can close stdin early on failure; the close event reports the failure.
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const details = stderr.trim() || `exit code ${code ?? "unknown"}`;
      finish(new Error(details));
    });

    child.stdin.end(text, "utf8");
  });
}

function formatClipboardError(command: string, error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `${command}: ${error.message}`;
  }
  return `${command}: unknown error`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy", {
    description: "Copy the last visible assistant message to the clipboard",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const text = findLastAssistantText(ctx.sessionManager.getBranch());
      if (text === null) {
        if (ctx.hasUI) {
          ctx.ui.notify("No assistant message to copy", "warning");
        }
        return;
      }

      try {
        await copyTextToClipboard(text);
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(formatClipboardError("/copy", error), "error");
        }
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify("Copied last assistant message", "info");
      }
    },
  });
}
