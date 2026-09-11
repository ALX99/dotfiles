import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import codexWebSearchExtension from "../index.ts";
import { RECALL_MESSAGE_TYPE, SEARCH_ENTRY_TYPE } from "../recall.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Renderer = (
	entry: { data?: unknown },
	options: { expanded: boolean },
	theme: { fg(color: string, text: string): string; bg(color: string, text: string): string },
) => { render(width: number): string[] } | undefined;

interface RecallTool {
	readonly name: string;
	readonly execute: (
		toolCallId: string,
		params: { query?: string },
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

type MessageRenderer = (
	message: { details?: unknown },
	options: { outputPad: number },
	theme: { fg(color: string, text: string): string },
) => { render(width: number): string[] } | undefined;

interface BeforeAgentStartResult {
	message?: { customType: string; content: string; display?: boolean; details?: unknown };
}

const STATUS_KEY = "codex-web-search";
const CODEX_MODEL = { provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses" };
const CODEX_URL = "wss://chatgpt.com/backend-api/codex/responses";
const NATIVE_WEBSOCKET = globalThis.WebSocket;
const THEME = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };

/** Stand-in for the runtime's WebSocket, which the extension's observer subclasses. */
class FakeWebSocket {
	private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

	addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
		const entries = this.listeners.get(type) ?? [];
		entries.push(listener);
		this.listeners.set(type, entries);
	}

	send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

	close(): void {}

	emitMessage(data: unknown): void {
		for (const listener of this.listeners.get("message") ?? []) listener({ data });
	}
}

const configDir = mkdtempSync(join(tmpdir(), "codex-web-search-extension-"));
const configFile = join(configDir, "config.json");
process.env.PI_CODEX_WEB_SEARCH_CONFIG = configFile;
after(() => {
	rmSync(configDir, { recursive: true, force: true });
	delete process.env.PI_CODEX_WEB_SEARCH_CONFIG;
});

function createHarness(config: Record<string, unknown> = {}) {
	writeFileSync(configFile, JSON.stringify(config));
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	const renderers = new Map<string, Renderer>();
	const tools = new Map<string, RecallTool>();
	const messageRenderers = new Map<string, MessageRenderer>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string>();
	let sessionId = "session-under-test";
	let activeTools: string[] = ["bash", "read"];
	let branch: SessionEntry[] = [];

	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerEntryRenderer(customType: string, renderer: Renderer) {
			renderers.set(customType, renderer);
		},
		registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) {
			commands.set(name, command);
		},
		registerTool(definition: RecallTool) {
			tools.set(definition.name, definition);
		},
		registerMessageRenderer(customType: string, renderer: MessageRenderer) {
			messageRenderers.set(customType, renderer);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		model: CODEX_MODEL,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push(type === undefined ? { message } : { message, type }),
			setStatus(key: string, text: string | undefined) {
				assert.equal(key, STATUS_KEY);
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			theme: THEME,
		},
	};

	globalThis.piCodexWebSearchObservers = undefined;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	codexWebSearchExtension(pi);

	return {
		handlers,
		commands,
		renderers,
		tools,
		messageRenderers,
		entries,
		notifications,
		statuses,
		ctx,
		activeTools: () => [...activeTools],
		/** Set the branch the next handler reads. */
		setEntries(branchEntries: SessionEntry[]): void {
			branch = branchEntries;
		},
		beforeAgentStart(): BeforeAgentStartResult | undefined {
			return handlers.get("before_agent_start")?.({}, ctx) as BeforeAgentStartResult | undefined;
		},
		compact(): void {
			handlers.get("session_compact")?.({}, ctx);
		},
		start(reason = "new"): void {
			handlers.get("session_start")?.({ reason }, ctx);
		},
		switchSession(next: string, reason = "new"): void {
			sessionId = next;
			handlers.get("session_start")?.({ reason }, ctx);
		},
		/** A Codex socket whose request already identified the current session. */
		socket(): FakeWebSocket {
			const socket = new globalThis.WebSocket(CODEX_URL) as unknown as FakeWebSocket;
			socket.send(JSON.stringify({ type: "response.create", prompt_cache_key: sessionId }));
			return socket;
		},
		restore(): void {
			globalThis.WebSocket = NATIVE_WEBSOCKET;
			globalThis.piCodexWebSearchObservers = undefined;
		},
	};
}

