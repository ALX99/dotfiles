import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import tasksExtension from "../index.ts";

interface RegisteredTool {
	parameters?: { properties?: Record<string, { minItems?: number }> };
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown>; terminate?: boolean }>;
}

interface RegisteredCommand {
	handler(args: string, ctx: unknown): Promise<void>;
}

type Entry = Record<string, unknown>;

function createHarness(initialBranch: Entry[] = [], mode?: string) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const sentUserMessages: Array<{ content: string; options: unknown }> = [];
	const sentMessages: Array<{
		message: { customType: string; details?: Record<string, unknown> };
		options: unknown;
	}> = [];
	const notifications: string[] = [];
	const statusWrites: Array<{ key: string; text: string | undefined }> = [];
	const statuses = new Map<string, string>();
	let activeTools = ["read", "bash", "create_tasks", "finish_task", "read_tasks", "update_tasks"];
	const activeToolsLog: string[][] = [];
	let branch = initialBranch;

	const pi = {
		registerTool(tool: RegisteredTool & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: never, ctx: never) => unknown) {
			handlers.set(name, handler);
		},
		sendUserMessage(content: string, options: unknown) {
			sentUserMessages.push({ content, options });
		},
		sendMessage(message: { customType: string; details?: Record<string, unknown> }, options: unknown) {
			sentMessages.push({ message, options });
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
			activeToolsLog.push([...names]);
		},
	} as unknown as ExtensionAPI;
	tasksExtension(pi);

	return {
		tools,
		commands,
		handlers,
		sentUserMessages,
		sentMessages,
		notifications,
		statusWrites,
		activeToolsLog,
		ctx: {
			sessionManager: { getBranch: () => branch },
			mode,
			cwd: "/workspace/project",
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus(key: string, text: string | undefined) {
					statusWrites.push({ key, text });
					if (text === undefined) statuses.delete(key);
					else statuses.set(key, text);
				},
			},
		},
		statuses,
		setBranch(next: Entry[]) {
			branch = next;
		},
		pushEntry(entry: Entry) {
			branch.push(entry);
		},
	};
}

const QUEUE_TITLES = ["Add schema", "Implement handler", "Write tests", "Review integration"];

function assistantToolCall(id: string, name: string): Entry {
	return {
		id: `${id}-assistant`,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: {} }],
		},
	};
}

function assistantToolCallWithArgs(id: string, name: string, arguments_: Record<string, unknown>): Entry {
	return {
		id: `${id}-assistant`,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: arguments_ }],
		},
	};
}

function toolResult(id: string, toolName: string, details: Record<string, unknown>): Entry {
	return {
		id,
		type: "message",
		message: { role: "toolResult", toolName, isError: false, details },
	};
}

function mutationToolResult(id: string, toolCallId: string, toolName: string, isError = false): Entry {
	return {
		id,
		type: "message",
		message: { role: "toolResult", toolCallId, toolName, isError, details: undefined },
	};
}

function toggleEntry(id: string, enabled: boolean): Entry {
	return {
		id,
		type: "custom_message",
		customType: "tasks:toggle",
		content: enabled ? "/tasks on" : "/tasks off",
		display: false,
		details: { enabled },
	};
}

function updateEntry(id: string, details: Record<string, unknown>): Entry {
	return {
		id,
		type: "custom_message",
		customType: "tasks:update",
		content: "task update",
		display: false,
		details,
	};
}

function userMessage(text: string): Entry {
	return {
		id: `user-${text}`,
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

type QueueDetails = Record<string, unknown> & {
	tasks: Array<{ id: string; title: string; state?: string }>;
};

function queueDetails(toolCallId: string): QueueDetails {
	return {
		kind: "tasks:queue",
		queueId: toolCallId,
		tasks: QUEUE_TITLES.map((title, index) => ({ id: `${toolCallId}:${index + 1}`, title })),
	};
}

function finishDetails(taskId: string): Record<string, unknown> {
	return {
		kind: "tasks:finish",
		taskId,
		status: "completed",
		summary: `${taskId} done.`,
		evidence: [{ kind: "test", description: "Verified.", command: "pnpm test", result: "ok" }],
		decisions: [],
		remaining: [],
		compact: true,
	};
}

test("does not restore queues with fewer than four tasks", async () => {
	const details = queueDetails("queue-call");
	details.tasks = details.tasks.slice(0, 3);
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", details),
	]);

	const read = await h.tools.get("read_tasks")!.execute("read-call", {}, undefined, undefined, h.ctx);
	assert.equal(read.content[0]?.text, "No task queue is active.");
});

