import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionToolContext,
	type ModelRegistry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { runPromise } from "../../_shared/effect-runtime.ts";
import { withReplayedHistory } from "../../openai-server-compaction/models.ts";
import { registerHarnessLearning } from "../index.ts";
import { evaluateCandidate, loadProbeSuite, PROBE_MAX_TOKENS, PROBE_TIMEOUT_MS } from "../evaluation.ts";
import { evaluationPlan } from "../state.ts";
import { appendStoreEvent, loadStore, openStore } from "../store.ts";
import { proposal, suite } from "./fixtures.ts";

const MODEL: Model<Api> = {
	id: "model",
	name: "Test model",
	provider: "test",
	api: "anthropic-messages",
	baseUrl: "https://unused.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 100_000,
	maxTokens: 10_000,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
type ProbeArguments = Parameters<ModelRegistry["streamSimple"]>;

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: MODEL.provider,
		model: MODEL.id,
		api: MODEL.api,
		timestamp: 0,
		stopReason,
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
		},
	};
}

async function fixture(t: TestContext) {
	const directory = await fs.mkdtemp(join(tmpdir(), "harness-learning-integration-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const repo = join(directory, "repo");
	const cwd = join(repo, "nested");
	const sessions = join(directory, "sessions");
	const privateRoot = join(directory, "private");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sessions);
	const createSession = () => {
		const manager = SessionManager.create(cwd, sessions);
		manager.appendMessage({ role: "user", content: "Task-specific confidential session context.", timestamp: 0 });
		manager.appendMessage(response("The generated output was edited instead of the source."));
		return manager;
	};
	let manager = createSession();
	let model: Model<Api> | undefined = MODEL;
	let idle = true;
	let mode = "tui";
	let allowed = true;
	let gitResult = { stdout: `${repo}\n`, stderr: "", code: 0, killed: false };
	let beforeGit: (() => void) | undefined;
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const calls: ProbeArguments[] = [];
	const audits: { type: string; data: unknown }[] = [];
	const notifications: string[] = [];
	const confirmations: { title: string; message: string }[] = [];
	const gitCalls: { command: string; args: string[] }[] = [];
	let confirmAction: (() => Promise<boolean>) | undefined;
	let answer: (args: ProbeArguments) => AssistantMessage = (args) => {
		const text = JSON.stringify(args[1].messages);
		return response(
			text.includes("handwritten") || !args[1].systemPrompt?.includes("Edit generator inputs") ? "output" : "source",
		);
	};
	let streamOverride: ((args: ProbeArguments) => ReturnType<ModelRegistry["streamSimple"]>) | undefined;
	let nextCall: (() => void) | undefined;
	const ctx = {
		cwd,
		get mode() {
			return mode;
		},
		hasUI: true,
		isIdle: () => idle,
		get model() {
			return model;
		},
		get sessionManager() {
			return manager;
		},
		modelRegistry: {
			streamSimple(...args: ProbeArguments) {
				calls.push(args);
				nextCall?.();
				nextCall = undefined;
				if (streamOverride !== undefined) return streamOverride(args);
				const stream = createAssistantMessageEventStream();
				const message = answer(args);
				if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse")
					stream.push({ type: "done", reason: message.stopReason, message });
				else stream.push({ type: "error", reason: "error", error: message });
				return stream;
			},
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return confirmAction === undefined ? allowed : confirmAction();
			},
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string, spec: { handler: typeof command }) => {
			assert.equal(name, "harness");
			command = spec.handler;
		},
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		exec: (executable: string, args: string[]) => {
			gitCalls.push({ command: executable, args });
			beforeGit?.();
			return Promise.resolve(gitResult);
		},
		appendEntry: (type: string, data: unknown) => audits.push({ type, data }),
	} as unknown as ExtensionAPI;
	registerHarnessLearning(pi, privateRoot);
	const store = await runPromise(openStore(repo, privateRoot));
	const emit = async (name: string, event: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	const run = async (args: string) => {
		assert.ok(command);
		await command(args, ctx);
	};
	const invoke = async (name: string, input: unknown, signal = new AbortController().signal) => {
		const tool = tools.get(name);
		assert.ok(tool);
		const result = await tool.execute("test-call", input, signal, undefined, ctx as unknown as ExtensionToolContext);
		return JSON.parse(
			result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		) as Record<string, unknown>;
	};
	const record = (entryId = manager.getLeafId() ?? "", extra: object = {}) =>
		invoke("harness_evidence", {
			action: "record",
			entryId,
			quote: "The generated output was edited instead of the source.",
			behavior: "editing/generated",
			attribution: "HARNESS_DEFICIENCY",
			...extra,
		});
	const prepare = async () => {
		const first = await record();
		manager = createSession();
		const second = await record();
		const p = proposal();
		const candidate = await invoke("harness_propose", {
			parentVersion: p.parentVersion,
			replaces: p.replaces,
			procedure: p.procedure,
			hypothesis: p.hypothesis,
			evidenceIds: [first.evidenceId, second.evidenceId],
		});
		return String(candidate.candidateId);
	};
	const suitePath = join(directory, "independent suite.json");
	await fs.writeFile(suitePath, JSON.stringify(suite().suite), { mode: 0o640 });
	return {
		tools,
		calls,
		audits,
		notifications,
		confirmations,
		gitCalls,
		ctx,
		store,
		suitePath,
		run,
		emit,
		invoke,
		record,
		prepare,
		load: () => runPromise(loadStore(store)),
		current: () => manager,
		newSession: () => {
			manager = createSession();
		},
		setModel: (next: Model<Api> | undefined) => {
			model = next;
		},
		setIdle: (next: boolean) => {
			idle = next;
		},
		setMode: (next: string) => {
			mode = next;
		},
		setAllowed: (next: boolean) => {
			allowed = next;
		},
		setConfirm: (next: typeof confirmAction) => {
			confirmAction = next;
		},
		setGit: (next: typeof gitResult) => {
			gitResult = next;
		},
		beforeGit: (next: typeof beforeGit) => {
			beforeGit = next;
		},
		setAnswer: (next: typeof answer) => {
			answer = next;
		},
		setStream: (next: typeof streamOverride) => {
			streamOverride = next;
		},
		waitForNextCall: () =>
			new Promise<void>((resolve) => {
				nextCall = resolve;
			}),
		reload: () => {
			handlers.clear();
			tools.clear();
			registerHarnessLearning(pi, privateRoot);
		},
	};
}

test("loading and session events make no model calls; model tools cannot perform gated operations", async (t) => {
	const h = await fixture(t);
	assert.deepEqual([...h.tools.keys()], ["harness_evidence", "harness_propose"]);
	for (const event of ["session_start", "session_tree", "session_shutdown"]) await h.emit(event);
	assert.equal(await h.emit("context", { messages: [] }), undefined);
	assert.equal(h.calls.length, 0);
	assert.equal((await h.load()).state.head.id, "root");
});

test("feedback derives repository/session identity, validates exact branch anchors, and rejects forged metadata", async (t) => {
	const h = await fixture(t);
	const anchors = await h.invoke("harness_evidence", { action: "anchors" });
	assert.ok(JSON.stringify(anchors).includes(h.current().getLeafId() ?? "missing"));
	for (const extra of [
		{ quote: "fabricated" },
		{ entryId: "abandoned-entry" },
		{ sessionId: "forged" },
		{ attribution: "invalid" },
	])
		await assert.rejects(h.record(undefined, extra));
	const first = await h.record();
	const { state } = await h.load();
	assert.equal(state.evidence[0]?.id, first.evidenceId);
	assert.equal(state.evidence[0]?.evidence.sessionId, h.current().getSessionId());
	assert.equal(state.evidence[0]?.evidence.sessionFile, await fs.realpath(h.current().getSessionFile() ?? ""));
	assert.equal(state.scope, h.store.scope);
	assert.deepEqual(h.gitCalls.at(-1), { command: "git", args: ["-C", h.ctx.cwd, "rev-parse", "--show-toplevel"] });
	const oldLeaf = h.current().getLeafId() ?? "";
	h.newSession();
	await assert.rejects(h.record(oldLeaf), /current-branch/);
	assert.equal(h.calls.length, 0);
});

test("anchors exclude hidden thinking, tool arguments and learning-tool results", async (t) => {
	const h = await fixture(t);
	h.current().appendMessage({
		...response("visible"),
		content: [
			{ type: "thinking", thinking: "hidden rationale" },
			{ type: "toolCall", id: "nested", name: "bash", arguments: { command: "argument-only secret" } },
			{ type: "text", text: "visible" },
		],
	});
	await assert.rejects(h.record(undefined, { quote: "hidden rationale" }), /visible text/);
	await assert.rejects(h.record(undefined, { quote: "argument-only secret" }), /visible text/);
	h.current().appendMessage({
		role: "toolResult",
		toolName: "harness_evidence",
		toolCallId: "learning",
		content: [{ type: "text", text: "The generated output was edited instead of the source." }],
		isError: false,
		timestamp: 0,
	});
	await assert.rejects(h.record(), /visible text/);
});

test("proposals require recurrence, derive model metadata, remain inactive and do not expose probe answers", async (t) => {
	const h = await fixture(t);
	const first = await h.record();
	const p = proposal();
	const input = {
		parentVersion: "root",
		replaces: null,
		procedure: p.procedure,
		hypothesis: p.hypothesis,
		evidenceIds: [first.evidenceId, "nonexistent"],
	};
	await assert.rejects(h.invoke("harness_propose", input), /Evidence must exist/);
	h.current().appendMessage(response("The generated output was edited instead of the source."));
	const second = await h.record();
	await assert.rejects(
		h.invoke("harness_propose", { ...input, evidenceIds: [first.evidenceId, second.evidenceId] }),
		/two distinct sessions/,
	);
	h.newSession();
	const third = await h.record();
	await assert.rejects(
		h.invoke("harness_propose", {
			...input,
			evidenceIds: [first.evidenceId, third.evidenceId],
			authorModel: "forged/model",
		}),
	);
	await h.invoke("harness_propose", { ...input, evidenceIds: [first.evidenceId, third.evidenceId] });
	await h.run(`suite ${h.suitePath}`);
	const { state } = await h.load();
	assert.equal(state.proposals[0]?.authorModel, "test/model");
	assert.deepEqual(state.head.candidateIds, []);
	assert.equal(await h.emit("context", { messages: [] }), undefined);
	const listing = JSON.stringify(await h.invoke("harness_evidence", { action: "list" }));
	assert.ok(!listing.includes("expectedChoice"));
	assert.ok(!listing.includes("Source-first decisions"));
	assert.equal(h.calls.length, 0);
});

test("paired evaluation, approval, model scoping and rollback preserve raw session context", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	await h.run(`evaluate ${id}`);
	const evaluated = await h.load();
	assert.equal(evaluated.state.evaluations.length, 1);
	assert.equal(h.calls.length, 24);
	assert.equal(evaluated.state.evaluations[0]?.pairs.length, 12);
	assert.deepEqual(evaluated.state.head.candidateIds, []);
	assert.equal(h.audits.length, 24);
	for (const [model, context, options] of h.calls) {
		assert.equal(model.id, MODEL.id);
		assert.equal(context.messages.length, 1);
		assert.ok(!JSON.stringify(context).includes("Task-specific confidential"));
		assert.ok(!JSON.stringify(context).includes("expectedChoice"));
		assert.equal(context.tools, undefined);
		assert.equal(options?.maxRetries, 0);
		assert.equal(options?.maxTokens, PROBE_MAX_TOKENS);
		assert.equal(options?.timeoutMs, PROBE_TIMEOUT_MS);
	}
	assert.ok(h.confirmations.some((confirmation) => confirmation.message.includes("No hard dollar ceiling")));
	assert.ok(h.notifications.some((notice) => notice.includes("eligible for human approval")));
	h.setModel({ ...MODEL, id: "different" });
	await h.run(`approve ${id} reviewed`);
	assert.equal((await h.load()).state.head.id, "root");
	assert.match(h.notifications.at(-1) ?? "", /currently selected model/);
	h.setModel(MODEL);
	const branchBefore = h.current().getBranch();
	await h.run(`approve ${id} reviewed and accepted`);
	const approved = await h.load();
	assert.deepEqual(approved.state.head.candidateIds, [id]);
	const messages = [{ role: "user", content: "new task", timestamp: 0 }];
	const injected = (await h.emit("context", { messages })) as { messages: { role: string; content: unknown }[] };
	assert.equal(injected.messages.length, 2);
	assert.match(String(injected.messages[1]?.content), /Edit generator inputs/);
	assert.equal(messages.length, 1);
	assert.deepEqual(h.current().getBranch(), branchBefore);
	h.setModel({ ...MODEL, id: "different" });
	assert.equal(await h.emit("context", { messages }), undefined);
	h.setModel(MODEL);
	await h.run("rollback root restore original guidance");
	assert.equal(await h.emit("context", { messages }), undefined);
	assert.deepEqual(h.current().getBranch(), branchBefore);
	const rolledBack = (await h.load()).state;
	assert.deepEqual(rolledBack.head.candidateIds, []);
	assert.equal(rolledBack.versions.length, 3);
	assert.equal(rolledBack.head.restoredFrom, "root");
	assert.equal(rolledBack.evaluations.length, 1);
});

