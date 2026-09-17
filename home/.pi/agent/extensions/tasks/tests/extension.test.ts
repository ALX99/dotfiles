import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";

import tasksExtension from "../index.ts";
import type { TaskDashboard } from "../dashboard.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

interface RegisteredTool {
	parameters?: TSchema;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		terminate?: boolean;
	}>;
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
		message: { customType: string; content?: string; details?: Record<string, unknown> };
		options: unknown;
	}> = [];
	const notifications: string[] = [];
	const dashboards: TaskDashboard[] = [];
	const statusWrites: Array<{ key: string; text: string | undefined }> = [];
	const statuses = new Map<string, string>();
	let activeTools = ["read", "bash"];
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
		sendMessage(
			message: { customType: string; content?: string; details?: Record<string, unknown> },
			options: unknown,
		) {
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
		dashboards,
		statusWrites,
		activeToolsLog,
		ctx: {
			sessionManager: { getBranch: () => branch },
			mode,
			cwd: "/workspace/project",
			ui: {
				custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => TaskDashboard) {
					dashboards.push(factory({ terminal: { rows: 35 }, requestRender() {} }, plainTheme, {}, () => {}));
				},
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
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	};
}

const QUEUE_TITLES = ["Add schema", "Implement handler", "Write tests", "Review integration"];

function assistantToolCall(id: string, name: string, arguments_: Record<string, unknown> = {}): Entry {
	return {
		id: `${id}-assistant`,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: arguments_ }],
		},
	};
}

