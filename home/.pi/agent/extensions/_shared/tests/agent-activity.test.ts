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

	// Replacing a session while its dialog is open must not suppress later work.
	handlers.get("agent_start")!();
	handlers.get("ui_prompt_start")!();
	handlers.get("session_shutdown")!();
	handlers.get("session_start")!();
	handlers.get("agent_start")!();
	assert.equal(changes.at(-1), true);
	handlers.get("session_shutdown")!();
	assert.equal(changes.at(-1), false);
});