test("TUI-only commands, busy agents and declined confirmations cannot evaluate or change trusted state", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	for (const mode of ["rpc", "print", "json"]) {
		h.setMode(mode);
		await h.run(`suite ${h.suitePath}`);
		await h.run(`evaluate ${id}`);
		await h.run(`approve ${id} not authorized`);
		await h.run("rollback root not authorized");
	}
	assert.equal((await h.load()).state.suites.length, 0);
	h.setMode("tui");
	h.setIdle(false);
	await h.run(`suite ${h.suitePath}`);
	assert.equal((await h.load()).state.suites.length, 0);
	h.setIdle(true);
	h.setAllowed(false);
	await h.run(`suite ${h.suitePath}`);
	assert.equal((await h.load()).state.suites.length, 0);
	h.setAllowed(true);
	await h.run(`suite ${h.suitePath}`);
	h.setAllowed(false);
	await h.run(`evaluate ${id}`);
	await h.run(`reject ${id} declined`);
	assert.equal(h.calls.length, 0);
	assert.equal((await h.load()).state.decisions.length, 0);
});

test("a failed probe gate cannot be approved; reconfiguration invalidates a passing evaluation", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	h.setAnswer(() => response("output"));
	await h.run(`evaluate ${id}`);
	await h.run(`approve ${id} should not pass`);
	assert.match(h.notifications.at(-1) ?? "", /Promotion refused/);
	assert.equal((await h.load()).state.head.id, "root");
	h.setAnswer((args) =>
		response(
			JSON.stringify(args[1]).includes("handwritten")
				? "output"
				: args[1].systemPrompt?.includes("Edit generator inputs")
					? "source"
					: "output",
		),
	);
	await h.run(`evaluate ${id}`);
	await h.run(`suite ${h.suitePath}`);
	await h.run(`approve ${id} outdated suite`);
	assert.match(h.notifications.at(-1) ?? "", /stale probe suite/);
	assert.equal((await h.load()).state.decisions.length, 0);
	await h.run(`reject ${id} superseded by an independently redesigned test suite`);
	assert.equal((await h.load()).state.decisions[0]?.decision, "reject");
});