test("reads the active queue and recorded outcomes", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		toolResult("finish-1-result", "finish_task", finishDetails("queue-call:1")),
	]);

	const read = await h.tools.get("read_tasks")!.execute("read-call", {}, undefined, undefined, h.ctx);
	assert.equal((read.details as { kind: string }).kind, "tasks:read");
	assert.match(read.content[0]?.text ?? "", /1 completed, 3 pending/u);
	assert.match(read.content[0]?.text ?? "", /\[completed\] Add schema/u);
	assert.match(read.content[0]?.text ?? "", /Summary: queue-call:1 done\./u);
	assert.match(read.content[0]?.text ?? "", /Current task: queue-call:2/u);

	const filtered = await h.tools
		.get("read_tasks")!
		.execute("read-filtered", { taskId: "queue-call:1" }, undefined, undefined, h.ctx);
	assert.match(filtered.content[0]?.text ?? "", /Add schema/u);
	assert.doesNotMatch(filtered.content[0]?.text ?? "", /Implement handler/u);
});

test("keeps legacy checkpoints readable without optional fields", async () => {
	const legacy = finishDetails("queue-call:1");
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		completionEntry("summary-1", legacy, "Add schema"),
	]);

	const read = await h.tools.get("read_tasks")!.execute("read-legacy", {}, undefined, undefined, h.ctx);
	const details = read.details as {
		tasks: Array<{ id: string; status: string; changedFiles?: string[] }>;
		currentTaskId?: string;
	};
	assert.deepEqual(details.tasks[0], {
		id: "queue-call:1",
		title: "Add schema",
		status: "completed",
		summary: "queue-call:1 done.",
		evidence: [evidenceEntry()],
		decisions: [],
		remaining: [],
		changedFiles: [],
	});
	assert.equal(details.currentTaskId, "queue-call:2");
});

test("filters task history by observed file path", async () => {
	const first = {
		...finishDetails("queue-call:1"),
		changedFiles: ["src/shared.ts", "src/schema.ts"],
	};
	const second = {
		...finishDetails("queue-call:2"),
		changedFiles: ["src/handler.ts"],
	};
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		completionEntry("summary-1", first, "Add schema"),
		completionEntry("summary-2", second, "Implement handler"),
	]);

	const read = await h.tools
		.get("read_tasks")!
		.execute("read-by-path", { path: "shared.ts" }, undefined, undefined, h.ctx);
	const details = read.details as { tasks: Array<{ id: string; changedFiles?: string[] }> };
	assert.deepEqual(
		details.tasks.map((task) => task.id),
		["queue-call:1"],
	);
	assert.deepEqual(details.tasks[0]?.changedFiles, ["src/shared.ts", "src/schema.ts"]);
	assert.match(read.content[0]?.text ?? "", /src\/shared\.ts/u);
	assert.doesNotMatch(read.content[0]?.text ?? "", /src\/handler\.ts/u);
});

test("does not leak a completed queue into a later queue", async () => {
	const h = createHarness([
		assistantToolCall("old-queue", "create_tasks"),
		toolResult("old-queue-result", "create_tasks", queueDetails("old-queue")),
		completionEntry("old-summary-1", finishDetails("old-queue:1"), "Add schema"),
		completionEntry("old-summary-2", finishDetails("old-queue:2"), "Implement handler"),
		completionEntry("old-summary-3", finishDetails("old-queue:3"), "Write tests"),
		completionEntry("old-summary-4", finishDetails("old-queue:4"), "Review integration"),
		assistantToolCall("new-queue", "create_tasks"),
		toolResult("new-queue-result", "create_tasks", queueDetails("new-queue")),
	]);

	const read = await h.tools.get("read_tasks")!.execute("read-new-queue", {}, undefined, undefined, h.ctx);
	const details = read.details as { queueId?: string; tasks: Array<{ id: string }> };
	assert.equal(details.queueId, "new-queue");
	assert.deepEqual(
		details.tasks.map((task) => task.id),
		["new-queue:1", "new-queue:2", "new-queue:3", "new-queue:4"],
	);
});

