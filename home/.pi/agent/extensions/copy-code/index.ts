import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { clipTerminalText, sanitizeTerminalText } from "../_shared/terminal-text.ts";

export interface CodeBlock {
	readonly language: string;
	readonly code: string;
}

interface OpeningFence {
	readonly character: "`" | "~";
	readonly length: number;
	readonly info: string;
}

const OPENING_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/u;
const CLOSING_FENCE = /^[ \t]{0,3}([`~]+)[ \t]*$/u;

export function extractCodeBlocks(markdown: string): CodeBlock[] {
	const lines = markdown.split(/\r\n|[\n\r]/u);
	const blocks: CodeBlock[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const opening = parseOpeningFence(lines[index] ?? "");
		if (opening === undefined) continue;

		let closingIndex = -1;
		for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
			if (isClosingFence(lines[candidate] ?? "", opening)) {
				closingIndex = candidate;
				break;
			}
		}

		const end = closingIndex === -1 ? lines.length : closingIndex;
		blocks.push({
			language: languageFromInfo(opening.info),
			code: lines.slice(index + 1, end).join("\n"),
		});

		if (closingIndex === -1) break;
		index = closingIndex;
	}

	return blocks;
}

export function getLastAssistantReply(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

		let text = "";
		for (const content of entry.message.content) {
			if (content.type === "text") text += content.text;
		}
		if (text.trim() !== "") return text;
		if (entry.message.stopReason !== "aborted") return undefined;
	}

	return undefined;
}

export function registerCopyCodeCommand(
	pi: ExtensionAPI,
	copy: (text: string) => Promise<void> = copyToClipboard,
): void {
	pi.registerCommand("cc", {
		description: "Copy a code block from the last agent reply directly when there is only one, otherwise ask",
		handler: async (_args, ctx) => {
			await copyCodeFromLastReply(ctx, copy);
		},
	});
}

async function copyCodeFromLastReply(
	ctx: ExtensionCommandContext,
	copy: (text: string) => Promise<void>,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/cc requires an interactive UI.", "warning");
		return;
	}

	await ctx.waitForIdle();
	const reply = getLastAssistantReply(ctx.sessionManager.getBranch());
	if (reply === undefined) {
		ctx.ui.notify("No agent reply to search.", "warning");
		return;
	}

	const blocks = extractCodeBlocks(reply);
	if (blocks.length === 0) {
		ctx.ui.notify("No fenced code blocks in the last agent reply.", "warning");
		return;
	}

	let selectedIndex = 0;
	if (blocks.length > 1) {
		const options = blocks.map(formatBlockOption);
		const selected = await ctx.ui.select("Select a code block to copy", options);
		if (selected === undefined) return;
		selectedIndex = options.indexOf(selected);
	}

	const block = blocks[selectedIndex]!;

	try {
		await copy(block.code);
		const language = sanitizeTerminalText(block.language) || "plain";
		ctx.ui.notify(`Copied ${language} code block to the clipboard.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not copy code block: ${sanitizeTerminalText(message)}`, "error");
	}
}

function parseOpeningFence(line: string): OpeningFence | undefined {
	const match = OPENING_FENCE.exec(line);
	if (match === null) return undefined;

	const marker = match[1]!;
	const character = marker[0];
	if (character !== "`" && character !== "~") return undefined;
	if (character === "`" && match[2]!.includes("`")) return undefined;

	return {
		character,
		length: marker.length,
		info: match[2]!,
	};
}

function isClosingFence(line: string, opening: OpeningFence): boolean {
	const match = CLOSING_FENCE.exec(line);
	if (match === null) return false;

	const marker = match[1]!;
	return marker.length >= opening.length && marker.split("").every((character) => character === opening.character);
}

function languageFromInfo(info: string): string {
	const language = info.trim().split(/\s+/u)[0] ?? "";
	return language || "plain";
}

function formatBlockOption(block: CodeBlock, index: number): string {
	const lines = block.code === "" ? 0 : block.code.split("\n").length;
	const lineLabel = `${lines} line${lines === 1 ? "" : "s"}`;
	const preview = block.code.split("\n").find((line) => line.trim() !== "") ?? "(empty block)";
	const language = clipTerminalText(block.language, 24);
	return `${index + 1}. ${language} · ${lineLabel} · ${clipTerminalText(preview, 72)}`;
}

export default function copyCodeExtension(pi: ExtensionAPI): void {
	registerCopyCodeCommand(pi);
}