function searchFrame(query: string): unknown {
	return {
		type: "response.output_item.done",
		item: {
			type: "web_search_call",
			status: "completed",
			action: { type: "search", query, sources: [{ type: "url", url: `https://example.com/${query}` }] },
		},
	};
}

function searchEntry(query: string): { customType: string; data: unknown } {
	return {
		customType: "codex-web-search",
		data: { queries: [query], sources: [`https://example.com/${query}`], openedUrls: [], callCount: 1 },
	};
}

test("the provider hook injects the hosted tool for Codex and leaves other models alone", () => {
	const harness = createHarness();
	try {
		const handler = harness.handlers.get("before_provider_request");
		assert.ok(handler);

		const payload = {
			tools: [
				{ type: "function", name: "web_search" },
				{ type: "function", name: "bash" },
			],
		};
		assert.deepEqual(handler({ payload }, harness.ctx), {
			tools: [
				{ type: "function", name: "bash" },
				{ type: "web_search", external_web_access: true },
			],
			include: ["web_search_call.action.sources"],
		});

		const other = { tools: [{ type: "function", name: "web_search" }] };
		const otherCtx = { ...harness.ctx, model: { provider: "anthropic", id: "claude", api: "anthropic-messages" } };
		assert.equal(handler({ payload: other }, otherCtx), undefined);
		assert.equal(handler({ payload: "not a payload" }, harness.ctx), undefined);
	} finally {
		harness.restore();
	}
});

test("a disabled extension neither injects nor observes", () => {
	const harness = createHarness({ enabled: false });
	try {
		assert.equal(harness.handlers.get("before_provider_request")?.({ payload: { tools: [] } }, harness.ctx), undefined);
		harness.start();
		assert.equal(globalThis.piCodexWebSearchObservers, undefined);
	} finally {
		harness.restore();
	}
});

test("configuration diagnostics are reported once per session", () => {
	const harness = createHarness({ mode: "sideways" });
	try {
		harness.start();
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0]?.message ?? "", /mode/);
	} finally {
		harness.restore();
	}
});

test("search frames from this session drive the footer status and record a transcript entry", () => {
	const harness = createHarness();
	try {
		harness.start();
		const socket = harness.socket();

		socket.emitMessage(JSON.stringify({ type: "response.created" }));
		assert.equal(harness.statuses.has(STATUS_KEY), false);
		socket.emitMessage(JSON.stringify({ type: "response.web_search_call.searching" }));
		assert.equal(harness.statuses.get(STATUS_KEY), "web search…");

		socket.emitMessage(JSON.stringify(searchFrame("uv latest release")));
		socket.emitMessage(JSON.stringify({ type: "response.completed" }));

		assert.equal(harness.statuses.has(STATUS_KEY), false);
		assert.deepEqual(harness.entries, [searchEntry("uv latest release")]);
	} finally {
		harness.restore();
	}
});

test("a response without searches records nothing", () => {
	const harness = createHarness();
	try {
		harness.start();
		const socket = harness.socket();
		socket.emitMessage(JSON.stringify({ type: "response.created" }));
		socket.emitMessage(JSON.stringify({ type: "response.completed" }));
		assert.deepEqual(harness.entries, []);
		assert.equal(harness.statuses.has(STATUS_KEY), false);
	} finally {
		harness.restore();
	}
});