function toolResult(id: string, toolCallId: string, toolName: string, details: Record<string, unknown>): Entry {
	return {
		id,
		type: "message",
		message: { role: "toolResult", toolCallId, toolName, isError: false, details },
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

type QueueDetails = Record<string, unknown> & {
	kind: string;
	queueId: string;
	tasks: Array<{ id: string; title: string }>;
};

type OutcomeDetails = Record<string, unknown> & {
	kind: string;
	taskId: string;
	status: string;
	summary: string;
	addedTasks: Array<{ id: string; title: string; after: string }>;
	changedFiles: string[];
	checkpoint: "rewrite" | "inline";
};

async function createQueue(
	h: ReturnType<typeof createHarness>,
	titles: readonly string[] = QUEUE_TITLES,
	callId = "queue-call",
): Promise<QueueDetails> {
	return (await createQueueResult(h, titles, callId)).details;
}

async function createQueueResult(
	h: ReturnType<typeof createHarness>,
	titles: readonly string[] = QUEUE_TITLES,
	callId = "queue-call",
): Promise<{ details: QueueDetails; content: string }> {
	h.pushEntry(assistantToolCall(callId, "create_tasks"));
	const result = await h.tools
		.get("create_tasks")!
		.execute(callId, { tasks: [...titles] }, undefined, undefined, h.ctx);
	h.pushEntry(toolResult(`${callId}-result`, callId, "create_tasks", result.details));
	return { details: result.details as QueueDetails, content: result.content[0]?.text ?? "" };
}

async function finishTask(
	h: ReturnType<typeof createHarness>,
	params: Record<string, unknown>,
	callId: string,
): Promise<{ content: string; details: OutcomeDetails; terminate?: boolean }> {
	h.pushEntry(assistantToolCall(callId, "finish_task"));
	const result = await h.tools.get("finish_task")!.execute(callId, params, undefined, undefined, h.ctx);
	return {
		content: result.content[0]?.text ?? "",
		details: result.details as OutcomeDetails,
		...(result.terminate === undefined ? {} : { terminate: result.terminate }),
	};
}

function branchSummary(id: string, details: OutcomeDetails): Entry {
	return { id, type: "branch_summary", details };
}

async function commit(
	h: ReturnType<typeof createHarness>,
	baseId: string,
): Promise<{ label: string; summary: string; details: OutcomeDetails }> {
	let result!: { label: string; summary: string; details: OutcomeDetails };
	const commandCtx = {
		...h.ctx,
		navigateTree: async (targetId: string, options: { summarize?: boolean; label?: string }) => {
			assert.equal(options.summarize, true);
			assert.equal(targetId, baseId);
			const prepared = h.handlers.get("session_before_tree")!(
				{ preparation: { targetId } } as never,
				h.ctx as never,
			) as { summary: { summary: string; details: OutcomeDetails }; label: string };
			result = {
				label: prepared.label,
				summary: prepared.summary.summary,
				details: prepared.summary.details,
			};
			h.pushEntry(branchSummary(`summary-${targetId}`, prepared.summary.details));
			return { cancelled: false };
		},
	};
	await h.commands.get("tasks")!.handler("commit", commandCtx);
	return result;
}

test("exposes only the two bookkeeping tools with model-facing schemas", () => {
	const h = createHarness();
	assert.deepEqual([...h.tools.keys()], ["create_tasks", "finish_task"]);

	const create = h.tools.get("create_tasks")!;
	const finish = h.tools.get("finish_task")!;
	assert.equal(Check(create.parameters!, { tasks: QUEUE_TITLES }), true);
	assert.equal(Check(create.parameters!, { tasks: ["One", "Two", "Three"] }), true);
	assert.equal(Check(create.parameters!, { tasks: ["One", "Two"] }), true);
	assert.equal(Check(create.parameters!, { tasks: ["One"] }), false);
	assert.equal(Check(create.parameters!, { tasks: QUEUE_TITLES.map((title) => ({ title })) }), false);
	assert.equal(Check(finish.parameters!, { status: "completed", summary: "Verified." }), true);
	assert.equal(Check(finish.parameters!, { status: "skipped", summary: "Not supported." }), false);
	assert.equal(Check(finish.parameters!, { result: "completed", summary: "Not supported." }), false);
	assert.equal(
		Check(finish.parameters!, {
			status: "completed",
			summary: "Verified.",
			addTasks: [
				{ title: "Current follow-up" },
				{ title: "End follow-up", after: "end" },
				{ title: "Pending follow-up", after: "t3" },
			],
		}),
		true,
	);
	assert.equal(
		Check(finish.parameters!, {
			status: "completed",
			summary: "Verified.",
			addTasks: ["Not an object"],
		}),
		false,
	);
	const finishProperties = (finish.parameters as { properties: Record<string, unknown> }).properties;
	assert.deepEqual(Object.keys(finishProperties), ["status", "summary", "addTasks"]);
	assert.equal("taskId" in finishProperties, false);
	assert.equal("evidence" in finishProperties, false);
	assert.equal("decisions" in finishProperties, false);
	assert.equal("remaining" in finishProperties, false);
	assert.equal("followups" in finishProperties, false);
});

test("generates short stable task IDs for precise queue additions", async () => {
	const h = createHarness();
	const created = await createQueueResult(h);
	const queue = created.details;

	assert.equal(queue.kind, "tasks:queue");
	assert.deepEqual(
		queue.tasks.map((task) => task.id),
		["t1", "t2", "t3", "t4"],
	);
	assert.deepEqual(
		queue.tasks.map((task) => task.title),
		QUEUE_TITLES,
	);
	assert.match(created.content, /t1: Add schema/u);
});

test("generates task IDs for additions and defaults them after the current task", async () => {
	const h = createHarness();
	const created = await createQueueResult(h);
	const queue = created.details;
	const createCall = h.ctx.sessionManager.getBranch().find((entry) => entry.id === "queue-call-assistant");
	assert.ok(createCall);

	assert.match(created.content, /t1: Add schema/u);

	const finish = await finishTask(
		h,
		{
			status: "completed",
			summary: "Schema added and verified.",
			addTasks: [{ title: "Investigate the unrelated parser warning." }],
		},
		"finish-1",
	);
	assert.deepEqual(finish.details.addedTasks, [
		{ id: "t5", title: "Investigate the unrelated parser warning.", after: "current" },
	]);
	assert.match(finish.content, /Next: t5: Investigate the unrelated parser warning/u);
	assert.equal(queue.tasks[0]?.id, "t1");
});

test("inserts additions after precise positions and preserves same-position order", async () => {
	const h = createHarness();
	await createQueue(h);

	const additions = [
		{ title: "After current 1" },
		{ title: "After current 2" },
		{ title: "After t3 1", after: "t3" },
		{ title: "After t3 2", after: "t3" },
		{ title: "At end", after: "end" },
	];
	const expectedOrder = ["t1", "t5", "t6", "t2", "t3", "t7", "t8", "t4", "t9"];
	let nextCallId = 1;
	for (const [index, expectedTaskId] of expectedOrder.entries()) {
		const callId = `finish-${nextCallId++}`;
		const finish = await finishTask(
			h,
			{
				status: "completed",
				summary: `Finished ${expectedTaskId}.`,
				...(index === 0 ? { addTasks: additions } : {}),
			},
			callId,
		);
		assert.equal(finish.details.taskId, expectedTaskId);
		if (index === 0) {
			assert.deepEqual(finish.details.addedTasks, [
				{ id: "t5", title: "After current 1", after: "current" },
				{ id: "t6", title: "After current 2", after: "current" },
				{ id: "t7", title: "After t3 1", after: "t3" },
				{ id: "t8", title: "After t3 2", after: "t3" },
				{ id: "t9", title: "At end", after: "end" },
			]);
		}
		h.pushEntry(toolResult(`${callId}-result`, callId, "finish_task", finish.details));
		h.pushEntry(branchSummary(`summary-${callId}`, finish.details));
	}
});

test("continues with a hidden title-only instruction after each task compacts", async () => {
	const h = createHarness();
	await createQueue(h, ["Investigate", "Original second task", "Original third task"]);
	let checkpointId = "queue-call-result";
	const expectedOrder = ["t1", "t4", "t5", "t2"];
	for (const [index, taskId] of expectedOrder.entries()) {
		const callId = `finish-${taskId}`;
		const finish = await finishTask(
			h,
			{
				status: "completed",
				summary: `Finished ${taskId}.`,
				...(index === 0 ? { addTasks: [{ title: "Follow-up A" }, { title: "Follow-up B" }] } : {}),
			},
			callId,
		);
		assert.equal(finish.details.taskId, taskId);
		h.pushEntry(toolResult(`${callId}-result`, callId, "finish_task", finish.details));
		await commit(h, checkpointId);
		checkpointId = `summary-${checkpointId}`;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(
		h.sentMessages.map((sent) => sent.message),
		[
			{ customType: "tasks:continue", content: "Continue with the next task: Follow-up A.", display: false },
			{ customType: "tasks:continue", content: "Continue with the next task: Follow-up B.", display: false },
			{ customType: "tasks:continue", content: "Continue with the next task: Original second task.", display: false },
			{ customType: "tasks:continue", content: "Continue with the next task: Original third task.", display: false },
		],
	);
	assert.deepEqual(
		h.sentMessages.map((sent) => sent.options),
		Array.from({ length: 4 }, () => ({ triggerTurn: true, deliverAs: "followUp" })),
	);
	assert.deepEqual(h.sentUserMessages, []);
	assert.equal(h.statuses.get("tasks"), "4/5 complete · Original third task");
});

test("rejects invalid or finished insertion targets without recording an outcome", async () => {
	const h = createHarness();
	await createQueue(h);

	await assert.rejects(
		finishTask(
			h,
			{
				status: "completed",
				summary: "Should not be recorded.",
				addTasks: [{ title: "Invalid target", after: "missing" }],
			},
			"invalid-target",
		),
		/Task missing is not a pending task/u,
	);

	const first = await finishTask(h, { status: "completed", summary: "First task done." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));
	h.pushEntry(branchSummary("summary-1", first.details));

	await assert.rejects(
		finishTask(
			h,
			{
				status: "completed",
				summary: "Should not be recorded.",
				addTasks: [{ title: "Finished target", after: "t1" }],
			},
			"finished-target",
		),
		/Task t1 is not a pending task/u,
	);

	const next = await finishTask(h, { status: "completed", summary: "Second task still current." }, "finish-2");
	assert.equal(next.details.taskId, "t2");
});

test("ignores malformed persisted additions without changing the existing queue", async () => {
	const h = createHarness();
	await createQueue(h);
	h.pushEntry(
		branchSummary("malformed-addition", {
			kind: "tasks:outcome",
			taskId: "t1",
			status: "completed",
			summary: "Tampered outcome.",
			addedTasks: [{ id: "t5", title: "Should not be inserted", after: "missing" }],
			changedFiles: [],
			checkpoint: "inline",
		}),
	);

	await h.commands.get("tasks")!.handler("status", h.ctx as never);
	assert.equal(h.notifications.at(-1), "Task queue: 0/4 complete. Current: Add schema");
});

test("keeps additions atomic when capacity would be exceeded", async () => {
	const h = createHarness();
	await createQueue(h, [...QUEUE_TITLES, ...Array.from({ length: 96 }, (_, index) => `Existing ${index + 5}`)]);

	await assert.rejects(
		finishTask(
			h,
			{
				status: "completed",
				summary: "Should not be recorded.",
				addTasks: [{ title: "One too many" }, { title: "Another too many" }],
			},
			"over-capacity",
		),
		/A task queue can contain at most 100 tasks/u,
	);
});

test("tracks successful mutation paths for the current task only", async () => {
	const h = createHarness();
	await createQueue(h);
	h.pushEntry(assistantToolCall("failed-edit", "edit", { path: "src/failed.ts" }));
	h.pushEntry(mutationToolResult("failed-edit-result", "failed-edit", "edit", true));
	h.pushEntry(assistantToolCall("write", "write", { path: "/workspace/project/src/new.ts" }));
	h.pushEntry(mutationToolResult("write-result", "write", "write"));
	h.pushEntry(
		assistantToolCall("patch", "apply_patch", {
			patch: [
				"*** Begin Patch",
				"*** Update File: src/handler.ts",
				"*** Move to: src/renamed-handler.ts",
				"*** Add File: src/added.ts",
				"*** End Patch",
			].join("\n"),
		}),
	);
	h.pushEntry(mutationToolResult("patch-result", "patch", "apply_patch"));

	const first = await finishTask(h, { status: "completed", summary: "Files changed." }, "finish-1");
	assert.deepEqual(first.details.changedFiles, [
		"src/new.ts",
		"src/handler.ts",
		"src/renamed-handler.ts",
		"src/added.ts",
	]);
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));
	h.pushEntry(branchSummary("summary-1", first.details));

	h.pushEntry(assistantToolCall("second-write", "write", { path: "src/second.ts" }));
	h.pushEntry(mutationToolResult("second-write-result", "second-write", "write"));
	const second = await finishTask(h, { status: "completed", summary: "Second task changed one file." }, "finish-2");
	assert.deepEqual(second.details.changedFiles, ["src/second.ts"]);
});

test("chains one outcome through the tool result and branch summary", async () => {
	const h = createHarness();
	const queue = await createQueue(h);
	const first = await finishTask(h, { status: "completed", summary: "Schema added." }, "finish-1");
	assert.equal(first.details.checkpoint, "rewrite");
	assert.equal(first.terminate, true);
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));

	const committed = await commit(h, "queue-call-result");
	assert.equal(committed.label, "task: Add schema");
	assert.match(committed.summary, /1\/4 complete\. Continue with: t2: Implement handler/u);
	assert.deepEqual(committed.details, first.details);

	const second = await finishTask(h, { status: "completed", summary: "Handler added." }, "finish-2");
	assert.equal(second.details.taskId, queue.tasks[1]?.id);
	assert.equal(h.statuses.get("tasks"), "⟳ Task 2/4 · compacting");
	h.pushEntry(toolResult("finish-2-result", "finish-2", "finish_task", second.details));

	const duplicate = branchSummary("duplicate", first.details);
	h.pushEntry(duplicate);
	h.handlers.get("session_tree")!({} as never, h.ctx as never);
	assert.equal(h.statuses.get("tasks"), "⟳ Task 2/4 · compacting");
});

