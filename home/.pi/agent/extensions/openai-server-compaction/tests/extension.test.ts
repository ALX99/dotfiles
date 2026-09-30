import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ModelRegistry, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";

import openAIServerCompactionExtension from "../index.ts";
import { buildRemoteCompactionDetails, type BranchEntryLike } from "../session-history.ts";

const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const COMPACTION_STREAM = [
	`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque" } })}\n\n`,
	`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`,
	"data: [DONE]",
	"",
].join("\n");

function model(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 400_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<Api>;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-6.1-sol",
		usage: NO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function compactionEntry(id: string, encryptedContent = "opaque"): BranchEntryLike {
	return {
		type: "compaction",
		id,
		details: {
			remoteCompaction: buildRemoteCompactionDetails(model({}), [
				{ type: "compaction", encrypted_content: encryptedContent },
			]),
		},
	};
}

function createHarness(options: {
	sessionId: string;
	model?: Model<Api>;
	oauth?: boolean;
	apiKey?: string;
	branch?: BranchEntryLike[];
	cwd?: string;
	summary?: string;
	summarize?: (...args: Parameters<ModelRegistry["streamSimple"]>) => Promise<AssistantMessage>;
}) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const notifications: string[] = [];
	const summaryCalls: Parameters<ModelRegistry["streamSimple"]>[] = [];
	let branch = options.branch ?? [];

	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, handler);
		},
		getAllTools: () => [{ name: "read", description: "read a file", parameters: { type: "object" } }],
		getActiveTools: () => ["read"],
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	openAIServerCompactionExtension(pi);

	const ctx = {
		cwd: options.cwd ?? mkdtempSync(join(tmpdir(), "openai-server-compaction-session-")),
		mode: "tui",
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		model: options.model ?? model({}),
		sessionManager: {
			getSessionId: () => options.sessionId,
			getBranch: () => branch,
		},
		modelRegistry: {
			isUsingOAuth: () => options.oauth === true,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: options.apiKey ?? "sk-test", headers: {} }),
			streamSimple(...args: Parameters<ModelRegistry["streamSimple"]>) {
				summaryCalls.push(args);
				return {
					result: () =>
						options.summarize === undefined
							? Promise.resolve(assistantMessage(options.summary ?? "portable summary"))
							: options.summarize(...args),
				};
			},
		},
		getSystemPrompt: () => "system prompt",
	};

	const emit = async (event: string, payload: unknown): Promise<unknown> => {
		const handler = handlers.get(event);
		assert.ok(handler !== undefined, `no handler for ${event}`);
		return await handler(payload, ctx);
	};

	return {
		emit,
		notifications,
		summaryCalls,
		setBranch: (entries: BranchEntryLike[]) => {
			branch = entries;
		},
	};
}

/** One compaction request, as the session manager hands it to extensions. */
function compactionEvent(
	branch: BranchEntryLike[],
): Omit<SessionBeforeCompactEvent, "branchEntries"> & { branchEntries: BranchEntryLike[] } {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [userMessage("old work")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 300_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 64_000, keepRecentTokens: 20_000 },
		},
		branchEntries: branch,
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
	};
}

