import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";

import tasksExtension from "../index.ts";
import type { TaskDashboard } from "../dashboard.ts";
import { nextTaskPrompt } from "../state.ts";
import { MAX_TASK_TITLE_LENGTH } from "../tools.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

interface RegisteredTool {
	description: string;
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
	const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
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
		sendUserMessage(content: unknown, options: unknown) {
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
	outcome: string;
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

/** Fire `agent_settled` and let the extension's scheduled turn flush. */
async function settle(h: ReturnType<typeof createHarness>): Promise<void> {
	h.handlers.get("agent_settled")!({} as never, h.ctx as never);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function reminders(h: ReturnType<typeof createHarness>) {
	return h.sentMessages.filter(({ message }) => message.customType === "tasks:reminder");
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
	assert.equal(Check(create.parameters!, { tasks: ["Investigate and discover follow-ups"] }), true);
	assert.equal(Check(create.parameters!, { tasks: ["T".repeat(MAX_TASK_TITLE_LENGTH)] }), true);
	assert.equal(Check(create.parameters!, { tasks: ["T".repeat(MAX_TASK_TITLE_LENGTH + 1)] }), false);
	assert.equal(Check(create.parameters!, { tasks: [] }), false);
	assert.equal(Check(create.parameters!, { tasks: QUEUE_TITLES.map((title) => ({ title })) }), false);
	assert.equal(Check(finish.parameters!, { status: "completed", outcome: "Verified." }), true);
	assert.equal(Check(finish.parameters!, { status: "completed" }), false);
	assert.equal(Check(finish.parameters!, { status: "skipped", outcome: "Not supported." }), false);
	assert.equal(Check(finish.parameters!, { result: "completed", outcome: "Not supported." }), false);
	const createProperties = (
		create.parameters as {
			properties: { tasks: { items: { description: string; maxLength: number } } };
		}
	).properties;
	assert.equal(createProperties.tasks.items.maxLength, MAX_TASK_TITLE_LENGTH);
	assert.match(createProperties.tasks.items.description, /at most 400 characters/u);
	assert.equal(
		Check(finish.parameters!, {
			status: "completed",
			outcome: "Verified.",
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
			outcome: "Verified.",
			addTasks: [{ title: "T".repeat(MAX_TASK_TITLE_LENGTH) }],
		}),
		true,
	);
	assert.equal(
		Check(finish.parameters!, {
			status: "completed",
			outcome: "Verified.",
			addTasks: [{ title: "T".repeat(MAX_TASK_TITLE_LENGTH + 1) }],
		}),
		false,
	);
	assert.equal(
		Check(finish.parameters!, {
			status: "completed",
			outcome: "Verified.",
			addTasks: ["Not an object"],
		}),
		false,
	);
	const finishProperties = (finish.parameters as { properties: Record<string, unknown> }).properties;
	assert.deepEqual(Object.keys(finishProperties), ["status", "outcome", "addTasks"]);
	const followUpTitle = (
		finishProperties.addTasks as {
			items: { properties: { title: { description: string; maxLength: number } } };
		}
	).items.properties.title;
	assert.equal(followUpTitle.maxLength, MAX_TASK_TITLE_LENGTH);
	assert.match(followUpTitle.description, /at most 400 characters/u);
	assert.match(
		(finishProperties.outcome as { description: string }).description,
		/Result, Verification, and Preserve\/Next headings/u,
	);
});

test("the initial queue delivers the same scope guidance as later task starts", async () => {
	const h = createHarness();
	const result = await createQueueResult(h, ["Plan the parser fix"]);
	assert.ok(result.content.endsWith(nextTaskPrompt(result.details.tasks[0]!)));
	assert.match(result.content, /without implementing those tasks/u);
	assert.match(result.content, /only tool call in its assistant turn/u);
});

test("starts with one discovery task and runs the tasks it discovers", async () => {
	const h = createHarness();
	const created = await createQueueResult(h, ["Investigate the problem and identify the work"]);
	assert.deepEqual(
		created.details.tasks.map((task) => task.id),
		["t1"],
	);

	const discovered = await finishTask(
		h,
		{
			status: "completed",
			outcome: "Identified two concrete fixes.",
			addTasks: [{ title: "Fix the parser" }, { title: "Verify the fix" }],
		},
		"finish-discovery",
	);
	assert.deepEqual(
		discovered.details.addedTasks.map((task) => task.id),
		["t2", "t3"],
	);
	assert.match(discovered.content, /Task t1 completed \(1\/3\)/u);
	assert.ok(discovered.content.endsWith(nextTaskPrompt({ id: "t2", title: "Fix the parser" })));
	h.pushEntry(toolResult("finish-discovery-result", "finish-discovery", "finish_task", discovered.details));
	await commit(h, "queue-call-result");

	const next = await finishTask(h, { status: "completed", outcome: "Parser fixed." }, "finish-fix");
	assert.equal(next.details.taskId, "t2");
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
			outcome: "Schema added and verified.",
			addTasks: [{ title: "Investigate the unrelated parser warning." }],
		},
		"finish-1",
	);
	assert.deepEqual(finish.details.addedTasks, [
		{ id: "t5", title: "Investigate the unrelated parser warning.", after: "current" },
	]);
	assert.match(finish.content, /Continue with t5: Investigate the unrelated parser warning\./u);
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
				outcome: `Finished ${expectedTaskId}.`,
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

test("continues with hidden task-start guidance after each task compacts", async () => {
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
				outcome: `Finished ${taskId}.`,
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
			{
				customType: "tasks:continue",
				content: nextTaskPrompt({ id: "t4", title: "Follow-up A" }),
				display: false,
			},
			{
				customType: "tasks:continue",
				content: nextTaskPrompt({ id: "t5", title: "Follow-up B" }),
				display: false,
			},
			{
				customType: "tasks:continue",
				content: nextTaskPrompt({ id: "t2", title: "Original second task" }),
				display: false,
			},
			{
				customType: "tasks:continue",
				content: nextTaskPrompt({ id: "t3", title: "Original third task" }),
				display: false,
			},
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
				outcome: "Should not be recorded.",
				addTasks: [{ title: "Invalid target", after: "missing" }],
			},
			"invalid-target",
		),
		/Task missing is not a pending task/u,
	);