test("fails closed for mismatched or out-of-order persisted outcomes", async () => {
	const h = createHarness();
	await createQueue(h);
	const first = await finishTask(h, { status: "completed", summary: "Schema added." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));
	h.pushEntry(
		branchSummary("mismatch", {
			...first.details,
			summary: "Tampered summary.",
		}),
	);
	h.handlers.get("session_tree")!({} as never, h.ctx as never);
	assert.equal(h.statuses.get("tasks"), "⟳ Task 1/4 · compacting");

	const h2 = createHarness();
	await createQueue(h2);
	h2.pushEntry(
		branchSummary("out-of-order", {
			kind: "tasks:outcome",
			taskId: "t2",
			status: "completed",
			summary: "Wrong task.",
			addedTasks: [],
			changedFiles: [],
			checkpoint: "rewrite",
		}),
	);
	await h2.commands.get("tasks")!.handler("status", h2.ctx as never);
	assert.equal(h2.notifications.at(-1), "Task queue: 0/4 complete. Current: Add schema");
});

test("compacts each interactive task and retires a successful queue", async () => {
	const h = createHarness();
	const queue = await createQueue(h);

	let checkpoint = "queue-call-result";
	for (const [index, title] of QUEUE_TITLES.entries()) {
		const callId = `finish-${index + 1}`;
		const finish = await finishTask(h, { status: "completed", summary: `${title} done.` }, callId);
		h.pushEntry(toolResult(`${callId}-result`, callId, "finish_task", finish.details));
		const committed = await commit(h, checkpoint);
		assert.equal(committed.details.taskId, queue.tasks[index]?.id);
		assert.match(committed.summary, new RegExp(`${index + 1}/${QUEUE_TITLES.length}`, "u"));
		checkpoint = `summary-${checkpoint}`;
	}

	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(h.sentMessages.at(-1), {
		message: {
			customType: "tasks:continue",
			content: "All queued tasks are complete. Summarize the overall outcome for the user.",
			display: false,
		},
		options: { triggerTurn: true, deliverAs: "followUp" },
	});
	assert.deepEqual(h.sentUserMessages, []);
	assert.equal(h.statuses.get("tasks"), undefined);
	await h.commands.get("tasks")!.handler("status", h.ctx as never);
	assert.equal(h.notifications.at(-1), "No task queue.");

	h.pushEntry(assistantToolCall("new-queue", "create_tasks"));
	const next = await h.tools
		.get("create_tasks")!
		.execute("new-queue", { tasks: QUEUE_TITLES }, undefined, undefined, h.ctx);
	assert.equal(next.details.kind, "tasks:queue");
});

