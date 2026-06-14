import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, stat, appendFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MAX_MEMORY_BYTES = 32 * 1024;
const GLOBAL_MEMORY_PATH = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "pi-agent",
  "memory",
  "global.md",
);

type MemoryScope = "global" | "repo";

interface MemoryFile {
  scope: MemoryScope;
  label: string;
  filePath: string;
  content?: string;
  truncated: boolean;
}

async function findRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
  if (result.code !== 0) return undefined;
  const root = result.stdout.trim();
  return root || undefined;
}

function repoMemoryPath(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "memory", "repo.md");
}

async function readMemoryFile(scope: MemoryScope, label: string, filePath: string): Promise<MemoryFile> {
  try {
    const info = await stat(filePath);
    let content = await readFile(filePath, "utf8");
    let truncated = false;

    if (info.size > MAX_MEMORY_BYTES) {
      content = content.slice(-MAX_MEMORY_BYTES);
      truncated = true;
    }

    return { scope, label, filePath, content: content.trim(), truncated };
  } catch {
    return { scope, label, filePath, truncated: false };
  }
}

async function loadMemoryFiles(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext): Promise<MemoryFile[]> {
  const files = [await readMemoryFile("global", "Global memory", GLOBAL_MEMORY_PATH)];

  const repoRoot = await findRepoRoot(pi, ctx.cwd);
  if (repoRoot) {
    files.push(await readMemoryFile("repo", "Repository memory", repoMemoryPath(repoRoot)));
  }

  return files;
}

function formatMemoryBlock(files: MemoryFile[]): string | undefined {
  const loaded = files.filter((file) => file.content);
  if (!loaded.length) return undefined;

  const sections = loaded.map((file) => {
    const truncation = file.truncated ? "\n[Only the latest portion is included because the memory file exceeded the size cap.]" : "";
    return `## ${file.label}\nPath: ${file.filePath}${truncation}\n\n${file.content}`;
  });

  return `<memory>
These memories are advisory context from previous sessions. Prefer explicit user instructions and repository files when they conflict. If a memory becomes stable project policy, suggest promoting it to AGENTS.md.

${sections.join("\n\n")}
</memory>`;
}

function parseCaptureArgs(args: string): { scope?: MemoryScope; note: string } {
  const trimmed = args.trim();
  const match = /^(global|repo)\s+([\s\S]+)/.exec(trimmed);
  if (!match) return { note: trimmed };
  return { scope: match[1] as MemoryScope, note: match[2].trim() };
}

async function chooseCaptureTarget(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  requestedScope?: MemoryScope,
): Promise<{ scope: MemoryScope; filePath: string } | undefined> {
  if (requestedScope === "global") return { scope: "global", filePath: GLOBAL_MEMORY_PATH };

  const repoRoot = await findRepoRoot(pi, ctx.cwd);
  if (requestedScope === "repo") {
    if (!repoRoot) {
      ctx.ui.notify("/memory-capture repo requires running inside a git repository.", "warning");
      return undefined;
    }
    return { scope: "repo", filePath: repoMemoryPath(repoRoot) };
  }

  if (repoRoot) return { scope: "repo", filePath: repoMemoryPath(repoRoot) };
  return { scope: "global", filePath: GLOBAL_MEMORY_PATH };
}

async function appendMemory(filePath: string, note: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `\n## ${timestamp}\n\n${note.trim()}\n`, "utf8");
}

function statusText(files: MemoryFile[]): string {
  return files
    .map((file) => {
      const state = file.content ? `loaded${file.truncated ? " (truncated)" : ""}` : "missing";
      return `${file.label}: ${state}\n${file.filePath}`;
    })
    .join("\n\n");
}

const MEMORY_INSTRUCTIONS = `<memory_capture_policy>
When you learn durable information that would help future sessions, proactively call memory_save.
Good candidates: stable user preferences, recurring repo conventions, architecture gotchas, commands, workflows, and decisions likely to remain true.
Do not save secrets, credentials, one-off task details, guesses, transient debugging notes, or information already clearly covered by AGENTS.md.
Use scope "repo" for project-specific memories and "global" for cross-repository user preferences.
The user will be asked to approve or reject each memory_save call before anything is written.
</memory_capture_policy>`;

export default function(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const block = formatMemoryBlock(await loadMemoryFiles(pi, ctx));
    return { systemPrompt: `${event.systemPrompt}\n\n${MEMORY_INSTRUCTIONS}${block ? `\n\n${block}` : ""}` };
  });

  pi.registerCommand("memory", {
    description: "Show lightweight memory status and file paths",
    handler: async (_args, ctx) => {
      const files = await loadMemoryFiles(pi, ctx);
      ctx.ui.notify(statusText(files), "info");
    },
  });

  pi.registerCommand("memory-capture", {
    description: "Append a note to repo or global memory: /memory-capture [repo|global] <note>",
    handler: async (args, ctx) => {
      const { scope, note } = parseCaptureArgs(args);
      if (!note) {
        ctx.ui.notify("Usage: /memory-capture [repo|global] <note>", "warning");
        return;
      }

      const target = await chooseCaptureTarget(pi, ctx, scope);
      if (!target) return;

      await appendMemory(target.filePath, note);
      ctx.ui.notify(`Saved ${target.scope} memory:\n${target.filePath}`, "info");
    },
  });

  pi.registerTool({
    name: "memory_save",
    label: "Save Memory",
    description: "Propose saving a durable global or repository-scoped memory. The user must approve before it is written.",
    promptSnippet: "Save approved durable memories for future sessions",
    promptGuidelines: [
      "Use memory_save proactively when you learn durable information useful for future sessions.",
      "Use memory_save with scope repo for project-specific conventions, gotchas, commands, or decisions.",
      "Use memory_save with scope global for cross-repository user preferences.",
      "Do not use memory_save for secrets, transient task details, guesses, or information already clearly covered by AGENTS.md.",
    ],
    parameters: Type.Object({
      scope: StringEnum(["global", "repo"], { description: "Where to save the memory" }),
      note: Type.String({ description: "Concise durable memory to save" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const note = params.note.trim();
      if (!note) {
        return { content: [{ type: "text", text: "Memory not saved: note was empty." }], details: { saved: false } };
      }

      const target = await chooseCaptureTarget(pi, ctx, params.scope);
      if (!target) {
        return { content: [{ type: "text", text: "Memory not saved: target scope is unavailable." }], details: { saved: false } };
      }

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Memory not saved: interactive approval is required but UI is unavailable." }],
          details: { saved: false, scope: target.scope, filePath: target.filePath, note },
        };
      }

      const ok = await ctx.ui.confirm(
        `Save ${target.scope} memory?`,
        `${note}\n\nPath:\n${target.filePath}`,
        { signal },
      );
      if (!ok) {
        return {
          content: [{ type: "text", text: "Memory not saved: user rejected it." }],
          details: { saved: false, scope: target.scope, filePath: target.filePath, note },
        };
      }

      await appendMemory(target.filePath, note);
      return {
        content: [{ type: "text", text: `Saved ${target.scope} memory to ${target.filePath}.` }],
        details: { saved: true, scope: target.scope, filePath: target.filePath, note },
      };
    },
  });
}
