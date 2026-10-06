import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CustomEditor, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const nativeEditorInputHandler = Object.getOwnPropertyDescriptor(CustomEditor.prototype, "handleInput")?.value;

const FORMER_REGISTRATIONS = [
	{ handlers: ["session_start"], commands: [], tools: [] },
	{
		handlers: [
			"session_start",
			"session_tree",
			"session_shutdown",
			"tool_execution_start",
			"tool_execution_end",
			"model_select",
		],
		commands: [],
		tools: ["apply_patch"],
	},
	{
		handlers: [
			"session_start",
			"session_shutdown",
			"provider_stream_event",
			"before_provider_request",
			"session_compact",
			"before_agent_start",
			"agent_end",
		],
		commands: ["codex-web-search"],
		tools: ["web_search_log"],
	},
	{ handlers: ["session_before_compact", "before_provider_request"], commands: [], tools: [] },
	{ handlers: [], commands: ["skills"], tools: [] },
	{
		handlers: [
			"tool_call",
			"tool_result",
			"input",
			"session_before_tree",
			"session_compact",
			"session_start",
			"agent_start",
			"session_tree",
			"agent_settled",
			"session_shutdown",
		],
		commands: ["tasks"],
		tools: ["create_tasks", "finish_task"],
	},
	{
		handlers: [
			"tool_call",
			"tool_result",
			"session_shutdown",
			"session_start",
			"agent_start",
			"agent_end",
			"ui_prompt_start",
			"ui_prompt_end",
			"session_tree",
			"tool_execution_start",
			"tool_execution_end",
			"agent_settled",
			"agent_before_settle",
			"model_select",
			"before_agent_start",
			"session_info_changed",
			"message_end",
			"turn_end",
			"turn_start",
		],
		commands: ["jobs", "cc", "luna", "astra", "sol", "free", "retry", "sch", "systemprompt"],
		tools: [],
	},
] as const;

test("the single extension preserves the former registrations", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "custom-extension-registration-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	const loaded = await discoverAndLoadExtensions([entry], root, join(root, "agent"));

	assert.deepEqual(loaded.errors, []);
	assert.equal(
		Object.getOwnPropertyDescriptor(CustomEditor.prototype, "handleInput")?.value,
		nativeEditorInputHandler,
		"loading the personal extension must not mutate Pi's shared editor prototype",
	);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0]!;
	const expectedEvents = [...new Set(FORMER_REGISTRATIONS.flatMap((registration) => registration.handlers))];
	assert.deepEqual([...extension.handlers.keys()].toSorted(), expectedEvents.toSorted());
	assert.deepEqual(
		[...extension.commands.keys()].toSorted(),
		FORMER_REGISTRATIONS.flatMap((registration) => registration.commands).toSorted(),
	);
	assert.deepEqual(
		[...extension.tools.keys()].toSorted(),
		FORMER_REGISTRATIONS.flatMap((registration) => registration.tools).toSorted(),
	);
});