test("records successful mutation-tool paths for the current task only", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		assistantToolCallWithArgs("failed-edit", "edit", { path: "src/failed.ts" }),
		mutationToolResult("failed-edit-result", "failed-edit", "edit", true),
		assistantToolCallWithArgs("write", "write", { path: "/workspace/project/src/new.ts" }),
		mutationToolResult("write-result", "write", "write"),
		assistantToolCallWithArgs("patch", "apply_patch", {
			patch: [
				"*** Begin Patch",
				"*** Update File: src/handler.ts",
				"*** Move to: src/renamed-handler.ts",
				"@@",
				"-old",
				"+new",
				"*** Add File: src/added.ts",
				"+content",
				"*** End Patch",
			].join("\n"),
		}),
		mutationToolResult("patch-result", "patch", "apply_patch"),
		assistantToolCall("finish-1", "finish_task"),
	]);

	const finish = await h.tools
		.get("finish_task")!
		.execute(
			"finish-1",
			{ status: "completed", summary: "Files changed.", evidence: [evidenceEntry()], compact: false },
			undefined,
			undefined,
			h.ctx,
		);

	assert.deepEqual((finish.details as { changedFiles: string[] }).changedFiles, [
		"src/new.ts",
		"src/handler.ts",
		"src/renamed-handler.ts",
		"src/added.ts",
	]);

	// A later task starts after the first task's result and does not inherit its
	// observed paths.
	h.pushEntry(toolResult("finish-1-result", "finish_task", finish.details));
	h.pushEntry(completionEntry("summary-1", finish.details, "Add schema"));
	h.pushEntry(assistantToolCallWithArgs("second-write", "write", { path: "src/second.ts" }));
	h.pushEntry(mutationToolResult("second-write-result", "second-write", "write"));
	h.pushEntry(assistantToolCall("finish-2", "finish_task"));
	const second = await h.tools
		.get("finish_task")!
		.execute(
			"finish-2",
			{ status: "completed", summary: "Second task changed one file.", evidence: [evidenceEntry()], compact: false },
			undefined,
			undefined,
			h.ctx,
		);
	assert.deepEqual((second.details as { changedFiles: string[] }).changedFiles, ["src/second.ts"]);
});

test("fails closed when the task checkpoint anchor is unavailable", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		assistantToolCallWithArgs("write", "write", { path: "src/new.ts" }),
		mutationToolResult("write-result", "write", "write"),
		assistantToolCall("finish-1", "finish_task"),
	]);
	const branch = h.ctx.sessionManager.getBranch;
	let calls = 0;
	h.ctx.sessionManager.getBranch = () => {
		calls += 1;
		const entries = branch();
		return calls >= 4 ? entries.filter((entry) => entry.id !== "queue-result") : entries;
	};

	const finish = await h.tools
		.get("finish_task")!
		.execute(
			"finish-1",
			{ status: "completed", summary: "Recorded without attribution.", evidence: [evidenceEntry()], compact: false },
			undefined,
			undefined,
			h.ctx,
		);

	assert.deepEqual((finish.details as { changedFiles: string[] }).changedFiles, []);
});