test("incomplete, tool-using and oversized responses never record a promotable evaluation", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	for (const answer of [
		response("source", "error"),
		response("source", "length"),
		response("source", "toolUse"),
		response("x".repeat(2049)),
	]) {
		h.setAnswer(() => answer);
		await h.run(`evaluate ${id}`);
		assert.equal((await h.load()).state.evaluations.length, 0);
	}
	assert.equal(h.calls.length, 4);
	assert.equal(h.audits.length, 4);
	h.setStream((args) => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(8193), partial: response("") });
		stream.push({ type: "done", reason: "stop", message: response("source") });
		assert.ok(args[2]?.signal);
		return stream;
	});
	await h.run(`evaluate ${id}`);
	assert.match(h.notifications.at(-1) ?? "", /streamed output limit/);
	assert.equal((await h.load()).state.evaluations.length, 0);
	assert.equal(h.calls.length, 5);
});

test("user cancellation and lifecycle changes abort outstanding probes without making further requests", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	let aborted = 0;
	h.setStream((args) => {
		const stream = createAssistantMessageEventStream();
		args[2]?.signal?.addEventListener(
			"abort",
			() => {
				aborted++;
				stream.push({ type: "error", reason: "aborted", error: response("", "aborted") });
			},
			{ once: true },
		);
		return stream;
	});
	for (const event of [
		"cancel",
		"model_select",
		"session_shutdown",
		"before_agent_start",
		"session_start",
		"session_tree",
	]) {
		const next = h.waitForNextCall();
		const running = h.run(`evaluate ${id}`);
		await next;
		await h.run(`evaluate ${id}`);
		assert.match(h.notifications.at(-1) ?? "", /no running harness command/);
		if (event === "cancel") await h.run("cancel");
		else await h.emit(event);
		await running;
		assert.equal((await h.load()).state.evaluations.length, 0);
	}
	assert.equal(h.calls.length, 6);
	assert.equal(aborted, 6);
});

