import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TaskEventHandlers } from "../../../tasks/register.ts";
import type { NestedContextEvents } from "../../../context/nested-instructions/nested-context.ts";
import type { SearchEventHandlers } from "../../../openai/search/register.ts";
import type { ProcessReaperEvents } from "../../../host/process-reaper.ts";
import type { TitleEvents } from "../../../host/title.ts";
import type { StatusbarAdapter, StatusbarEvents } from "../../../ui/statusbar.ts";
import { bindHostEvents } from "../host.ts";
import { bindNestedContextEvents, bindSearchEvents } from "../model-context.ts";
import { bindStatusbarEvents } from "../presentation.ts";
import { bindTaskEvents } from "../work.ts";

test("domain adapters preserve handler order across shared lifecycle and tool events", async () => {
	const handlers = new Map<string, Array<() => void | Promise<void>>>();
	const pi = {
		on(name: string, handler: () => void | Promise<void>) {
			const eventHandlers = handlers.get(name) ?? [];
			eventHandlers.push(handler);
			handlers.set(name, eventHandlers);
		},
	} as unknown as ExtensionAPI;
	const calls: string[] = [];
	const eventSet = (owner: string, fields: readonly string[]): Record<string, () => void> =>
		Object.fromEntries(fields.map((field) => [field, () => calls.push(`${owner}.${field}`)]));

	bindTaskEvents(
		pi,
		eventSet("work", [
			"toolCall",
			"toolResult",
			"input",
			"sessionBeforeTree",
			"sessionCompact",
			"sessionStart",
			"agentStart",
			"sessionTree",
			"agentSettled",
			"sessionShutdown",
		]) as unknown as TaskEventHandlers,
	);
	bindSearchEvents(
		pi,
		eventSet("search", [
			"sessionStart",
			"sessionShutdown",
			"providerStreamEvent",
			"sessionCompact",
			"beforeAgentStart",
			"agentEnd",
		]) as unknown as SearchEventHandlers,
	);
	bindNestedContextEvents(
		pi,
		eventSet("nested", ["sessionStart", "sessionTree", "toolCall"]) as unknown as NestedContextEvents,
	);
	bindHostEvents(
		pi,
		eventSet("reaper", ["toolCall", "toolResult", "sessionShutdown"]) as unknown as ProcessReaperEvents,
		eventSet("title", ["sessionStart", "sessionInfoChanged", "turnStart", "sessionShutdown"]) as unknown as TitleEvents,
	);
	const statusbarEvents = eventSet("presentation", [
		"sessionStart",
		"modelSelect",
		"turnStart",
		"messageEnd",
		"turnEnd",
		"sessionCompact",
		"sessionTree",
		"sessionShutdown",
	]) as unknown as StatusbarEvents;
	bindStatusbarEvents(pi, { events: statusbarEvents } as StatusbarAdapter);

	for (const event of ["session_start", "tool_call", "session_compact", "session_tree", "session_shutdown"]) {
		for (const handler of handlers.get(event) ?? []) await handler();
	}

	assert.deepEqual(calls, [
		"work.sessionStart",
		"search.sessionStart",
		"nested.sessionStart",
		"title.sessionStart",
		"presentation.sessionStart",
		"work.toolCall",
		"nested.toolCall",
		"reaper.toolCall",
		"work.sessionCompact",
		"search.sessionCompact",
		"presentation.sessionCompact",
		"work.sessionTree",
		"nested.sessionTree",
		"presentation.sessionTree",
		"work.sessionShutdown",
		"search.sessionShutdown",
		"reaper.sessionShutdown",
		"title.sessionShutdown",
	]);
});
