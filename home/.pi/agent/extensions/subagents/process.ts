/** Shared run state and event folding for persistent RPC subagents. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { z } from "zod";

export const CHILD_CONTEXT_ENV = "PI_SUBAGENT_CONTEXT";
export const MAX_DELEGATION_DEPTH = 2;
const OUTPUT_NOTICE_RESERVE_BYTES = 2_048;
const OUTPUT_NOTICE_RESERVE_LINES = 2;
const MAX_RECENT_TOOLS = 50;
const MAX_NESTED_RUNS = 8;
const MAX_NESTED_TOOLS = 8;

const ChildExecutionContextSchema = z.strictObject({
  treeId: z.string().trim().min(1),
  depth: z.number().int().min(1).max(MAX_DELEGATION_DEPTH),
  agent: z.string().trim().min(1),
  profile: z.string().trim().min(1),
  delegationCredits: z.number().int().min(0),
});

export type ChildExecutionContext = Readonly<z.infer<typeof ChildExecutionContextSchema>>;

/** The sole parser for the child-process trust boundary. Absence identifies root. */
export function parseChildExecutionContext(value = process.env[CHILD_CONTEXT_ENV]): ChildExecutionContext | undefined {
  if (value === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (cause) {
    throw new Error(`Invalid ${CHILD_CONTEXT_ENV}: ${cause instanceof Error ? cause.message : String(cause)}.`);
  }
  const parsed = ChildExecutionContextSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid ${CHILD_CONTEXT_ENV}: ${issues}.`);
  }
  return Object.freeze(parsed.data);
}

export function serializeChildExecutionContext(context: ChildExecutionContext): string {
  const parsed = ChildExecutionContextSchema.parse(context);
  return JSON.stringify(parsed);
}

// ── trust boundary: the child's JSON event stream ───────────────────
const UsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  totalTokens: z.number().optional(),
  cost: z.object({ total: z.number().optional() }).optional(),
});

const ContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("toolCall"), name: z.string(), arguments: z.unknown() }),
  z.looseObject({ type: z.string() }), // roles/parts we don't read
]);

const MessageSchema = z.object({
  role: z.string(),
  content: z.array(ContentPartSchema),
  usage: UsageSchema.optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});

const MessageEndEventSchema = z.object({
  type: z.literal("message_end"),
  message: MessageSchema,
});

const ToolExecutionStartEventSchema = z.object({
  type: z.literal("tool_execution_start"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
});

const ToolExecutionUpdateEventSchema = z.object({
  type: z.literal("tool_execution_update"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  partialResult: z.unknown(),
});

const ToolExecutionEndEventSchema = z.object({
  type: z.literal("tool_execution_end"),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
});

const EventSchema = z.discriminatedUnion("type", [
  MessageEndEventSchema,
  ToolExecutionStartEventSchema,
  ToolExecutionUpdateEventSchema,
  ToolExecutionEndEventSchema,
]);

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/**
 * Mutable run state. Reused across the run: the JSON parser mutates it in
 * place and the render layer reads from it on every throttled update.
 */
export type NestedRunStatus = "running" | "completed" | "failed" | "aborted";

/** A compact, recursive view of a child spawned by this subagent. */
export interface NestedRunDetails {
  toolCallId: string;
  agent: string;
  taskName: string;
  depth: number;
  status: NestedRunStatus;
  toolCount: number;
  recentTools: Array<{ name: string; argsPreview: string }>;
  lastMessage: string;
  nestedRuns: NestedRunDetails[];
}

export interface RunDetails {
  agentId?: string;
  generation?: number;
  status?: string;
  agent: string;
  taskName: string;
  profile: string;
  model: string;
  effectiveThinking: string;
  sessionFile?: string;
  depth: number;
  exitCode: number;
  finalText: string;
  outputFile?: string;
  stderr: string;
  assistantError?: string;
  aborted: boolean;
  startTime: number;
  endTime?: number;
  toolCount: number;
  recentTools: Array<{ name: string; argsPreview: string }>;
  lastMessage: string;
  nestedRuns: NestedRunDetails[];
  tokens: number; // latest-turn snapshot for the context-window gauge
  usage: RunUsage;
  contextWindow?: number;
}

export interface InitRunDetailsParams {
  agent: AgentConfig;
  taskName: string;
  profile: string;
  model: string;
  effectiveThinking: string;
  sessionFile?: string;
  parentDepth: number;
}

export function initDetails(params: InitRunDetailsParams): RunDetails {
  const childDepth = params.parentDepth + 1;
  return {
    agent: params.agent.name,
    taskName: params.taskName,
    profile: params.profile,
    model: params.model,
    effectiveThinking: params.effectiveThinking,
    sessionFile: params.sessionFile,
    depth: childDepth,
    exitCode: 0,
    finalText: "",
    stderr: "",
    aborted: false,
    startTime: Date.now(),
    toolCount: 0,
    recentTools: [],
    lastMessage: "",
    nestedRuns: [],
    tokens: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };
}

export async function writeTempPrompt(agentName: string, systemPrompt: string): Promise<{ dir: string; path: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `${safeName}.md`);
  await fs.promises.writeFile(filePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
  return { dir, path: filePath };
}

/** Parse one JSON event line and fold it into the run details. */
export function ingestLine(line: string, details: RunDetails): void {
  if (!line.trim()) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }

  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) return; // unrelated event line — skip

  switch (parsed.data.type) {
    case "message_end": {
      const message = parsed.data.message;
      if (message.role === "assistant") {
        details.assistantError = message.stopReason === "error"
          ? message.errorMessage?.trim() || "Subagent assistant stopped with an error."
          : undefined;
      }
      ingestMessage(message as Message, details);
      return;
    }
    case "tool_execution_start":
      if (parsed.data.toolName === "spawn_agent") {
        upsertNestedRun(details, nestedRunFromArgs(parsed.data.toolCallId, parsed.data.args, details.depth + 1));
      }
      return;
    case "tool_execution_update":
      if (parsed.data.toolName !== "spawn_agent") return;
      updateNestedRun(details, parsed.data.toolCallId, parsed.data.partialResult, "running");
      return;
    case "tool_execution_end":
      if (parsed.data.toolName !== "spawn_agent") return;
      updateNestedRun(details, parsed.data.toolCallId, parsed.data.result, parsed.data.isError ? "failed" : "completed");
      return;
  }
}

function ingestMessage(msg: Message, details: RunDetails): void {
  if (msg.role !== "assistant") return;

  const u = msg.usage;
  if (u) {
    details.usage.turns++;
    details.usage.input += u.input ?? 0;
    details.usage.output += u.output ?? 0;
    details.usage.cacheRead += u.cacheRead ?? 0;
    details.usage.cacheWrite += u.cacheWrite ?? 0;
    details.usage.cost += u.cost?.total ?? 0;
    // Latest-turn snapshot — don't sum across turns; each turn re-sends the
    // whole conversation, so one assistant message already represents the
    // current context size.
    details.tokens = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  }

  const textParts: string[] = [];
  for (const part of msg.content) {
    if (part.type === "toolCall") {
      details.toolCount++;
      details.recentTools.push({ name: part.name, argsPreview: argsPreview(part.arguments) });
      if (details.recentTools.length > MAX_RECENT_TOOLS) details.recentTools.shift();
    } else if (part.type === "text" && part.text.trim()) {
      textParts.push(part.text.trim());
      const prose = part.text.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("```"));
      if (prose) details.lastMessage = prose.trim();
    }
  }
  if (textParts.length) retainFinalText(textParts.join("\n\n"), details);
}