test("amends pending tasks while preserving finished IDs and carrying the queue through compaction", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		toolResult("finish-1-result", "finish_task", { ...finishDetails("queue-call:1"), compact: false }),
		assistantToolCall("rename-2", "update_tasks"),
	]);

	const renamed = await h.tools
		.get("update_tasks")!
		.execute(
			"rename-2",
			{ action: "rename", taskId: "queue-call:2", title: "Implement handler carefully" },
			undefined,
			undefined,
			h.ctx,
		);
	assert.equal(
		(renamed.details as { tasks: Array<{ id: string; title: string }> }).tasks[1]?.title,
		"Implement handler carefully",
	);
	h.pushEntry(toolResult("rename-2-result", "update_tasks", renamed.details));

	h.pushEntry(assistantToolCall("insert-1", "update_tasks"));
	const inserted = await h.tools.get("update_tasks")!.execute(
		"insert-1",
		{
			action: "insert",
			afterTaskId: "queue-call:2",
			title: "Review handler docs",
		},
		undefined,
		undefined,
		h.ctx,
	);
	const insertedTasks = (inserted.details as { tasks: Array<{ id: string; title: string }> }).tasks;
	assert.deepEqual(
		insertedTasks.map((task) => task.title),
		["Add schema", "Implement handler carefully", "Review handler docs", "Write tests", "Review integration"],
	);
	assert.equal(insertedTasks[0]?.id, "queue-call:1");
	assert.match(insertedTasks[2]?.id ?? "", /^queue-call:insert:insert-1$/u);
	h.pushEntry(toolResult("insert-1-result", "update_tasks", inserted.details));

	h.pushEntry(assistantToolCall("skip-1", "update_tasks"));
	const skipped = await h.tools
		.get("update_tasks")!
		.execute(
			"skip-1",
			{ action: "skip", taskId: "queue-call:3", reason: "Covered by the handler documentation task." },
			undefined,
			undefined,
			h.ctx,
		);
	h.pushEntry(toolResult("skip-1-result", "update_tasks", skipped.details));

	const read = await h.tools.get("read_tasks")!.execute("read-after-update", {}, undefined, undefined, h.ctx);
	assert.match(read.content[0]?.text ?? "", /1 completed, 1 skipped, 3 pending/u);
	assert.match(read.content[0]?.text ?? "", /Review handler docs/u);
	assert.match(read.content[0]?.text ?? "", /Skip reason: Covered by the handler documentation task\./u);
	assert.equal((read.details as { cancelled: boolean; cancelReason?: string }).cancelled, false);
	assert.equal((read.details as { cancelReason?: string }).cancelReason, undefined);

	h.pushEntry(assistantToolCall("finish-2", "finish_task"));
	const finish = await h.tools
		.get("finish_task")!
		.execute(
			"finish-2",
			{ status: "completed", summary: "Handler implemented.", evidence: [evidenceEntry()] },
			undefined,
			undefined,
			h.ctx,
		);
	h.pushEntry(toolResult("finish-2-result", "finish_task", finish.details));
	const prepared = h.handlers.get("session_before_tree")!(
		{ preparation: { targetId: "finish-1-result" } } as never,
		h.ctx as never,
	) as { summary: { details: { queue?: { tasks: Array<{ title: string }> } } } };
	assert.deepEqual(
		prepared.summary.details.queue?.tasks.map((task) => task.title),
		["Add schema", "Implement handler carefully", "Review handler docs", "Write tests", "Review integration"],
	);
});

test("rejects amendments to finished tasks and malformed queue edits", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		toolResult("finish-1-result", "finish_task", { ...finishDetails("queue-call:1"), compact: false }),
	]);

	h.pushEntry(assistantToolCall("rename-finished", "update_tasks"));
	await assert.rejects(
		h.tools
			.get("update_tasks")!
			.execute(
				"rename-finished",
				{ action: "rename", taskId: "queue-call:1", title: "Do not reopen this" },
				undefined,
				undefined,
				h.ctx,
			),
		/already finished/u,
	);

	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		toolResult("finish-1-result", "finish_task", { ...finishDetails("queue-call:1"), compact: false }),
		assistantToolCall("cancel-without-reason", "update_tasks"),
	]);
	await assert.rejects(
		h.tools.get("update_tasks")!.execute("cancel-without-reason", { action: "cancel" }, undefined, undefined, h.ctx),
		/Cancel requires a reason/u,
	);
});

test("ignores persisted amendments that rewrite finished tasks", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		toolResult("finish-1-result", "finish_task", { ...finishDetails("queue-call:1"), compact: false }),
		updateEntry("invalid-update", {
			kind: "tasks:update",
			queueId: "queue-call",
			action: "rename",
			taskId: "queue-call:2",
			title: "Implement handler safely",
			tasks: [
				{ id: "queue-call:1", title: "Rewritten schema" },
				{ id: "queue-call:2", title: "Implement handler safely" },
				{ id: "queue-call:3", title: "Write tests" },
				{ id: "queue-call:4", title: "Review integration" },
			],
			cancelled: false,
		}),
	]);

	const read = await h.tools.get("read_tasks")!.execute("read-invalid-update", {}, undefined, undefined, h.ctx);
	const details = read.details as {
		tasks: Array<{ id: string; title: string }>;
		currentTaskId?: string;
	};
	assert.deepEqual(
		details.tasks.map(({ id, title }) => ({ id, title })),
		[
			{ id: "queue-call:1", title: "Add schema" },
			{ id: "queue-call:2", title: "Implement handler" },
			{ id: "queue-call:3", title: "Write tests" },
			{ id: "queue-call:4", title: "Review integration" },
		],
	);
	assert.equal(details.currentTaskId, "queue-call:2");
});