test("records print-mode outcomes inline and allows one task per invocation", async () => {
	const h = createHarness(
		[
			assistantToolCall("queue-call", "create_tasks"),
			toolResult("queue-call-result", "queue-call", "create_tasks", {
				kind: "tasks:queue",
				queueId: "print-queue",
				tasks: QUEUE_TITLES.map((title, index) => ({ id: `t${index + 1}`, title })),
			}),
		],
		"print",
	);

	const first = await finishTask(h, { status: "completed", summary: "Schema added." }, "finish-1");
	assert.equal(first.details.checkpoint, "inline");
	assert.equal(first.terminate, false);
	assert.match(first.content, /Next: t2: Implement handler/u);
	assert.doesNotMatch(first.content, /print|compaction|invocation/u);
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));

	h.pushEntry(assistantToolCall("finish-2", "finish_task"));
	await assert.rejects(
		h.tools
			.get("finish_task")!
			.execute("finish-2", { status: "completed", summary: "Handler added." }, undefined, undefined, h.ctx),
		/current task outcome has already been recorded/u,
	);

	h.handlers.get("session_start")!({ reason: "next invocation" } as never, h.ctx as never);
	const second = await finishTask(h, { status: "completed", summary: "Handler added." }, "finish-2b");
	assert.equal(second.details.taskId, "t2");
	assert.equal(second.details.checkpoint, "inline");
});