/** Retain assistant text across every turn in this generation. Large handoffs
 * are truncated for parent context and written to a private temp file. */
function retainFinalText(text: string, details: RunDetails): void {
  const previous = fullRetainedText(details);
  removePreviousOutputFile(details);
  const combined = previous ? `${previous}\n\n${text}` : text;
  const truncated = truncateHead(combined, {
    maxBytes: DEFAULT_MAX_BYTES - OUTPUT_NOTICE_RESERVE_BYTES,
    maxLines: DEFAULT_MAX_LINES - OUTPUT_NOTICE_RESERVE_LINES,
  });
  if (!truncated.truncated) {
    details.finalText = combined;
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-output-"));
  const outputFile = path.join(dir, "final.md");
  fs.writeFileSync(outputFile, combined, { encoding: "utf8", mode: 0o600 });
  details.outputFile = outputFile;
  details.finalText = `${truncated.content}\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output saved to: ${outputFile}]`;
}

function fullRetainedText(details: RunDetails): string {
  if (!details.outputFile) return details.finalText;
  try {
    return fs.readFileSync(details.outputFile, "utf8");
  } catch {
    return details.finalText;
  }
}

function removePreviousOutputFile(details: RunDetails): void {
  if (!details.outputFile) return;
  const outputFile = details.outputFile;
  details.outputFile = undefined;
  try {
    fs.rmSync(path.dirname(outputFile), { force: true, recursive: true });
  } catch {
    // A stale temp file is preferable to failing an otherwise valid run.
  }
}

function nestedRunFromArgs(toolCallId: string, args: unknown, depth: number): NestedRunDetails {
  const input = isRecord(args) ? args : {};
  const message = typeof input.message === "string" ? input.message : "(task unavailable)";
  return {
    toolCallId,
    agent: typeof input.agent === "string" && input.agent.trim() ? input.agent : "general",
    taskName: typeof input.task_name === "string" && input.task_name.trim() ? input.task_name : clipAtWord(message, 60),
    depth,
    status: "running",
    toolCount: 0,
    recentTools: [],
    lastMessage: "",
    nestedRuns: [],
  };
}

function updateNestedRun(details: RunDetails, toolCallId: string, rawResult: unknown, fallbackStatus: NestedRunStatus): void {
  const existing = details.nestedRuns.find((run) => run.toolCallId === toolCallId)
    ?? nestedRunFromArgs(toolCallId, undefined, details.depth + 1);
  const snapshot = nestedRunFromResult(rawResult, existing, fallbackStatus);
  upsertNestedRun(details, snapshot);
}

function upsertNestedRun(details: RunDetails, run: NestedRunDetails): void {
  const index = details.nestedRuns.findIndex((item) => item.toolCallId === run.toolCallId);
  if (index >= 0) details.nestedRuns[index] = run;
  else details.nestedRuns.push(run);

  while (details.nestedRuns.length > MAX_NESTED_RUNS) {
    const completedIndex = details.nestedRuns.findIndex((item) => item.status !== "running");
    details.nestedRuns.splice(completedIndex >= 0 ? completedIndex : 0, 1);
  }
}

function nestedRunFromResult(
  rawResult: unknown,
  fallback: NestedRunDetails,
  fallbackStatus: NestedRunStatus,
  remainingDepth = 3,
): NestedRunDetails {
  const rawDetails = isRecord(rawResult) && isRecord(rawResult.details) ? rawResult.details : rawResult;
  if (!isRecord(rawDetails)) return { ...fallback, status: fallbackStatus };

  const status = isNestedRunStatus(rawDetails.status)
    ? rawDetails.status
    : rawDetails.aborted === true
      ? "aborted"
      : typeof rawDetails.exitCode === "number" && rawDetails.exitCode !== 0
        ? "failed"
        : rawDetails.endTime !== undefined
          ? "completed"
          : fallbackStatus;
  return {
    toolCallId: fallback.toolCallId,
    agent: typeof rawDetails.agent === "string" ? rawDetails.agent : fallback.agent,
    taskName: typeof rawDetails.taskName === "string" ? rawDetails.taskName : fallback.taskName,
    depth: typeof rawDetails.depth === "number" ? rawDetails.depth : fallback.depth,
    status,
    toolCount: typeof rawDetails.toolCount === "number" ? rawDetails.toolCount : fallback.toolCount,
    recentTools: nestedTools(rawDetails.recentTools),
    lastMessage: typeof rawDetails.lastMessage === "string" ? rawDetails.lastMessage : fallback.lastMessage,
    nestedRuns: remainingDepth > 0 ? nestedRuns(rawDetails.nestedRuns, remainingDepth - 1) : [],
  };
}

function nestedTools(raw: unknown): NestedRunDetails["recentTools"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.argsPreview !== "string") return [];
    return [{ name: item.name, argsPreview: item.argsPreview }];
  }).slice(-MAX_NESTED_TOOLS);
}

function nestedRuns(raw: unknown, remainingDepth: number): NestedRunDetails[] {
  if (!Array.isArray(raw) || remainingDepth < 0) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item) || typeof item.toolCallId !== "string") return [];
    return [nestedRunFromResult(item, nestedRunFromArgs(item.toolCallId, undefined, 0), "running", remainingDepth)];
  }).slice(-MAX_NESTED_RUNS);
}

function isNestedRunStatus(value: unknown): value is NestedRunStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "aborted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pick the runtime: re-exec the current script if it's a real file, else `pi`. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.exec(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

// ── small helpers ─────────────────────────────────────────────────────

function clipAtWord(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? one.slice(0, lastSpace) : cut) + "…";
}

export function argsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["path", "file_path", "command", "query", "url", "pattern", "content"]) {
    const v = a[k];
    if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  }
  return JSON.stringify(args).replace(/\s+/g, " ").trim();
}
