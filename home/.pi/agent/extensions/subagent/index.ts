/**
 * Minimal Subagent Tool
 *
 * Runs one user-level agent from ~/.pi/agent/agents/*.md in an isolated
 * `pi --mode json --print --no-session` subprocess and returns its final text.
 * Intentionally single-agent only: no project-local prompts, no chaining, no
 * custom renderer. Keep orchestration in the main conversation unless repeated
 * use proves more is needed.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, formatAgentList } from "./agents.ts";

interface SubagentDetails {
	agent: string;
	task: string;
	exitCode: number;
	model?: string;
	cwd?: string;
	messages: Message[];
	stderr: string;
	aborted: boolean;
}

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the user-level agent to run" }),
	task: Type.String({ description: "Self-contained task to delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child agent. Defaults to current cwd." })),
});

function getFinalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && part.text.trim()) return part.text.trim();
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && part.text.trim()) {
				items.push({ type: "text", text: part.text.trim() });
			} else if (part.type === "toolCall") {
				items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function taskPreview(task: string): string {
	const singleLine = task.replace(/\s+/g, " ").trim();
	return singleLine.length > 100 ? `${singleLine.slice(0, 97)}...` : singleLine;
}

function shortenPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatToolCall(item: Extract<DisplayItem, { type: "toolCall" }>): string {
	switch (item.name) {
		case "bash": {
			const command = typeof item.args.command === "string" ? item.args.command : "...";
			const preview = command.replace(/\s+/g, " ").trim();
			return `$ ${preview.length > 80 ? `${preview.slice(0, 77)}...` : preview}`;
		}
		case "read":
		case "write":
		case "edit": {
			const filePath = item.args.path ?? item.args.file_path ?? "...";
			return `${item.name} ${shortenPath(String(filePath))}`;
		}
		default:
			return item.name;
	}
}

function formatDisplayItem(item: DisplayItem): string {
	if (item.type === "toolCall") return `→ ${formatToolCall(item)}`;
	return item.text;
}

function getUpdateText(details: SubagentDetails): string {
	const items = getDisplayItems(details.messages);
	const latest = items.at(-1);
	if (latest) return `⏳ ${details.agent}: ${formatDisplayItem(latest)}`;
	return `⏳ ${details.agent} running...`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writeTempPrompt(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

async function runAgent(params: {
	defaultCwd: string;
	agentName: string;
	task: string;
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: (text: string, details: SubagentDetails) => void;
}): Promise<SubagentDetails> {
	const agents = discoverAgents();
	const agent = agents.find((candidate) => candidate.name === params.agentName);
	if (!agent) {
		return {
			agent: params.agentName,
			task: params.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent "${params.agentName}". Available agents: ${formatAgentList(agents)}.`,
			aborted: false,
		};
	}

	const args = ["--mode", "json", "--print", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tempDir: string | undefined;
	let promptPath: string | undefined;
	if (agent.systemPrompt) {
		const temp = await writeTempPrompt(agent.name, agent.systemPrompt);
		tempDir = temp.dir;
		promptPath = temp.filePath;
		args.push("--append-system-prompt", promptPath);
	}
	args.push(`Task: ${params.task}`);

	const details: SubagentDetails = {
		agent: agent.name,
		task: params.task,
		exitCode: 0,
		model: agent.model,
		cwd: params.cwd,
		messages: [],
		stderr: "",
		aborted: false,
	};

	const emitUpdate = () => params.onUpdate?.(getUpdateText(details), details);

	try {
		const invocation = getPiInvocation(args);
		emitUpdate();
		details.exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: params.cwd ?? params.defaultCwd,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: Message };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					details.messages.push(event.message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (chunk) => {
				details.stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				details.stderr += error.message;
				resolve(1);
			});

			const abort = () => {
				details.aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000).unref();
			};

			if (params.signal?.aborted) abort();
			else params.signal?.addEventListener("abort", abort, { once: true });
		});
	} finally {
		if (promptPath) await fs.promises.rm(promptPath, { force: true });
		if (tempDir) await fs.promises.rm(tempDir, { force: true, recursive: true });
	}

	return details;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate one self-contained task to a user-level subagent with isolated context. Agents are loaded from ~/.pi/agent/agents/*.md.",
		promptSnippet: "Delegate narrow read-only reconnaissance or review to an isolated subagent",
		promptGuidelines: [
			"Use subagent for broad read-only reconnaissance or focused review that would otherwise pollute the main context.",
			"Pass a self-contained task with the relevant goal, paths, constraints, and expected output.",
			"Prefer one subagent call over multi-step orchestration unless the user explicitly asks for more.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const details = await runAgent({
				defaultCwd: ctx.cwd,
				agentName: params.agent,
				task: params.task,
				cwd: params.cwd,
				signal,
				onUpdate: onUpdate
					? (text, details) => onUpdate({ content: [{ type: "text", text }], details })
					: undefined,
			});

			const finalText = getFinalText(details.messages);
			if (details.aborted) {
				return { content: [{ type: "text" as const, text: "Subagent aborted." }], details, isError: true };
			}
			if (details.exitCode !== 0) {
				const message = details.stderr.trim() || finalText || `Subagent exited with code ${details.exitCode}.`;
				return { content: [{ type: "text" as const, text: message }], details, isError: true };
			}
			return { content: [{ type: "text" as const, text: finalText || "(no output)" }], details };
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent);
			if (args.cwd) text += theme.fg("muted", ` in ${shortenPath(args.cwd)}`);
			text += `\n${theme.fg("dim", `  ${taskPreview(args.task)}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}

			const failed = details.aborted || details.exitCode !== 0;
			const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}`;
			if (details.model) text += theme.fg("muted", ` (${details.model})`);
			if (details.cwd) text += theme.fg("muted", ` in ${shortenPath(details.cwd)}`);

			if (expanded) text += `\n${theme.fg("dim", `Task: ${details.task}`)}`;

			const toolCalls = getDisplayItems(details.messages).filter((item) => item.type === "toolCall");
			const shownToolCalls = expanded ? toolCalls : toolCalls.slice(-8);
			if (toolCalls.length > shownToolCalls.length) {
				text += `\n${theme.fg("muted", `... ${toolCalls.length - shownToolCalls.length} earlier actions`)}`;
			}
			for (const item of shownToolCalls) {
				text += `\n${theme.fg("muted", formatDisplayItem(item))}`;
			}

			const finalText = getFinalText(details.messages);
			if (finalText) {
				const preview = expanded ? finalText : finalText.split("\n").slice(0, 6).join("\n");
				text += `\n\n${theme.fg("toolOutput", preview)}`;
			} else if (!failed) {
				text += `\n${theme.fg("muted", "(no output)")}`;
			}

			if (failed && details.stderr.trim()) text += `\n${theme.fg("error", details.stderr.trim())}`;
			return new Text(text, 0, 0);
		},
	});
}