test("frames from other sessions are ignored", () => {
	const harness = createHarness();
	try {
		harness.start();
		const foreign = new globalThis.WebSocket(CODEX_URL) as unknown as FakeWebSocket;
		foreign.send(JSON.stringify({ type: "response.create", prompt_cache_key: "a-subagent-session" }));
		foreign.emitMessage(JSON.stringify(searchFrame("other")));
		foreign.emitMessage(JSON.stringify({ type: "response.completed" }));
		assert.deepEqual(harness.entries, []);
	} finally {
		harness.restore();
	}
});

test("switching sessions follows the new session key", () => {
	const harness = createHarness();
	try {
		harness.start();
		const previous = harness.socket();

		harness.switchSession("session-after-switch");
		const current = harness.socket();
		current.emitMessage(JSON.stringify(searchFrame("new session search")));
		current.emitMessage(JSON.stringify({ type: "response.completed" }));

		previous.emitMessage(JSON.stringify(searchFrame("old session search")));
		previous.emitMessage(JSON.stringify({ type: "response.completed" }));

		assert.deepEqual(harness.entries, [searchEntry("new session search")]);
	} finally {
		harness.restore();
	}
});

test("session shutdown disposes the observer and clears the status", () => {
	const harness = createHarness();
	try {
		harness.start();
		const socket = harness.socket();
		socket.emitMessage(JSON.stringify({ type: "response.web_search_call.searching" }));
		assert.equal(harness.statuses.get(STATUS_KEY), "web search…");

		harness.handlers.get("session_shutdown")?.({}, harness.ctx);
		socket.emitMessage(JSON.stringify(searchFrame("after shutdown")));
		socket.emitMessage(JSON.stringify({ type: "response.completed" }));

		assert.equal(harness.statuses.has(STATUS_KEY), false);
		assert.deepEqual(harness.entries, []);
	} finally {
		harness.restore();
	}
});

test("the entry renderer summarizes searches and expands sources", () => {
	const harness = createHarness();
	try {
		const renderer = harness.renderers.get("codex-web-search");
		assert.ok(renderer);
		const summary = {
			queries: ["uv latest release"],
			sources: ["https://a.example", "https://b.example", "https://c.example", "https://d.example"],
			openedUrls: [],
			callCount: 2,
		};

		const collapsed = renderer({ data: summary }, { expanded: false }, THEME);
		assert.ok(collapsed);
		const collapsedText = collapsed.render(80).join("\n");
		assert.match(collapsedText, /2 searches/);
		assert.match(collapsedText, /4 sources/);
		assert.match(collapsedText, /uv latest release/);
		assert.match(collapsedText, /\+1 more sources/);

		const expanded = renderer({ data: summary }, { expanded: true }, THEME);
		assert.ok(expanded);
		const expandedText = expanded.render(80).join("\n");
		assert.match(expandedText, /https:\/\/d\.example/);
		assert.doesNotMatch(expandedText, /more sources/);
	} finally {
		harness.restore();
	}
});

test("the status command reports the active model and config path", async () => {
	const harness = createHarness();
	try {
		const command = harness.commands.get("codex-web-search");
		assert.ok(command);
		const notifications: string[] = [];
		await command.handler("", { model: CODEX_MODEL, ui: { notify: (message: string) => notifications.push(message) } });
		assert.match(notifications[0] ?? "", /on for openai-codex\/gpt-5\.6-luna/);
		assert.match(notifications[0] ?? "", /mode=live/);
		assert.match(notifications[0] ?? "", new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally {
		harness.restore();
	}
});

const TIMESTAMP = new Date(0).toISOString();

function branchSearchEntry(id: string, query: string, extra: Record<string, unknown> = {}): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		customType: SEARCH_ENTRY_TYPE,
		data: { queries: [query], sources: [`https://example.com/${query}`], openedUrls: [], callCount: 1, ...extra },
	} as unknown as SessionEntry;
}

function compactionEntry(id: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 100,
	} as unknown as SessionEntry;
}

