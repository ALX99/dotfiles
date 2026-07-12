/**
 * Child subprocess management for spawn_agent.
 *
 * Runs the spawned agent as an isolated `pi --mode json --print --no-session`
 * subprocess — same pattern as pi's built-in bash tool. Streams JSON events
 * off stdout, aggregates usage/tool/text state, and emits throttled UI
 * updates. The run returns a small discriminated result so the tool boundary
 * can turn failed child runs into thrown pi tool errors.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa } from "execa";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { z } from "zod";

export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const UPDATE_THROTTLE_MS = 150;
const MAX_RECENT_TOOLS = 50;
const MAX_NESTED_RUNS = 8;
const MAX_NESTED_TOOLS = 8;

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
  agent: string;
  taskName: string;
  model?: string;
  depth: number;
  exitCode: number;
  messages: Message[];
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

/** Why a run could fail. Non-zero exit / abort become SpawnError; the run
 * details are attached so the tool layer can still render what happened. */
export type SpawnError =
  | { kind: "exit"; details: RunDetails }
  | { kind: "assistant"; details: RunDetails; message: string }
  | { kind: "aborted"; details: RunDetails };

export type RunResult =
  | { ok: true; details: RunDetails }
  | { ok: false; error: SpawnError };

export interface RunParams {
  defaultCwd: string;
  agent: AgentConfig;
  message: string;
  handoff?: string;
  taskName: string;
  model?: string;
  reasoningEffortOverride?: string;
  cwd?: string;
  parentDepth: number;
  signal?: AbortSignal;
  onUpdate?: (details: RunDetails) => void;
}

export interface BuildPiArgsParams {
  model?: string;
  reasoningEffortOverride?: string;
  tools?: string[];
  promptPath?: string;
  message: string;
  handoff?: string;
}

/** Spawns the child and resolves ok=true on a clean (exit 0) run, ok=false otherwise. */
export async function runSubprocess(params: RunParams): Promise<RunResult> {
  const details = initDetails(params);
  const finished = await runAndCollect(params, details);
  if (finished.aborted) return { ok: false, error: { kind: "aborted", details: finished } };
  if (finished.exitCode !== 0) return { ok: false, error: { kind: "exit", details: finished } };
  if (finished.assistantError) {
    return { ok: false, error: { kind: "assistant", details: finished, message: finished.assistantError } };
  }
  return { ok: true, details: finished };
}