test("model changes during confirmation prevent approval or paid evaluation", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	h.setConfirm(async () => {
		h.setModel({ ...MODEL, id: "changed" });
		return true;
	});
	await h.run(`evaluate ${id}`);
	assert.equal(h.calls.length, 0);
	assert.match(h.notifications.at(-1) ?? "", /Selected model changed/);
});

test("independent suite reads are bounded, strict, reject symlinks and preserve file permissions", async (t) => {
	const h = await fixture(t);
	const before = (await fs.stat(h.suitePath)).mode;
	await runPromise(loadProbeSuite(h.suitePath));
	assert.equal((await fs.stat(h.suitePath)).mode, before);
	const alias = join(h.store.root, "..", "suite-link.json");
	await fs.symlink(h.suitePath, alias);
	await assert.rejects(runPromise(loadProbeSuite(alias)));
	await fs.writeFile(h.suitePath, "x".repeat(64 * 1024 + 1));
	await assert.rejects(runPromise(loadProbeSuite(h.suitePath)), /exceeds/);
	await fs.writeFile(h.suitePath, JSON.stringify({ ...suite().suite, invented: "extra" }));
	await assert.rejects(runPromise(loadProbeSuite(h.suitePath)), /Invalid probe suite/);
	await fs.rm(h.suitePath);
	await assert.rejects(runPromise(loadProbeSuite(h.suitePath)), /not found/);
});