test("does not accept impossible persisted queue item states", async () => {
	const details = queueDetails("queue-call");
	details.tasks = [
		{ id: "queue-call:1", title: "Add schema", state: "skipped" },
		{ id: "queue-call:2", title: "Implement handler" },
		{ id: "queue-call:3", title: "Write tests" },
		{ id: "queue-call:4", title: "Review integration" },
	];
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", details),
	]);

	const read = await h.tools.get("read_tasks")!.execute("read-call", {}, undefined, undefined, h.ctx);
	assert.equal(read.content[0]?.text, "No task queue is active.");
});

test("keeps full task lookup output bounded", async () => {
	const finish = {
		...finishDetails("queue-call:1"),
		changedFiles: Array.from({ length: 2_000 }, (_, index) => `src/generated/file-${index}.ts`),
	};
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		toolResult("finish-1-result", "finish_task", finish),
	]);

	const read = await h.tools.get("read_tasks")!.execute("read-call", {}, undefined, undefined, h.ctx);
	assert.ok(read.content[0]!.text.length <= 12_000);
	assert.match(read.content[0]!.text, /…/u);
});

test("compacts each queued task onto a chained completion record", async () => {
	const h = createHarness([assistantToolCall("queue-call", "create_tasks")]);

	const created = await h.tools
		.get("create_tasks")!
		.execute("queue-call", { tasks: QUEUE_TITLES.map((title) => ({ title })) }, undefined, undefined, h.ctx);
	assert.deepEqual(created.details, queueDetails("queue-call"));
	assert.equal(h.statuses.get("tasks"), "Task 1/4 · Add schema");

	// First finish rewinds to the queue anchor.
	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", created.details),
		assistantToolCall("finish-1", "finish_task"),
	]);
	const finish1 = await h.tools
		.get("finish_task")!
		.execute(
			"finish-1",
			{ status: "completed", summary: "Schema added.", evidence: [evidenceEntry()] },
			undefined,
			undefined,
			h.ctx,
		);
	assert.equal(finish1.terminate, true);
	assert.match(finish1.content[0]?.text ?? "", /1\/4.*Next: Implement handler/u);
	assert.equal(h.statuses.get("tasks"), "⟳ Task 1/4 · compacting");
	h.pushEntry(toolResult("finish-1-result", "finish_task", finish1.details));

	h.handlers.get("agent_settled")!({} as never, h.ctx as never);
	assert.deepEqual(h.sentUserMessages, [{ content: "/tasks commit", options: { expandPromptTemplates: true } }]);
	const navigation1 = await commit(h, "queue-result");
	assert.equal(navigation1.label, "task: Add schema");
	assert.match(navigation1.summary, /## Queue progress\n1\/4 complete\. Continue with: Implement handler/u);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(
		h.sentUserMessages.at(-1)?.content ?? "",
		/^Continue with the next queued task: Implement handler \(queue-call:2\)\./u,
	);

	// Second finish chains onto the first completion record instead of the anchor.
	const summary1 = completionEntry("summary-1", finish1.details, "Add schema");
	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", created.details),
		summary1,
		assistantToolCall("finish-2", "finish_task"),
	]);
	const finish2 = await h.tools
		.get("finish_task")!
		.execute(
			"finish-2",
			{ status: "completed", summary: "Handler added.", evidence: [evidenceEntry()] },
			undefined,
			undefined,
			h.ctx,
		);
	h.pushEntry(toolResult("finish-2-result", "finish_task", finish2.details));
	const navigation2 = await commit(h, "summary-1");
	assert.equal(navigation2.label, "task: Implement handler");
	assert.match(navigation2.summary, /2\/4 complete\. Continue with: Write tests/u);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(
		h.sentUserMessages.at(-1)?.content ?? "",
		/^Continue with the next queued task: Write tests \(queue-call:3\)\./u,
	);

	// Intermediate tasks keep the chain and schedule the next task.
	const summary2 = completionEntry("summary-2", finish2.details, "Implement handler");
	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", created.details),
		summary1,
		summary2,
		assistantToolCall("finish-3", "finish_task"),
	]);
	const finish3 = await h.tools
		.get("finish_task")!
		.execute(
			"finish-3",
			{ status: "completed", summary: "Tests written.", evidence: [evidenceEntry()] },
			undefined,
			undefined,
			h.ctx,
		);
	assert.match(finish3.content[0]?.text ?? "", /3\/4.*Next: Review integration/u);
	h.pushEntry(toolResult("finish-3-result", "finish_task", finish3.details));
	const navigation3 = await commit(h, "summary-2");
	assert.equal(navigation3.label, "task: Write tests");
	assert.match(navigation3.summary, /3\/4 complete\. Continue with: Review integration/u);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(
		h.sentUserMessages.at(-1)?.content ?? "",
		/^Continue with the next queued task: Review integration \(queue-call:4\)\./u,
	);

	// The final task keeps the chain and schedules a user-facing final summary.
	const summary3 = completionEntry("summary-3", finish3.details, "Write tests");
	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", created.details),
		summary1,
		summary2,
		summary3,
		assistantToolCall("finish-4", "finish_task"),
	]);
	const finish4 = await h.tools
		.get("finish_task")!
		.execute(
			"finish-4",
			{ status: "completed", summary: "Integration reviewed.", evidence: [evidenceEntry()] },
			undefined,
			undefined,
			h.ctx,
		);
	assert.match(finish4.content[0]?.text ?? "", /4\/4.*Queue complete/u);
	h.pushEntry(toolResult("finish-4-result", "finish_task", finish4.details));
	const navigation4 = await commit(h, "summary-3");
	assert.equal(navigation4.label, "task: Review integration");
	assert.match(navigation4.summary, /4\/4 complete\. The queue is finished/u);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(
		h.sentUserMessages.at(-1)?.content,
		"All queued tasks are complete. Summarize the overall outcome for the user.",
	);

	// Status reflects the derived progress.
	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", created.details),
		summary1,
		summary2,
		summary3,
		completionEntry("summary-4", finish4.details, "Review integration"),
	]);
	h.handlers.get("session_tree")!({} as never, h.ctx as never);
	assert.equal(h.statuses.get("tasks"), "✓ Tasks 4/4 complete");
	await h.commands.get("tasks")!.handler("status", h.ctx as never);
	assert.equal(h.notifications.at(-1), "Task queue complete (4/4).");

	// A completed queue does not block a later queue.
	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", created.details),
		summary1,
		summary2,
		summary3,
		completionEntry("summary-4", finish4.details, "Review integration"),
		assistantToolCall("new-queue-call", "create_tasks"),
	]);
	const nextQueue = await h.tools
		.get("create_tasks")!
		.execute("new-queue-call", { tasks: QUEUE_TITLES.map((title) => ({ title })) }, undefined, undefined, h.ctx);
	assert.equal(nextQueue.details.kind, "tasks:queue");
});