	const first = await finishTask(h, { status: "completed", outcome: "First task done." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));
	h.pushEntry(branchSummary("summary-1", first.details));

	await assert.rejects(
		finishTask(
			h,
			{
				status: "completed",
				outcome: "Should not be recorded.",
				addTasks: [{ title: "Finished target", after: "t1" }],
			},
			"finished-target",
		),
		/Task t1 is not a pending task/u,
	);

	const next = await finishTask(h, { status: "completed", outcome: "Second task still current." }, "finish-2");
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
			outcome: "Tampered outcome.",
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
				outcome: "Should not be recorded.",
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

	const first = await finishTask(h, { status: "completed", outcome: "Files changed." }, "finish-1");
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
	const second = await finishTask(h, { status: "completed", outcome: "Second task changed one file." }, "finish-2");
	assert.deepEqual(second.details.changedFiles, ["src/second.ts"]);
});

test("chains one outcome through the tool result and branch summary", async () => {
	const h = createHarness();
	const queue = await createQueue(h);
	const first = await finishTask(h, { status: "completed", outcome: "Schema added." }, "finish-1");
	assert.equal(first.details.checkpoint, "rewrite");
	assert.equal(first.terminate, true);
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));

	const committed = await commit(h, "queue-call-result");
	assert.equal(committed.label, "task: Add schema");
	assert.equal(committed.summary, "## Task: t1: Add schema\nStatus: completed\n\n## Outcome\nSchema added.");
	assert.deepEqual(committed.details, first.details);

	const second = await finishTask(h, { status: "completed", outcome: "Handler added." }, "finish-2");
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
	const first = await finishTask(h, { status: "completed", outcome: "Schema added." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));
	h.pushEntry(
		branchSummary("mismatch", {
			...first.details,
			outcome: "Tampered outcome.",
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
			outcome: "Wrong task.",
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
		const finish = await finishTask(h, { status: "completed", outcome: `${title} done.` }, callId);
		h.pushEntry(toolResult(`${callId}-result`, callId, "finish_task", finish.details));
		const committed = await commit(h, checkpoint);
		assert.equal(committed.details.taskId, queue.tasks[index]?.id);
		assert.match(committed.summary, new RegExp(`## Task: t${index + 1}: ${title}`, "u"));
		// The notification reports the instruction verbatim, so it can never drift from the
		// `tasks:continue` the model is about to receive.
		const continuation =
			index + 1 < QUEUE_TITLES.length
				? nextTaskPrompt(queue.tasks[index + 1]!)
				: "All queued tasks are complete. Summarize the overall outcome for the user.";
		assert.equal(h.notifications.at(-1), `Task compacted: ${title}. Model sees: ${continuation}`);
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

test("replays queued user inputs after task compaction and before task continuation", async () => {
	const h = createHarness();
	await createQueue(h);

	const onInput = h.handlers.get("input")!;
	assert.equal(
		onInput(
			{
				text: "This should remain a normal steer.",
				source: "interactive",
				streamingBehavior: "steer",
			} as never,
			h.ctx as never,
		),
		undefined,
	);

	const finishCallId = "finish-race";
	h.pushEntry(assistantToolCall(finishCallId, "finish_task"));
	const image = { type: "image" as const, mimeType: "image/png", data: "cG5n" };
	assert.deepEqual(
		onInput(
			{
				text: "Check the result so far.",
				source: "interactive",
			} as never,
			h.ctx as never,
		),
		{ action: "handled" },
	);

	const finish = await h.tools
		.get("finish_task")!
		.execute(finishCallId, { status: "completed", outcome: "First task is done." }, undefined, undefined, h.ctx);
	h.pushEntry(toolResult(`${finishCallId}-result`, finishCallId, "finish_task", finish.details));
	assert.deepEqual(
		onInput(
			{
				text: "Also inspect this image.",
				images: [image],
				source: "interactive",
			} as never,
			h.ctx as never,
		),
		{ action: "handled" },
	);

	await commit(h, "queue-call-result");
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(h.sentUserMessages, [
		{
			content: "Check the result so far.",
			options: { expandPromptTemplates: true },
		},
	]);
	assert.equal(
		h.sentMessages.some(({ message }) => message.customType === "tasks:continue"),
		false,
	);

	h.handlers.get("agent_settled")!({} as never, h.ctx as never);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(h.sentUserMessages[1], {
		content: [{ type: "text", text: "Also inspect this image." }, image],
		options: { expandPromptTemplates: true },
	});
	assert.equal(
		h.sentMessages.some(({ message }) => message.customType === "tasks:continue"),
		false,
	);

	h.handlers.get("agent_settled")!({} as never, h.ctx as never);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.equal(h.sentMessages.at(-1)?.message.customType, "tasks:continue");
	assert.match(h.sentMessages.at(-1)?.message.content ?? "", /Implement handler/u);
});

test("releases deferred input if finish_task fails before recording an outcome", async () => {
	const h = createHarness();
	await createQueue(h);

	const callId = "failed-finish";
	h.pushEntry(assistantToolCall(callId, "finish_task"));
	assert.deepEqual(
		h.handlers.get("input")!(
			{
				text: "Please handle this after the failed finish call.",
				source: "interactive",
			} as never,
			h.ctx as never,
		),
		{ action: "handled" },
	);
	h.pushEntry({
		...toolResult("failed-finish-result", callId, "finish_task", {}),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "finish_task",
			isError: true,
		},
	});

	h.handlers.get("agent_settled")!({} as never, h.ctx as never);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(h.sentUserMessages, [
		{
			content: "Please handle this after the failed finish call.",
			options: { expandPromptTemplates: true },
		},
	]);
	assert.equal(
		h.sentMessages.some(({ message }) => message.customType === "tasks:continue"),
		false,
	);
});

test("reminds the model once per unfinished task after the agent settles", async () => {
	const h = createHarness();
	const queue = await createQueue(h);

	await settle(h);
	assert.deepEqual(h.sentMessages, [
		{
			message: {
				customType: "tasks:reminder",
				content:
					'If the current task "Add schema" is complete, call finish_task now rather than starting additional work. Otherwise, continue only the work needed for this task.',
				display: false,
				details: { queueId: queue.queueId, taskId: "t1" },
			},
			options: { triggerTurn: true, deliverAs: "followUp" },
		},
	]);

	h.pushEntry({
		id: "reminder-t1",
		type: "custom_message",
		customType: "tasks:reminder",
		content: h.sentMessages[0]!.message.content,
		display: false,
		details: h.sentMessages[0]!.message.details,
	});
	await settle(h);
	assert.equal(h.sentMessages.length, 1);

	const finish = await finishTask(h, { status: "completed", outcome: "Schema added." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", finish.details));
	await commit(h, "queue-call-result");
	await settle(h);

	assert.equal(reminders(h).length, 2);
	assert.equal(
		reminders(h)[1]?.message.content,
		'If the current task "Implement handler" is complete, call finish_task now rather than starting additional work. Otherwise, continue only the work needed for this task.',
	);
	assert.deepEqual(reminders(h)[1]?.message.details, { queueId: queue.queueId, taskId: "t2" });
});

test("does not resume a turn the user interrupted or that failed", async () => {
	for (const stopReason of ["aborted", "error"] as const) {
		const h = createHarness();
		await createQueue(h);
		h.pushEntry({
			id: `${stopReason}-assistant`,
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Working on it." }],
				stopReason,
			},
		});

		await settle(h);
		assert.deepEqual(reminders(h), []);
	}

	const stopped = createHarness();
	await createQueue(stopped);
	stopped.pushEntry({
		id: "stopped-assistant",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
	});
	await settle(stopped);
	assert.equal(reminders(stopped).length, 1);
});

test("does not remind when the queue is closed, canceled, or the mode is headless", async () => {
	const canceled = createHarness();
	await createQueue(canceled, ["Only task"]);
	await canceled.commands.get("tasks")!.handler("cancel Not needed", canceled.ctx as never);
	canceled.pushEntry({
		id: "cancelled",
		type: "custom_message",
		customType: "tasks:cancel",
		details: canceled.sentMessages.at(-1)!.message.details,
	});
	await settle(canceled);
	assert.deepEqual(reminders(canceled), []);

	const headless = createHarness([], "print");
	await createQueue(headless);
	await settle(headless);
	assert.deepEqual(reminders(headless), []);

	const done = createHarness();
	await createQueue(done, ["Only task"]);
	const finish = await finishTask(done, { status: "completed", outcome: "Only task done." }, "finish-1");
	done.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", finish.details));
	await commit(done, "queue-call-result");
	await settle(done);
	assert.deepEqual(reminders(done), []);
});

for (const mode of ["print", "json"]) {
	test(`records ${mode}-mode outcomes inline and allows one task per invocation`, async () => {
		const h = createHarness(
			[
				assistantToolCall("queue-call", "create_tasks"),
				toolResult("queue-call-result", "queue-call", "create_tasks", {
					kind: "tasks:queue",
					queueId: `${mode}-queue`,
					tasks: QUEUE_TITLES.map((title, index) => ({ id: `t${index + 1}`, title })),
				}),
			],
			mode,
		);

		const first = await finishTask(h, { status: "completed", outcome: "Schema added." }, "finish-1");
		assert.equal(first.details.checkpoint, "inline");
		assert.equal(first.terminate, false);
		assert.ok(first.content.endsWith(nextTaskPrompt({ id: "t2", title: "Implement handler" })));
		assert.doesNotMatch(first.content, /print|compaction|invocation/u);
		h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", first.details));

		h.pushEntry(assistantToolCall("finish-2", "finish_task"));
		await assert.rejects(
			h.tools
				.get("finish_task")!
				.execute("finish-2", { status: "completed", outcome: "Handler added." }, undefined, undefined, h.ctx),
			/current task outcome has already been recorded/u,
		);

		h.handlers.get("session_start")!({ reason: "next invocation" } as never, h.ctx as never);
		const second = await finishTask(h, { status: "completed", outcome: "Handler added." }, "finish-2b");
		assert.equal(second.details.taskId, "t2");
		assert.equal(second.details.checkpoint, "inline");
	});
}

test("does not schedule a stale continuation after JSON-mode task compaction", async () => {
	const h = createHarness([], "json");
	await createQueue(h);

	const finish = await finishTask(h, { status: "completed", outcome: "First task done." }, "finish-1");
	h.pushEntry(
		toolResult("finish-1-result", "finish-1", "finish_task", {
			...finish.details,
			checkpoint: "rewrite",
		}),
	);
	await commit(h, "queue-call-result");
	await new Promise<void>((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(h.sentMessages, []);
});

test("derives failed and blocked outcomes without a second task state", async () => {
	const h = createHarness();
	await createQueue(h);
	for (const [index, status] of ["failed", "blocked", "completed", "completed"].entries()) {
		const callId = `finish-${index + 1}`;
		const finish = await finishTask(h, { status, outcome: `${status} outcome.` }, callId);
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
			.execute("finish-after-cancel", { status: "completed", outcome: "Should not run." }, undefined, undefined, {
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

test("records finish_task from a codemode script when it is the only nested tool call", async () => {
	const h = createHarness();
	await createQueue(h);
	const editParentId = "codemode-edit";
	const editToolCallId = `${editParentId}/1`;
	const changedPath = "Sources/Task.swift";
	h.pushEntry(assistantToolCall(editParentId, "codemode"));
	h.handlers.get("tool_call")!(
		{
			type: "tool_call",
			toolName: "write",
			toolCallId: editToolCallId,
			parentToolCallId: editParentId,
			input: { path: changedPath },
		} as never,
		h.ctx as never,
	);
	h.handlers.get("tool_result")!(
		{
			type: "tool_result",
			toolName: "write",
			toolCallId: editToolCallId,
			parentToolCallId: editParentId,
			input: { path: changedPath },
			content: [{ type: "text", text: "File written." }],
			details: undefined,
			isError: false,
		} as never,
		h.ctx as never,
	);
	const editOuterResult = h.handlers.get("tool_result")!(
		{
			type: "tool_result",
			toolName: "codemode",
			toolCallId: editParentId,
			input: {},
			content: [{ type: "text", text: "Script completed." }],
			details: { calls: [{ name: "write", status: "ok" }] },
			isError: false,
		} as never,
		h.ctx as never,
	) as { details: Record<string, unknown> };
	assert.deepEqual(editOuterResult.details.taskChangedFiles, [changedPath]);
	h.pushEntry(toolResult("codemode-edit-result", editParentId, "codemode", editOuterResult.details));

	const parentToolCallId = "codemode-call";
	const nestedToolCallId = `${parentToolCallId}/1`;
	h.pushEntry(assistantToolCall(parentToolCallId, "codemode"));

	assert.equal(
		h.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "finish_task",
				toolCallId: nestedToolCallId,
				parentToolCallId,
				input: { status: "completed", outcome: "Task done." },
			} as never,
			h.ctx as never,
		),
		undefined,
	);
	const nestedResult = await h.tools
		.get("finish_task")!
		.execute(nestedToolCallId, { status: "completed", outcome: "Task done." }, undefined, undefined, h.ctx);
	assert.equal(nestedResult.terminate, undefined);

	const outerResult = h.handlers.get("tool_result")!(
		{
			type: "tool_result",
			toolName: "codemode",
			toolCallId: parentToolCallId,
			input: {},
			content: [{ type: "text", text: "Script completed." }],
			details: { calls: [{ name: "finish_task", status: "ok" }] },
			isError: false,
		} as never,
		h.ctx as never,
	) as { details: Record<string, unknown> };
	const outcome = outerResult.details.taskOutcome as OutcomeDetails;
	assert.equal(outcome.taskId, "t1");
	assert.deepEqual(outcome.changedFiles, [changedPath]);

	h.pushEntry(toolResult("codemode-result", parentToolCallId, "codemode", outerResult.details));
	assert.deepEqual(
		h.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: "after-task-checkpoint",
				input: { path: "README.md" },
			} as never,
			h.ctx as never,
		),
		{
			block: true,
			reason: "A task checkpoint is pending. Stop tool use so the task can be compacted.",
			terminate: true,
		},
	);
	const checkpoint = await commit(h, "queue-call-result");
	assert.equal(checkpoint.details.taskId, "t1");
	assert.match(checkpoint.summary, /Task done\./u);
});

test("records create_tasks from a codemode script when it is the only nested tool call", async () => {
	const h = createHarness([{ id: "user", type: "message", message: { role: "user", content: "Plan this work." } }]);
	const parentToolCallId = "codemode-create";
	const nestedToolCallId = `${parentToolCallId}/1`;
	h.pushEntry(assistantToolCall(parentToolCallId, "codemode"));

	assert.equal(
		h.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "create_tasks",
				toolCallId: nestedToolCallId,
				parentToolCallId,
				input: { tasks: QUEUE_TITLES },
			} as never,
			h.ctx as never,
		),
		undefined,
	);
	await h.tools.get("create_tasks")!.execute(nestedToolCallId, { tasks: QUEUE_TITLES }, undefined, undefined, h.ctx);

	const outerResult = h.handlers.get("tool_result")!(
		{
			type: "tool_result",
			toolName: "codemode",
			toolCallId: parentToolCallId,
			input: {},
			content: [{ type: "text", text: "Script completed." }],
			details: { calls: [{ name: "create_tasks", status: "ok" }] },
			isError: false,
		} as never,
		h.ctx as never,
	) as { details: Record<string, unknown> };
	assert.deepEqual(
		(outerResult.details.taskQueue as QueueDetails).tasks.map((task) => task.id),
		["t1", "t2", "t3", "t4"],
	);
	h.pushEntry(toolResult("codemode-create-result", parentToolCallId, "codemode", outerResult.details));
	h.handlers.get("session_tree")!({} as never, h.ctx as never);

	const finish = await finishTask(
		h,
		{ status: "completed", outcome: "The first task is complete." },
		"finish-after-codemode-create",
	);
	assert.equal(finish.details.taskId, "t1");
});

test("does not commit a codemode task boundary when the script makes another nested call", async () => {
	const h = createHarness();
	await createQueue(h);
	const parentToolCallId = "codemode-call";
	const nestedToolCallId = `${parentToolCallId}/1`;
	h.pushEntry(assistantToolCall(parentToolCallId, "codemode"));

	h.handlers.get("tool_call")!(
		{
			type: "tool_call",
			toolName: "finish_task",
			toolCallId: nestedToolCallId,
			parentToolCallId,
			input: { status: "completed", outcome: "Task done." },
		} as never,
		h.ctx as never,
	);
	await h.tools
		.get("finish_task")!
		.execute(nestedToolCallId, { status: "completed", outcome: "Task done." }, undefined, undefined, h.ctx);

	assert.deepEqual(
		h.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: `${parentToolCallId}/2`,
				parentToolCallId,
				input: { path: "README.md" },
			} as never,
			h.ctx as never,
		),
		{
			block: true,
			reason: "No nested tool calls may follow finish_task in the same codemode script.",
		},
	);

	const outerResult = h.handlers.get("tool_result")!(
		{
			type: "tool_result",
			toolName: "codemode",
			toolCallId: parentToolCallId,
			input: {},
			content: [{ type: "text", text: "Script completed." }],
			details: {
				calls: [
					{ name: "finish_task", status: "ok" },
					{ name: "read", status: "error" },
				],
			},
			isError: false,
		} as never,
		h.ctx as never,
	) as { details?: Record<string, unknown>; isError?: boolean };
	assert.equal(outerResult.details?.taskOutcome, undefined);
	assert.equal(outerResult.isError, true);

	h.pushEntry({
		...toolResult("codemode-result", parentToolCallId, "codemode", outerResult.details ?? {}),
		message: {
			role: "toolResult",
			toolCallId: parentToolCallId,
			toolName: "codemode",
			isError: true,
			details: outerResult.details,
		},
	});
	const retry = await finishTask(h, { status: "completed", outcome: "Direct retry." }, "direct-retry");
	assert.equal(retry.details.taskId, "t1");
});

test("re-anchors on the current task with the shared continuation after automatic compaction", async () => {
	const h = createHarness();
	const queue = await createQueue(h);
	h.pushEntry({ id: "auto-compaction", type: "compaction" });
	h.handlers.get("session_compact")!(
		{ reason: "threshold", compactionEntry: { id: "auto-compaction" } } as never,
		h.ctx as never,
	);

	const recovery = h.sentMessages.at(-1);
	assert.equal(recovery?.message.customType, "tasks:recovery");
	assert.equal(recovery?.message.content, nextTaskPrompt(queue.tasks[0]!));
	assert.match(recovery?.message.content as string, /Focus on the current task/u);
	assert.deepEqual(recovery?.message.details, {
		queueId: queue.queueId,
		taskId: "t1",
		compactionEntryId: "auto-compaction",
	});
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

test("restores both task tools after branch-summary navigation", async () => {
	const h = createHarness();
	h.handlers.get("session_start")!({ reason: "startup" } as never, h.ctx as never);
	await createQueue(h);

	const finish = await finishTask(h, { status: "completed", outcome: "Schema added." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", finish.details));
	h.pushEntry(branchSummary("checkpoint-1", finish.details));

	// Tree navigation restores the checkpoint's tool loadout, which predates the
	// dynamically added finish_task tool.
	h.setActiveTools(["read", "bash", "create_tasks"]);
	h.handlers.get("session_tree")!({} as never, h.ctx as never);

	assert.deepEqual(h.activeToolsLog.at(-1), ["read", "bash", "create_tasks", "finish_task"]);
});

test("updates status while a queue is active", async () => {
	const h = createHarness();
	h.handlers.get("session_start")!({ reason: "startup" } as never, h.ctx as never);
	await createQueue(h);
	assert.equal(h.statuses.get("tasks"), "0/4 complete · Add schema");

	const finish = await finishTask(h, { status: "completed", outcome: "Schema added." }, "finish-1");
	h.pushEntry(toolResult("finish-1-result", "finish-1", "finish_task", finish.details));
	assert.equal(h.statuses.get("tasks"), "⟳ Task 1/4 · compacting");
});

test("dashboard restores completed queues and outcomes without changing execution or model context", async () => {
	const h = createHarness([], "tui");
	await createQueue(h, ["Investigate", "Run tests", "Review"]);
	for (let index = 1; index <= 3; index++) {
		const finish = await finishTask(h, { status: "completed", outcome: `Outcome ${index}` }, `done-${index}`);
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