test("scope resolution fails visibly for Git errors rather than learning in a fallback scope", async (t) => {
	const h = await fixture(t);
	h.setGit({ stdout: "", stderr: "fatal: unsafe ownership", code: 128, killed: false });
	await assert.rejects(h.record(), /unsafe ownership/);
	assert.equal((await h.load()).state.evidence.length, 0);
});

test("Responses guidance survives remote-history replay without persisting in its input or leaking into nested calls", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	h.setModel({ ...MODEL, api: "openai-responses" });
	await h.run(`suite ${h.suitePath}`);
	await h.run(`evaluate ${id}`);
	await h.run(`approve ${id} verified decision probes`);
	const payload = {
		input: [{ role: "user", content: "fresh task" }],
		instructions: "Original instructions.",
		model: MODEL.id,
	};
	const injected = (await h.emit("before_provider_request", { payload })) as typeof payload;
	assert.match(injected.instructions, /Original instructions/);
	assert.match(injected.instructions, /Edit generator inputs/);
	assert.equal(payload.instructions, "Original instructions.");
	assert.equal(await h.emit("context", { messages: [] }), undefined);
	const history = [{ type: "compaction", encrypted_content: "opaque" }];
	const replayed = withReplayedHistory(injected, history);
	assert.equal(replayed.instructions, injected.instructions);
	assert.deepEqual(replayed.input, history);
	assert.ok(!JSON.stringify(replayed.input).includes("Edit generator inputs"));
	assert.equal(await h.emit("before_provider_request", { payload: { messages: [], model: MODEL.id } }), undefined);
	h.reload();
	const afterReload = (await h.emit("before_provider_request", { payload })) as typeof payload;
	assert.equal(afterReload.instructions, injected.instructions);
	await h.run("rollback root remove the procedure");
	assert.equal(await h.emit("before_provider_request", { payload }), undefined);
	assert.equal(payload.instructions, "Original instructions.");
	h.reload();
	assert.equal(await h.emit("before_provider_request", { payload }), undefined);
});