test("derives failed and blocked outcomes without a second task state", async () => {
	const h = createHarness();
	await createQueue(h);
	for (const [index, status] of ["failed", "blocked", "completed", "completed"].entries()) {
		const callId = `finish-${index + 1}`;
		const finish = await finishTask(h, { status, summary: `${status} outcome.` }, callId);
		h.pushEntry(toolResult(`${callId}-result`, callId, "finish_task", finish.details));
		h.pushEntry(branchSummary(`summary-${index + 1}`, finish.details));
		h.handlers.get("session_tree")!({} as never, h.ctx as never);
	}
	assert.equal(h.statuses.get("tasks"), "! Tasks finished with issues · 2 completed, 1 failed, 1 blocked");
	await h.commands.get("tasks")!.handler("status", h.ctx as never);
	assert.equal(h.notifications.at(-1), "Task queue finished with issues (2 completed, 1 failed, 1 blocked).");
});

test("keeps cancellation human-only", async () => {
	const h = createHarness();
	await createQueue(h);
	await h.commands.get("tasks")!.handler("cancel No longer needed", h.ctx as never);
	assert.equal(h.sentMessages.at(-1)?.message.customType, "tasks:cancel");
	assert.equal(h.sentMessages.at(-1)?.message.details?.reason, "No longer needed");
	h.pushEntry({
		id: "cancelled",
		type: "custom_message",
		customType: "tasks:cancel",
		details: h.sentMessages.at(-1)?.message.details,
	});
	h.handlers.get("session_tree")!({} as never, h.ctx as never);
	assert.equal(h.statuses.get("tasks"), "! Tasks canceled · 4 cancelled");

	h.pushEntry(assistantToolCall("finish-after-cancel", "finish_task"));
	await assert.rejects(
		h.tools
			.get("finish_task")!
			.execute("finish-after-cancel", { status: "completed", summary: "Should not run." }, undefined, undefined, {
				...h.ctx,
				sessionManager: { getBranch: h.ctx.sessionManager.getBranch },
			}),
		/Every queued task already has a recorded outcome/u,
	);
});

test("requires boundary tools to be isolated in their assistant turn", async () => {
	const h = createHarness([
		{
			id: "mixed-turn",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "queue-call", name: "create_tasks", arguments: {} },
					{ type: "toolCall", id: "read", name: "read", arguments: {} },
				],
			},
		},
	]);
	await assert.rejects(
		h.tools.get("create_tasks")!.execute("queue-call", { tasks: QUEUE_TITLES }, undefined, undefined, h.ctx),
		/must be the only tool call/u,
	);
});