test("a compaction stores OpenAI's replacement history next to Pi's own summary", async () => {
	const harness = createHarness({ sessionId: "session-compact" });
	const branch = [
		{ type: "message", id: "m1", message: userMessage("old work") },
		{ type: "message", id: "m2", message: assistantMessage("older answer") },
	];
	const sent: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		sent.push(typeof init?.body === "string" ? init.body : "");
		return new Response(COMPACTION_STREAM, { status: 200 });
	};

	try {
		const result = (await harness.emit("session_before_compact", compactionEvent(branch))) as {
			compaction: Record<string, unknown>;
		};

		assert.equal(result.compaction.summary, "portable summary", "Pi's own text summary is still stored");
		assert.equal(result.compaction.firstKeptEntryId, "kept-1");
		assert.deepEqual(result.compaction.usage, NO_USAGE);
		const details = result.compaction.details as {
			localSummaryDetails: { readFiles: string[]; modifiedFiles: string[] };
			remoteCompaction: {
				version: number;
				modelKey: string;
				replacementHistory: unknown[];
				usage: { totalTokens: number };
			};
		};
		assert.deepEqual(details.localSummaryDetails, { readFiles: [], modifiedFiles: [] });
		assert.equal(details.remoteCompaction.version, 2);
		assert.equal(details.remoteCompaction.modelKey, "openai:openai-responses:gpt-6.1-sol");
		assert.equal(details.remoteCompaction.usage.totalTokens, 15);
		assert.deepEqual(
			details.remoteCompaction.replacementHistory,
			[
				{ type: "message", role: "user", content: [{ type: "input_text", text: "old work" }] },
				{ type: "compaction", encrypted_content: "opaque" },
			],
			"the encrypted item replaces the summarized turns, and the newest question stays verbatim",
		);

		const body = JSON.parse(sent[0] ?? "{}") as { store: boolean; input: { type: string }[] };
		assert.equal(body.store, false);
		assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("repeated compaction summarizes Pi's prepared span with its previous summary, files and usage", async () => {
	const usage = { ...NO_USAGE, input: 7, output: 3, totalTokens: 10 };
	const harness = createHarness({
		sessionId: "session-repeat",
		branch: [compactionEntry("previous")],
		summarize: async () => ({ ...assistantMessage("updated summary"), usage }),
	});
	const event = compactionEvent([
		compactionEntry("previous"),
		{ type: "message", id: "kept-1", message: userMessage("kept work must not be summarized") },
	]);
	event.preparation.previousSummary = "previous decisions";
	event.customInstructions = "focus on unresolved work";
	event.preparation.fileOps = {
		read: new Set(["read.ts", "edited.ts"]),
		written: new Set(["new.ts"]),
		edited: new Set(["edited.ts"]),
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(COMPACTION_STREAM);

	try {
		const result = (await harness.emit("session_before_compact", event)) as {
			compaction: {
				summary: string;
				usage: unknown;
				details: { localSummaryDetails: unknown };
			};
		};
		assert.match(result.compaction.summary, /^updated summary/);
		assert.match(result.compaction.summary, /<read-files>\nread.ts/);
		assert.match(result.compaction.summary, /<modified-files>\nedited.ts\nnew.ts/);
		assert.deepEqual(result.compaction.usage, usage);
		assert.deepEqual(result.compaction.details.localSummaryDetails, {
			readFiles: ["read.ts"],
			modifiedFiles: ["edited.ts", "new.ts"],
		});
		assert.equal(harness.summaryCalls.length, 1);
		const [, context, options] = harness.summaryCalls[0]!;
		const prompt = JSON.stringify(context);
		assert.match(prompt, /old work/);
		assert.match(prompt, /previous decisions/);
		assert.match(prompt, /focus on unresolved work/);
		assert.doesNotMatch(prompt, /kept work must not be summarized|opaque/);
		assert.equal(options?.signal, event.signal);
		assert.equal(options?.apiKey, "sk-test");
		assert.deepEqual(options?.headers, {});
		assert.equal(options?.reasoning, "high");
		assert.equal(options?.maxTokens, 51_200);
		assert.equal(options?.cacheRetention, "none");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a split turn keeps the history and turn-prefix checkpoints and accounts for both summaries", async () => {
	const usage = { ...NO_USAGE, input: 7, output: 3, totalTokens: 10 };
	const harness = createHarness({
		sessionId: "session-split",
		summarize: async (_model, context) => ({
			...assistantMessage(JSON.stringify(context).includes("prefix work") ? "prefix checkpoint" : "history checkpoint"),
			usage,
		}),
	});
	const event = compactionEvent([]);
	event.preparation.isSplitTurn = true;
	event.preparation.turnPrefixMessages = [userMessage("prefix work")];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(COMPACTION_STREAM);

	try {
		const result = (await harness.emit("session_before_compact", event)) as {
			compaction: { summary: string; usage: { input: number; output: number; totalTokens: number } };
		};
		assert.match(result.compaction.summary, /history checkpoint.*Turn Context \(split turn\).*prefix checkpoint/s);
		assert.equal(result.compaction.usage.input, 14);
		assert.equal(result.compaction.usage.output, 6);
		assert.equal(result.compaction.usage.totalTokens, 20);
		assert.equal(harness.summaryCalls.length, 2);
		assert.deepEqual(
			harness.summaryCalls.map(([, , options]) => options?.maxTokens),
			[51_200, 32_000],
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an unusable portable summary is not persisted and does not cause a second summary attempt", async () => {
	const harness = createHarness({
		sessionId: "session-partial-summary",
		summarize: async () => ({ ...assistantMessage("partial checkpoint must not be saved"), stopReason: "length" }),
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(COMPACTION_STREAM);

	try {
		const result = (await harness.emit("session_before_compact", compactionEvent([]))) as {
			compaction: {
				summary: string;
				usage?: unknown;
				details: { remoteCompaction: unknown; localSummaryDetails?: unknown };
			};
		};
		assert.match(result.compaction.summary, /OpenAI remote compaction applied/);
		assert.doesNotMatch(result.compaction.summary, /partial checkpoint/);
		assert.ok(result.compaction.details.remoteCompaction);
		assert.equal(result.compaction.details.localSummaryDetails, undefined);
		assert.equal(result.compaction.usage, undefined);
		assert.equal(harness.summaryCalls.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("failure of both requests leaves compaction to Pi", async () => {
	const harness = createHarness({
		sessionId: "session-both-failed",
		summarize: async () => {
			throw new Error("summary unavailable");
		},
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("remote unavailable", { status: 500 });

	try {
		assert.equal(await harness.emit("session_before_compact", compactionEvent([])), undefined);
		assert.equal(harness.summaryCalls.length, 1);
		assert.equal(harness.notifications.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

for (const oauth of [false, true]) {
	test(`cancellation reaches both requests and leaves no checkpoint or warning (OAuth: ${oauth})`, async () => {
		const controller = new AbortController();
		const aborted = (signal: AbortSignal) =>
			new Promise<never>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
			});
		let summaryStarted!: () => void;
		const summaryReady = new Promise<void>((resolve) => {
			summaryStarted = resolve;
		});
		let remoteStarted!: () => void;
		const remoteReady = new Promise<void>((resolve) => {
			remoteStarted = resolve;
		});
		const harness = createHarness({
			sessionId: "session-cancelled",
			oauth,
			summarize: async (_model, _context, options) => {
				assert.equal(options?.signal, controller.signal);
				summaryStarted();
				return aborted(controller.signal);
			},
		});
		const event = compactionEvent([]);
		event.signal = controller.signal;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_url, init) => {
			assert.equal(init?.signal, controller.signal);
			remoteStarted();
			return aborted(controller.signal);
		};

		try {
			const pending = harness.emit("session_before_compact", event);
			await Promise.all([summaryReady, remoteReady]);
			controller.abort();
			assert.equal(await pending, undefined);
			assert.deepEqual(harness.notifications, []);
			assert.equal(harness.summaryCalls.length, 1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
}

test("direct OAuth compacts with context management and replays its persisted checkpoint", async () => {
	const harness = createHarness({ sessionId: "session-subscription", oauth: true });
	const originalFetch = globalThis.fetch;
	const sent: Record<string, unknown>[] = [];
	globalThis.fetch = async (_url, init) => {
		assert.ok(typeof init?.body === "string");
		sent.push(JSON.parse(init.body) as Record<string, unknown>);
		return new Response(COMPACTION_STREAM);
	};

	try {
		const branch = [{ type: "message", id: "old", message: userMessage("remember old work") }];
		const event = compactionEvent(branch);
		event.customInstructions = "portable summary only";
		const result = (await harness.emit("session_before_compact", event)) as {
			compaction: {
				summary: string;
				details: { remoteCompaction: { replacementHistory: unknown[] } };
			};
		};
		assert.equal(result.compaction.summary, "portable summary");
		const encrypted = { type: "compaction", encrypted_content: "opaque" };
		assert.deepEqual(result.compaction.details.remoteCompaction.replacementHistory, [encrypted]);
		assert.deepEqual(sent[0]?.context_management, [{ type: "compaction", compact_threshold: 1000 }]);
		assert.equal(sent[0]?.instructions, "system prompt", "checkpoint-specific instructions must not enter encryption");
		assert.equal(sent[0]?.tool_choice, "none");
		assert.deepEqual(sent[0]?.input, [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "remember old work" }] },
		]);
		assert.match(JSON.stringify(harness.summaryCalls), /portable summary only/);
		assert.deepEqual(harness.notifications, []);

		const persisted = JSON.parse(
			JSON.stringify([
				...branch,
				{ type: "compaction", id: "checkpoint", ...result.compaction },
				{ type: "message", id: "new", message: userMessage("continued work") },
			]),
		) as BranchEntryLike[];
		const history = [
			encrypted,
			{ type: "message", role: "user", content: [{ type: "input_text", text: "continued work" }] },
		];
		const restored = createHarness({ sessionId: "session-restored", oauth: true, branch: persisted });
		const payload = (await restored.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { input: [], instructions: "system prompt", previous_response_id: "stale", store: false },
		})) as Record<string, unknown>;
		assert.deepEqual(payload.input, history);
		assert.equal(payload.previous_response_id, undefined);
		assert.equal(payload.instructions, "system prompt");
		assert.equal(payload.store, false);
		await restored.emit("session_before_compact", compactionEvent(persisted));
		assert.deepEqual(sent.at(-1)?.input, history, "the next compaction starts from the persisted replacement");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("direct OAuth without a leading compaction keeps Pi's summary and does not persist generated output", async () => {
	const harness = createHarness({ sessionId: "session-subscription-small", oauth: true });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			[
				`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "unsaved generated answer" }] } })}\n\n`,
				`data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
			].join(""),
		);
	try {
		const result = (await harness.emit("session_before_compact", compactionEvent([]))) as {
			compaction: { summary: string; details: unknown };
		};
		assert.equal(result.compaction.summary, "portable summary");
		assert.deepEqual(result.compaction.details, { readFiles: [], modifiedFiles: [] });
		assert.equal(harness.summaryCalls.length, 1);
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0]!, /no leading compaction item/);
		assert.equal(
			await harness.emit("before_provider_request", { type: "before_provider_request", payload: { input: [] } }),
			undefined,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Codex OAuth still uses the explicit trigger protocol", async () => {
	const claims = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
	).toString("base64url");
	const harness = createHarness({
		sessionId: "session-codex",
		oauth: true,
		apiKey: `header.${claims}.signature`,
		model: model({
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		}),
	});
	const originalFetch = globalThis.fetch;
	const sent: Record<string, unknown>[] = [];
	try {
		globalThis.fetch = async (url, init) => {
			assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
			assert.ok(typeof init?.body === "string");
			sent.push(JSON.parse(init.body) as Record<string, unknown>);
			return new Response(COMPACTION_STREAM);
		};
		const result = (await harness.emit("session_before_compact", compactionEvent([]))) as {
			compaction: { summary: string };
		};
		assert.equal(result.compaction.summary, "portable summary");
		assert.deepEqual(sent[0]?.input, [{ type: "compaction_trigger" }]);
		assert.equal(sent[0]?.context_management, undefined);
		assert.equal(sent[0]?.tool_choice, undefined);
		assert.deepEqual(harness.notifications, []);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a request after a compaction replays the stored history and nothing else changes", async () => {
	const harness = createHarness({
		sessionId: "session-replay",
		branch: [
			compactionEntry("compaction-1"),
			{ type: "message", id: "m1", message: userMessage("after compaction") },
			{ type: "message", id: "m2", message: assistantMessage("same model") },
		],
	});
	const payload = (await harness.emit("before_provider_request", {
		type: "before_provider_request",
		payload: {
			model: "gpt-6.1-sol",
			instructions: "system prompt",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "compaction summary" }] },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "after compaction" }] },
			],
			store: false,
			tools: [{ type: "function", name: "read" }],
		},
	})) as Record<string, unknown>;

	assert.deepEqual(payload.input, [
		{ type: "compaction", encrypted_content: "opaque" },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "after compaction" }] },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "same model" }] },
	]);
	assert.equal(payload.instructions, "system prompt");
	assert.equal(payload.store, false, "the rest of the request is Pi's");
});

test("persisted compaction replays after restart, fork and navigation, including the next compaction", async () => {
	const initial = createHarness({ sessionId: "session-original" });
	const branch = [{ type: "message", id: "old", message: userMessage("original request") }];
	const originalFetch = globalThis.fetch;
	const sent: { input: unknown[] }[] = [];
	globalThis.fetch = async (_url, init) => {
		assert.ok(typeof init?.body === "string");
		sent.push(JSON.parse(init.body) as { input: unknown[] });
		return new Response(COMPACTION_STREAM);
	};

	try {
		const result = (await initial.emit("session_before_compact", compactionEvent(branch))) as {
			compaction: Record<string, unknown>;
		};
		const persisted = JSON.parse(
			JSON.stringify([
				...branch,
				{ type: "compaction", id: "checkpoint", ...result.compaction },
				{ type: "message", id: "new", message: userMessage("continued work") },
			]),
		) as BranchEntryLike[];
		const expectedHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "original request" }] },
			{ type: "compaction", encrypted_content: "opaque" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "continued work" }] },
		];
		const event = { type: "before_provider_request", payload: { model: "gpt-6.1-sol", input: [] } };
		for (const sessionId of ["session-original", "session-fork"]) {
			const restored = createHarness({ sessionId, branch: persisted });
			assert.deepEqual(
				((await restored.emit("before_provider_request", event)) as { input: unknown[] }).input,
				expectedHistory,
			);
			restored.setBranch(branch);
			assert.equal(await restored.emit("before_provider_request", event), undefined);
			restored.setBranch(persisted);
			assert.deepEqual(
				((await restored.emit("before_provider_request", event)) as { input: unknown[] }).input,
				expectedHistory,
			);
			await restored.emit("session_before_compact", compactionEvent(persisted));
			assert.deepEqual(sent.at(-1)?.input, [...expectedHistory, { type: "compaction_trigger" }]);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a session with no remote state, or another model, keeps Pi's request untouched", async () => {
	const harness = createHarness({ sessionId: "session-plain" });
	const payload = { model: "gpt-6.1-sol", input: [{ type: "message" }] };
	assert.equal(await harness.emit("before_provider_request", { type: "before_provider_request", payload }), undefined);

	const other = createHarness({ sessionId: "session-other", model: model({ id: "gpt-6-astra" }) });
	other.setBranch([compactionEntry("compaction-1")]);
	assert.equal(
		await other.emit("before_provider_request", { type: "before_provider_request", payload }),
		undefined,
		"stored state belongs to the model that produced it",
	);
});

test("a request Pi did not build as a Responses call is never patched", async () => {
	const harness = createHarness({
		sessionId: "session-classifier",
		branch: [compactionEntry("compaction-1")],
	});
	assert.equal(
		await harness.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "gpt-6.1-sol", messages: [{ role: "user", content: "title this" }] },
		}),
		undefined,
	);
});

for (const oauth of [false, true]) {
	test(`a failed compaction keeps Pi's summary and reports why (OAuth: ${oauth})`, async () => {
		const harness = createHarness({ sessionId: "session-failure", oauth });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response("upstream is unwell", { status: 500 });

		try {
			const result = (await harness.emit("session_before_compact", compactionEvent([]))) as {
				compaction: Record<string, unknown>;
			};
			assert.equal(result.compaction.summary, "portable summary", "the session still gets a summary");
			assert.deepEqual(
				result.compaction.details,
				{ readFiles: [], modifiedFiles: [] },
				"only Pi's file tracking remains",
			);
			assert.equal(harness.notifications.length, 1);
			assert.match(harness.notifications[0] ?? "", /OpenAI remote compaction failed.*500.*upstream is unwell/s);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
}

test("the config file switches the extension off for a session", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "openai-server-compaction-disabled-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "openai-server-compaction.json"), JSON.stringify({ enabled: false }));

	const harness = createHarness({ sessionId: "session-disabled", cwd, branch: [compactionEntry("compaction-1")] });
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return new Response("", { status: 200 });
	};

	try {
		assert.equal(await harness.emit("session_before_compact", compactionEvent([])), undefined);
		assert.equal(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-6.1-sol", input: [] },
			}),
			undefined,
		);
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(cwd, { recursive: true, force: true });
	}
});