test("the complete bounded suite performs at most 72 model calls", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	const original = suite().suite;
	const extra = Array.from({ length: 8 }, (_, index) => ({ ...original.cases[0]!, id: `extra-${index}` }));
	await fs.writeFile(h.suitePath, JSON.stringify({ ...original, cases: [...original.cases, ...extra] }));
	await h.run(`suite ${h.suitePath}`);
	await h.run(`evaluate ${id}`);
	assert.equal(h.calls.length, 72);
	assert.equal((await h.load()).state.evaluations[0]?.pairs.length, 36);
	extra.push({ ...original.cases[0]!, id: "too-many" });
	await fs.writeFile(h.suitePath, JSON.stringify({ ...original, cases: [...original.cases, ...extra] }));
	await h.run(`suite ${h.suitePath}`);
	assert.match(h.notifications.at(-1) ?? "", /Invalid probe suite/);
	assert.equal((await h.load()).state.suites.length, 1);
});

test("a confirmation cannot bypass a concurrent suite revision or a model change", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	await h.run(`evaluate ${id}`);
	h.setConfirm(async () => {
		h.setModel({ ...MODEL, id: "other" });
		return true;
	});
	await h.run(`approve ${id} model changed while reviewing`);
	assert.match(h.notifications.at(-1) ?? "", /Selected model changed/);
	assert.equal((await h.load()).state.decisions.length, 0);
	h.setModel(MODEL);
	h.setConfirm(async () => {
		await runPromise(appendStoreEvent(h.store, suite("concurrent-suite")));
		return true;
	});
	await h.run(`approve ${id} concurrent suite change`);
	assert.match(h.notifications.at(-1) ?? "", /stale probe suite/);
	assert.equal((await h.load()).state.decisions.length, 0);
});

test("a routed response from another model cannot authorize the selected model's procedure", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	h.setAnswer(() => ({ ...response("source"), model: "routed-other-model" }));
	await h.run(`evaluate ${id}`);
	assert.equal(h.calls.length, 1);
	assert.equal(h.audits.length, 1);
	assert.equal((await h.load()).state.evaluations.length, 0);
	assert.match(h.notifications.at(-1) ?? "", /different model/);
});