function initDetails(params: RunParams): RunDetails {
  const childDepth = params.parentDepth + 1;
  return {
    agent: params.agent.name,
    taskName: params.taskName,
    model: params.model,
    depth: childDepth,
    exitCode: 0,
    messages: [],
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

async function runAndCollect(params: RunParams, details: RunDetails): Promise<RunDetails> {
  let tempDir: string | undefined;
  let promptPath: string | undefined;
  if (params.agent.systemPrompt) {
    const written = await writeTempPrompt(params.agent.name, params.agent.systemPrompt);
    tempDir = written.dir;
    promptPath = written.path;
  }

  const args = buildPiArgs({
    model: details.model,
    reasoningEffortOverride: params.reasoningEffortOverride,
    tools: params.agent.tools,
    promptPath,
    message: params.message,
    handoff: params.handoff,
  });

  const env = { ...process.env, [DEPTH_ENV]: String(details.depth) };
  const throttle = createThrottle(UPDATE_THROTTLE_MS);
  const emit = () => params.onUpdate?.(toUpdateSnapshot(details));

  const invocation = getPiInvocation(args);

  // execa handles the abort→SIGTERM→SIGKILL(5s) escalation, env merge,
  // spawn-error capture, and parent-exit cleanup for us. We just iterate
  // stdout lines (lines: stdout-only) and read exitCode/stderr at the end.
  const subprocess = execa(invocation.command, invocation.args, {
    cwd: params.cwd ?? params.defaultCwd,
    env: env as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    lines: { stdout: true, stderr: false },
    reject: false,
    cancelSignal: params.signal,
  });

  try {
    emit();
    for await (const line of subprocess) {
      ingestLine(line, details);
      throttle.schedule(emit);
    }
    const result = await subprocess;
    details.exitCode = result.exitCode ?? 1;
    const stderr = result.stderr;
    details.stderr = typeof stderr === "string" ? stderr : "";
    if (params.signal?.aborted) details.aborted = true;
  } catch (error) {
    // runAndCollect must never reject. Fold any execa/iterator error into
    // details so the tool layer still renders something.
    details.exitCode = 1;
    details.stderr = String(error instanceof Error ? error.message : error);
    if (params.signal?.aborted) details.aborted = true;
  } finally {
    details.endTime = Date.now();
    throttle.flush(emit);
    if (tempDir) await fs.promises.rm(tempDir, { force: true, recursive: true });
  }

  return details;
}

export function resolveEffectiveModel(agentModel: string | undefined): string | undefined {
  return agentModel;
}

export function buildPiArgs(params: BuildPiArgsParams): string[] {
  const args = ["--mode", "json", "--print", "--no-session"];
  if (params.model) args.push("--model", params.model);
  if (params.reasoningEffortOverride) args.push("--thinking", piThinkingLevel(params.reasoningEffortOverride));
  if (params.tools?.length) args.push("--tools", params.tools.join(","));
  if (params.promptPath) args.push("--append-system-prompt", params.promptPath);
  args.push(buildTaskPrompt(params.message, params.handoff));
  return args;
}

export function buildTaskPrompt(message: string, handoff?: string): string {
  const trimmedHandoff = handoff?.trim();
  if (!trimmedHandoff) return `Task: ${message}`;
  return `Task: ${message}\n\nParent handoff (trusted context; verify if needed):\n${trimmedHandoff}`;
}

function piThinkingLevel(reasoningEffort: string): string {
  return reasoningEffort === "none" ? "off" : reasoningEffort;
}

function toUpdateSnapshot(d: RunDetails): RunDetails {
  return {
    ...d,
    messages: [],
    recentTools: [...d.recentTools],
    nestedRuns: d.nestedRuns.map(copyNestedRun),
  };
}

function copyNestedRun(run: NestedRunDetails): NestedRunDetails {
  return {
    ...run,
    recentTools: [...run.recentTools],
    nestedRuns: run.nestedRuns.map(copyNestedRun),
  };
}

async function writeTempPrompt(agentName: string, systemPrompt: string): Promise<{ dir: string; path: string }> {
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
  details.messages.push(msg);
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

  for (const part of msg.content) {
    if (part.type === "toolCall") {
      details.toolCount++;
      details.recentTools.push({ name: part.name, argsPreview: argsPreview(part.arguments) });
      if (details.recentTools.length > MAX_RECENT_TOOLS) details.recentTools.shift();
    } else if (part.type === "text" && part.text.trim()) {
      const prose = part.text.split("\n").find((l) => l.trim() && !l.trimStart().startsWith("```"));
      if (prose) details.lastMessage = prose.trim();
    }
  }
}

function nestedRunFromArgs(toolCallId: string, args: unknown, depth: number): NestedRunDetails {
  const input = isRecord(args) ? args : {};
  const message = typeof input.message === "string" ? input.message : "(task unavailable)";
  return {
    toolCallId,
    agent: typeof input.agent_type === "string" && input.agent_type.trim() ? input.agent_type : "default",
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

/** Last non-empty assistant text block. Used by the tool layer for the
 * return content and by render.ts for the final output preview. */
export function getFinalText(messages: RunDetails["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j];
      if (part.type === "text" && part.text.trim()) return part.text.trim();
    }
  }
  return "";
}

/** Pick the runtime: re-exec the current script if it's a real file, else `pi`. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

// Leading-edge throttle. Loses a trailing update scheduled before fire — same
// trade-off as the original. flush() forces one out so the final state renders.
function createThrottle(intervalMs: number) {
  let pending = false;
  let lastFire = 0;
  let timer: NodeJS.Timeout | undefined;
  return {
    schedule(fn: () => void) {
      pending = true;
      const delay = intervalMs - (Date.now() - lastFire);
      if (delay <= 0) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        pending = false;
        lastFire = Date.now();
        fn();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          if (pending) {
            pending = false;
            lastFire = Date.now();
            fn();
          }
        }, delay);
      }
    },
    flush(fn: () => void) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (pending) {
        pending = false;
        lastFire = Date.now();
        fn();
      }
    },
  };
}