test("starts the spinner when a queue is created during an active agent run", async () => {
	const h = createHarness([assistantToolCall("queue-call", "create_tasks")], "tui");
	h.handlers.get("agent_start")!({} as never, h.ctx as never);

	try {
		const created = await h.tools
			.get("create_tasks")!
			.execute("queue-call", { tasks: QUEUE_TITLES.map((title) => ({ title })) }, undefined, undefined, h.ctx);
		h.pushEntry(toolResult("queue-result", "create_tasks", created.details));
		assert.equal(h.statuses.get("tasks"), "⣾ Task 1/4 · Add schema");

		// agent_start ran before create_tasks, so only turn_end can observe the
		// newly persisted queue and start the interval.
		h.handlers.get("turn_end")!({} as never, h.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.notEqual(h.statuses.get("tasks"), "⣾ Task 1/4 · Add schema");
	} finally {
		h.handlers.get("agent_settled")!({} as never, h.ctx as never);
	}
});

function evidenceEntry(): Record<string, unknown> {
	return { kind: "test", description: "Verified.", command: "pnpm test", result: "ok" };
}

function completionEntry(id: string, details: Record<string, unknown>, title: string): Entry {
	return { id, type: "branch_summary", details: { ...details, kind: "tasks:completion", title } };
}

async function commit(
	h: ReturnType<typeof createHarness>,
	baseId: string,
): Promise<{ label: string; summary: string }> {
	let result!: { label: string; summary: string };
	const commandCtx = {
		...h.ctx,
		navigateTree: async (targetId: string, options: { summarize?: boolean; label?: string }) => {
			assert.equal(options.summarize, true);
			assert.equal(targetId, baseId);
			const prepared = h.handlers.get("session_before_tree")!(
				{ preparation: { targetId } } as never,
				h.ctx as never,
			) as { summary: { summary: string }; label: string };
			result = { label: prepared.label, summary: prepared.summary.summary };
			return { cancelled: false };
		},
	};
	await h.commands.get("tasks")!.handler("commit", commandCtx);
	return result;
}

test("rejects boundary calls that share their turn and enforces queue state", async () => {
	const h = createHarness([
		{
			id: "mixed-turn",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "queue-call", name: "create_tasks", arguments: {} },
					{ type: "toolCall", id: "read-call", name: "read", arguments: {} },
				],
			},
		},
	]);
	await assert.rejects(
		h.tools
			.get("create_tasks")!
			.execute("queue-call", { tasks: QUEUE_TITLES.map((title) => ({ title })) }, undefined, undefined, h.ctx),
		/must be the only tool call/u,
	);

	// finish_task without an active queue is rejected.
	await assert.rejects(
		h.tools
			.get("finish_task")!
			.execute(
				"finish-solo",
				{ status: "completed", summary: "Done.", evidence: [evidenceEntry()] },
				undefined,
				undefined,
				{ sessionManager: { getBranch: () => [assistantToolCall("finish-solo", "finish_task")] } },
			),
		/No task queue is active/u,
	);
});