function pointerEntry(id: string, entryIds: string[]): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		customType: RECALL_MESSAGE_TYPE,
		content: "earlier searches are recoverable",
		details: { entryIds },
	} as unknown as SessionEntry;
}

test("nothing is advertised before a search is recorded", () => {
	const harness = createHarness();
	try {
		harness.setEntries([]);
		assert.ok(harness.tools.has("web_search_log"));
		assert.equal(harness.beforeAgentStart(), undefined);
		assert.equal(harness.activeTools().includes("web_search_log"), false);
	} finally {
		harness.restore();
	}
});

test("a recorded search is announced on the next prompt and announced only once", () => {
	const harness = createHarness();
	try {
		// A search lands mid-turn, after that turn's before_agent_start already ran.
		const search = branchSearchEntry("s1", "uv latest release");
		harness.setEntries([search]);

		const first = harness.beforeAgentStart();
		assert.equal(first?.message?.customType, RECALL_MESSAGE_TYPE);
		assert.match(first?.message?.content ?? "", /1 earlier web search recorded/);
		assert.deepEqual(first?.message?.details, { entryIds: ["s1"] });
		assert.equal(harness.activeTools().includes("web_search_log"), true);

		// The pointer is part of the branch now, so later prompts stay quiet.
		harness.setEntries([search, pointerEntry("p1", ["s1"])]);
		assert.equal(harness.beforeAgentStart(), undefined);

		// A later search is announced on its own.
		const later = branchSearchEntry("s2", "mise tasks");
		harness.setEntries([search, pointerEntry("p1", ["s1"]), later]);
		assert.deepEqual(harness.beforeAgentStart()?.message?.details, { entryIds: ["s2"] });
	} finally {
		harness.restore();
	}
});

test("a record this process never carried is announced on the first prompt", () => {
	const harness = createHarness();
	try {
		// Resuming a session: the record is on disk, and this process has no chain for it.
		const search = branchSearchEntry("s1", "uv latest release");
		harness.setEntries([search]);
		harness.start("resume");
		assert.deepEqual(harness.beforeAgentStart()?.message?.details, { entryIds: ["s1"] });
	} finally {
		harness.restore();
	}
});

test("a compaction mid-turn also marks the records it hid", () => {
	const harness = createHarness();
	try {
		const search = branchSearchEntry("s1", "uv latest release");
		harness.setEntries([search, compactionEntry("c1", "s1")]);
		harness.compact();
		assert.equal(harness.activeTools().includes("web_search_log"), true);
	} finally {
		harness.restore();
	}
});

test("the recall tool lists every search the session recorded", async () => {
	const harness = createHarness();
	try {
		const before = branchSearchEntry("s1", "uv latest release");
		const later = branchSearchEntry("s2", "mise tasks", { openedUrls: ["https://example.com/docs"] });
		harness.setEntries([before, later]);

		const tool = harness.tools.get("web_search_log");
		assert.ok(tool);

		const all = await tool.execute("call", {}, undefined, undefined, harness.ctx);
		assert.match(all.content[0]?.text ?? "", /uv latest release/);
		assert.match(all.content[0]?.text ?? "", /mise tasks/);

		const filtered = await tool.execute("call", { query: "docs" }, undefined, undefined, harness.ctx);
		assert.match(filtered.content[0]?.text ?? "", /mise tasks/);
		assert.doesNotMatch(filtered.content[0]?.text ?? "", /uv latest release/);
	} finally {
		harness.restore();
	}
});

test("the recall pointer renders its record count", () => {
	const harness = createHarness();
	try {
		const renderer = harness.messageRenderers.get(RECALL_MESSAGE_TYPE);
		assert.ok(renderer);
		const component = renderer({ details: { entryIds: ["s1", "s2"] } }, { outputPad: 0 }, THEME);
		assert.ok(component);
		assert.match(component.render(80).join("\n"), /2 earlier web searches re-sent with sources/);
	} finally {
		harness.restore();
	}
});