test("injects compact recovery guidance after automatic compaction", async () => {
	const h = createHarness();
	await createQueue(h);
	h.pushEntry({ id: "auto-compaction", type: "compaction" });
	h.handlers.get("session_compact")!(
		{ reason: "threshold", compactionEntry: { id: "auto-compaction" } } as never,
		h.ctx as never,
	);

	const recovery = h.sentMessages.at(-1);
	assert.equal(recovery?.message.customType, "tasks:recovery");
	assert.match(recovery?.message.content ?? "", /Continue with the current task: t1: Add schema\./u);
	assert.match(recovery?.message.content ?? "", /Queue progress: 4 pending\./u);
	assert.match(recovery?.message.content ?? "", /Previous task summaries remain in the conversation history\./u);
	assert.deepEqual(recovery?.options, { deliverAs: "steer" });
});

test("loads only create_tasks initially and both task tools for an active queue", async () => {
	const h = createHarness();
	h.handlers.get("session_start")!({ reason: "startup" } as never, h.ctx as never);
	assert.deepEqual(h.activeToolsLog.at(-1), ["read", "bash", "create_tasks"]);

	await createQueue(h);
	assert.deepEqual(h.activeToolsLog.at(-1), ["read", "bash", "create_tasks", "finish_task"]);

	h.setBranch([toggleEntry("toggle-off", false)]);
	h.handlers.get("session_start")!({ reason: "resume" } as never, h.ctx as never);
	assert.deepEqual(h.activeToolsLog.at(-1), ["read", "bash"]);
});

test("updates status while a queue is active", async () => {
	const h = createHarness();
	h.handlers.get("session_start")!({ reason: "startup" } as never, h.ctx as never);
	await createQueue(h);
	assert.equal(h.statuses.get("tasks"), "0/4 complete · Add schema");

	const finish = await finishTask(h, { status: "completed", summary: "Schema added." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", finish.details));
	assert.equal(h.statuses.get("tasks"), "⟳ Task 1/4 · compacting");
});

test("dashboard restores completed queues and outcomes without changing execution or model context", async () => {
	const h = createHarness([], "tui");
	await createQueue(h, ["Investigate", "Run tests", "Review"]);
	for (let index = 1; index <= 3; index++) {
		const finish = await finishTask(h, { status: "completed", summary: `Outcome ${index}` }, `done-${index}`);
		h.pushEntry(branchSummary(`checkpoint-${index}`, finish.details));
	}
	await h.commands.get("tasks")!.handler("", h.ctx);
	let screen = h.dashboards.at(-1)!.render(100).join("\n");
	assert.match(screen, /3 completed/u);
	assert.match(screen, /Outcome 1/u);
	await createQueue(h, ["New investigation", "New implementation", "New tests"], "new-queue");
	await h.commands.get("tasks")!.handler("", h.ctx);
	const dashboard = h.dashboards.at(-1)!;
	assert.match(dashboard.render(100).join("\n"), /Queue 2\/2/u);
	dashboard.handleInput("\x1b[D");
	screen = dashboard.render(100).join("\n");
	assert.match(screen, /Queue 1\/2/u);
	assert.match(screen, /Outcome 1/u);
	dashboard.handleInput("\x1b[B");
	assert.match(dashboard.render(100).join("\n"), /Outcome 2/u);
	assert.deepEqual(h.sentMessages, []);
	assert.deepEqual(h.sentUserMessages, []);
	await h.commands.get("tasks")!.handler("status", h.ctx);
	assert.equal(h.notifications.at(-1), "Task queue: 0/3 complete. Current: New investigation");
	const restored = createHarness(h.ctx.sessionManager.getBranch(), "tui");
	await restored.commands.get("tasks")!.handler("", restored.ctx);
	assert.match(restored.dashboards[0]!.render(100).join("\n"), /Queue 2\/2/u);
	restored.dashboards[0]!.handleInput("\x1b[D");
	assert.match(restored.dashboards[0]!.render(100).join("\n"), /Outcome 1/u);
	restored.dashboards[0]!.handleInput("\x1b[B");
	assert.match(restored.dashboards[0]!.render(100).join("\n"), /Outcome 2/u);
	restored.setBranch([]);
	assert.match(restored.dashboards[0]!.render(100).join("\n"), /No task queues/u);
});