test("does not discard a session compaction made during the current task", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		{ id: "mid-task-compaction", type: "compaction" },
		assistantToolCall("finish-1", "finish_task"),
	]);
	await assert.rejects(
		h.tools
			.get("finish_task")!
			.execute(
				"finish-1",
				{ status: "completed", summary: "Done.", evidence: [evidenceEntry()] },
				undefined,
				undefined,
				h.ctx,
			),
		/session compacted during this task/u,
	);
});

test("does not attribute mutations from a compacted task trace", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		assistantToolCallWithArgs("write", "write", { path: "src/new.ts" }),
		mutationToolResult("write-result", "write", "write"),
		{ id: "mid-task-compaction", type: "compaction" },
		assistantToolCall("finish-1", "finish_task"),
	]);

	const finish = await h.tools
		.get("finish_task")!
		.execute(
			"finish-1",
			{ status: "completed", summary: "Recorded without attribution.", evidence: [evidenceEntry()], compact: false },
			undefined,
			undefined,
			h.ctx,
		);

	assert.deepEqual((finish.details as { changedFiles: string[] }).changedFiles, []);
});

test("records print-mode checkpoints without compaction", async () => {
	const h = createHarness(
		[
			assistantToolCall("queue-call", "create_tasks"),
			toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
			assistantToolCall("finish-1", "finish_task"),
		],
		"print",
	);

	const finish = await h.tools
		.get("finish_task")!
		.execute(
			"finish-1",
			{ status: "completed", summary: "Schema added.", evidence: [evidenceEntry()], compact: true },
			undefined,
			undefined,
			h.ctx,
		);
	assert.equal(finish.details.compact, false);
	assert.equal(finish.terminate, false);
	assert.match(finish.content[0]?.text ?? "", /next invocation resumes with Implement handler/u);

	h.pushEntry(toolResult("finish-1-result", "finish_task", finish.details));
	h.pushEntry(assistantToolCall("finish-2", "finish_task"));
	await assert.rejects(
		h.tools
			.get("finish_task")!
			.execute(
				"finish-2",
				{ status: "completed", summary: "Handler added.", evidence: [evidenceEntry()] },
				undefined,
				undefined,
				h.ctx,
			),
		/one task per invocation/u,
	);
	h.handlers.get("agent_settled")!({} as never, h.ctx as never);
	assert.deepEqual(h.sentUserMessages, []);
	h.handlers.get("session_tree")!({} as never, h.ctx as never);
	assert.equal(h.statuses.get("tasks"), "Task 2/4 · Implement handler");
});