test("a stalled request is aborted at the probe deadline using the Effect clock", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	await h.run(`suite ${h.suitePath}`);
	const { state } = await h.load();
	const plan = evaluationPlan(state, id);
	assert.ok(Result.isSuccess(plan));
	let aborted = false;
	h.setStream((args) => {
		const stream = createAssistantMessageEventStream();
		args[2]?.signal?.addEventListener(
			"abort",
			() => {
				aborted = true;
				stream.push({ type: "error", reason: "aborted", error: response("", "aborted") });
			},
			{ once: true },
		);
		return stream;
	});
	await runPromise(
		Effect.gen(function* () {
			const work = yield* evaluateCandidate({
				ctx: h.ctx,
				model: MODEL,
				modelId: "test/model",
				state,
				plan: plan.success,
				assertCurrent: () => {},
				onResponse: () => {},
			}).pipe(Effect.result, Effect.forkChild);
			yield* TestClock.adjust("30 seconds");
			const result = yield* Fiber.join(work);
			assert.ok(Result.isFailure(result));
			assert.match(result.failure.message, /timed out/);
			assert.equal(h.calls.length, 1);
			assert.equal(aborted, true);
		}).pipe(Effect.provide(TestClock.layer())),
	);
	assert.equal((await h.load()).state.evaluations.length, 0);
});

test("interrupted tools and session changes cannot misattribute evidence to a different scope or session", async (t) => {
	const h = await fixture(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		h.invoke(
			"harness_evidence",
			{
				action: "record",
				entryId: h.current().getLeafId(),
				quote: "The generated output was edited instead of the source.",
				behavior: "editing/generated",
				attribution: "HARNESS_DEFICIENCY",
			},
			controller.signal,
		),
	);
	assert.equal((await h.load()).state.evidence.length, 0);
	h.beforeGit(() => h.newSession());
	await assert.rejects(h.record(), /Session changed while resolving/);
	assert.equal((await h.load()).state.evidence.length, 0);
});

test("the total evaluation deadline stops a long suite even when individual requests meet their deadlines", async (t) => {
	const h = await fixture(t);
	const id = await h.prepare();
	const original = suite().suite;
	await fs.writeFile(
		h.suitePath,
		JSON.stringify({
			...original,
			cases: [
				...original.cases,
				...Array.from({ length: 8 }, (_, index) => ({ ...original.cases[0]!, id: `long-${index}` })),
			],
		}),
	);
	await h.run(`suite ${h.suitePath}`);
	const { state } = await h.load();
	const plan = evaluationPlan(state, id);
	assert.ok(Result.isSuccess(plan));
	let pending: ReturnType<typeof createAssistantMessageEventStream> | undefined;
	let aborted = false;
	h.setStream((args) => {
		const stream = createAssistantMessageEventStream();
		pending = stream;
		args[2]?.signal?.addEventListener(
			"abort",
			() => {
				aborted = true;
				stream.push({ type: "error", reason: "aborted", error: response("", "aborted") });
			},
			{ once: true },
		);
		return stream;
	});
	await runPromise(
		Effect.gen(function* () {
			const firstCall = h.waitForNextCall();
			const work = yield* evaluateCandidate({
				ctx: h.ctx,
				model: MODEL,
				modelId: "test/model",
				state,
				plan: plan.success,
				assertCurrent: () => {},
				onResponse: () => {},
			}).pipe(Effect.result, Effect.forkChild);
			yield* Effect.tryPromise(() => firstCall);
			// Each successful response takes 20 simulated seconds, below the 30-second request cap.
			for (let step = 0; step < 30; step++) {
				yield* TestClock.adjust("20 seconds");
				if (step < 29) {
					const nextCall = h.waitForNextCall();
					assert.ok(pending);
					pending.push({ type: "done", reason: "stop", message: response("source") });
					yield* Effect.tryPromise(() => nextCall);
				}
			}
			const result = yield* Fiber.join(work);
			assert.ok(Result.isFailure(result));
			assert.match(result.failure.message, /Evaluation failed/);
			assert.equal(h.calls.length, 30);
			assert.equal(aborted, true);
		}).pipe(Effect.provide(TestClock.layer())),
	);
	assert.equal((await h.load()).state.evaluations.length, 0);
});
