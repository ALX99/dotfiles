/**
 * Child subprocess management for spawn_agent.
 *
 * Runs the spawned agent as an isolated `pi --mode json --print --no-session`
 * subprocess — same pattern as pi's built-in bash tool. Streams JSON events
 * off stdout, aggregates usage/tool/text state, and emits throttled UI
 * updates. ResultAsync wraps the spawn so the tool layer's only job is to
 * resolve the agent and render the outcome.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa } from "execa";
import type { Message } from "@earendil-works/pi-ai";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { AgentConfig } from "./agents.ts";
import { z } from "zod";

export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const UPDATE_THROTTLE_MS = 150;
const MAX_RECENT_TOOLS = 50;

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
});

const EventSchema = z.object({
  type: z.literal("message_end"),
  message: MessageSchema,
});




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
export interface RunDetails {
  agent: string;
  taskName: string;
  model?: string;
  depth: number;
  exitCode: number;
  messages: Message[];
  stderr: string;
  aborted: boolean;
  startTime: number;
  endTime?: number;
  toolCount: number;
  recentTools: Array<{ name: string; argsPreview: string }>;
  lastMessage: string;
  tokens: number; // latest-turn snapshot for the context-window gauge
  usage: RunUsage;
  contextWindow?: number;
}

/** Why a run could fail. Non-zero exit / abort become SpawnError; the run
 * details are attached so the tool layer can still render what happened. */
export type SpawnError =
  | { kind: "exit"; details: RunDetails }
  | { kind: "aborted"; details: RunDetails };

export interface RunParams {
  defaultCwd: string;
  agent: AgentConfig;
  message: string;
  taskName: string;
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
}

/** Spawns the child and resolves Ok on a clean (exit 0) run, Err otherwise. */
export function runSubprocess(params: RunParams): ResultAsync<RunDetails, SpawnError> {
  const details = initDetails(params);
  // runAndCollect never rejects — failures land in details.aborted/exitCode —
  // so fromSafePromise is the honest wrapper (no synthetic error type).
  return ResultAsync.fromSafePromise(runAndCollect(params, details)).andThen((d) => {
    if (d.aborted) return errAsync({ kind: "aborted" as const, details: d });
    if (d.exitCode !== 0) return errAsync({ kind: "exit" as const, details: d });
    return okAsync(d);
  });
}

function initDetails(params: RunParams): RunDetails {
  const childDepth = params.parentDepth + 1;
  return {
    agent: params.agent.name,
    taskName: params.taskName,
    model: params.agent.model,
    depth: childDepth,
    exitCode: 0,
    messages: [],
    stderr: "",
    aborted: false,
    startTime: Date.now(),
    toolCount: 0,
    recentTools: [],
    lastMessage: "",
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
    // runAndCollect must never reject — runSubprocess wraps it in
    // ResultAsync.fromSafePromise. Fold any execa/iterator error into
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

export function buildPiArgs(params: BuildPiArgsParams): string[] {
  const args = ["--mode", "json", "--print", "--no-session"];
  if (params.model) args.push("--model", params.model);
  if (params.reasoningEffortOverride) args.push("--thinking", piThinkingLevel(params.reasoningEffortOverride));
  if (params.tools?.length) args.push("--tools", params.tools.join(","));
  if (params.promptPath) args.push("--append-system-prompt", params.promptPath);
  args.push(`Task: ${params.message}`);
  return args;
}

function piThinkingLevel(reasoningEffort: string): string {
  return reasoningEffort === "none" ? "off" : reasoningEffort;
}

function toUpdateSnapshot(d: RunDetails): RunDetails {
  return { ...d, messages: [], recentTools: [...d.recentTools] };
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
  const msg = parsed.data.message as Message;
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

/** Last non-empty assistant text block. Used by the tool layer for the
 * return content and by render.ts for the final output preview. */
export function getFinalText(messages: RunDetails["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
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