test("advances past failed and blocked checkpoints", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
	]);

	for (const [number, status, nextTitle] of [
		[1, "failed", "Implement handler"],
		[2, "blocked", "Write tests"],
	] as const) {
		const callId = `finish-${number}`;
		h.pushEntry(assistantToolCall(callId, "finish_task"));
		const finish = await h.tools
			.get("finish_task")!
			.execute(
				callId,
				{ status, summary: `${status} outcome.`, evidence: [evidenceEntry()], compact: false },
				undefined,
				undefined,
				h.ctx,
			);
		h.pushEntry(toolResult(`${callId}-result`, "finish_task", finish.details));
		h.handlers.get("session_tree")!({} as never, h.ctx as never);
		assert.equal(h.statuses.get("tasks"), `Task ${number + 1}/4 · ${nextTitle}`);
	}
});

test("does not present unsuccessful terminal outcomes as successful completion", async () => {
	const h = createHarness([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		completionEntry("summary-1", { ...finishDetails("queue-call:1"), status: "failed" }, "Add schema"),
		completionEntry("summary-2", { ...finishDetails("queue-call:2"), status: "blocked" }, "Implement handler"),
		toolResult("finish-3-result", "finish_task", finishDetails("queue-call:3")),
		toolResult("finish-4-result", "finish_task", finishDetails("queue-call:4")),
	]);

	const navigation = await commit(h, "summary-2");
	assert.match(
		navigation.summary,
		/Queue finished with issues: 2 completed, 1 failed, 1 blocked\. Do not report the queue as fully successful\./u,
	);

	h.setBranch([
		assistantToolCall("queue-call", "create_tasks"),
		toolResult("queue-result", "create_tasks", queueDetails("queue-call")),
		completionEntry("summary-1", { ...finishDetails("queue-call:1"), status: "failed" }, "Add schema"),
		completionEntry("summary-2", { ...finishDetails("queue-call:2"), status: "blocked" }, "Implement handler"),
		completionEntry("summary-3", finishDetails("queue-call:3"), "Write tests"),
		completionEntry("summary-4", finishDetails("queue-call:4"), "Review integration"),
	]);
	h.handlers.get("session_tree")!({} as never, h.ctx as never);
	assert.equal(h.statuses.get("tasks"), "! Tasks finished with issues · 2 completed, 1 failed, 1 blocked");
	await h.commands.get("tasks")!.handler("status", h.ctx as never);
	assert.equal(h.notifications.at(-1), "Task queue finished with issues (2 completed, 1 failed, 1 blocked).");

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(
		h.sentUserMessages.at(-1)?.content ?? "",
		/The task queue finished with 2 completed, 1 failed, 1 blocked/u,
	);
	assert.match(h.sentUserMessages.at(-1)?.content ?? "", /Do not claim full success/u);
});

test("hides task tools at session start only before the first message", async () => {
	const h = createHarness();

	// Disabled with an empty conversation: hard-hide before any cache exists.
	h.setBranch([toggleEntry("toggle-off", false)]);
	h.handlers.get("session_start")!({ reason: "startup" } as never, h.ctx as never);
	assert.deepEqual(h.activeToolsLog.at(-1), ["read", "bash"]);

	// Enabled sessions need no visibility write at startup.
	h.setBranch([]);
	h.handlers.get("session_start")!({ reason: "startup" } as never, h.ctx as never);
	assert.equal(h.activeToolsLog.length, 1);

	// Disabled mid-conversation: leave the cached prefix untouched.
	h.setBranch([userMessage("hello"), toggleEntry("toggle-off-2", false)]);
	h.handlers.get("session_start")!({ reason: "resume" } as never, h.ctx as never);
	assert.equal(h.activeToolsLog.length, 1);
});
