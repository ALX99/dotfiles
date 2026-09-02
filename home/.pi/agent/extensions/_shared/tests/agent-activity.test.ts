import assert from "node:assert/strict";
import test from "node:test";

import { registerAgentActivity } from "../agent-activity.ts";

test("agent activity pauses during UI prompts and resumes afterward", () => {
	const handlers = new Map<string, () => void>();
	const changes: boolean[] = [];
	registerAgentActivity(
		{
			on(event: string, handler: () => void) {
				handlers.set(event, handler);
			},
		} as never,
		{ settleEvent: "agent_settled", onActiveChange: (active) => changes.push(active) },
	);

	handlers.get("agent_start")!();
	handlers.get("ui_prompt_start")!();
	handlers.get("ui_prompt_end")!();
	handlers.get("agent_settled")!();

	assert.deepEqual(changes, [true, false, true, false]);
});
