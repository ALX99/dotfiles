import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ApplicationEffects } from "../../application.ts";
import type { EditorComposition } from "../../integration/editor.ts";
import type { ToolSelection } from "../../integration/tool-selection.ts";
import interruptOnEmptyEnter from "../../automation/interrupt-on-empty-enter.ts";
import modelShortcuts from "../../automation/model-shortcuts.ts";
import retry from "../../automation/retry.ts";
import retryEmptyResponse from "../../automation/retry-empty-response.ts";
import schedule from "../../automation/schedule.ts";
import tasks from "../../tasks/register.ts";
import type { TaskEventHandlers } from "../../tasks/register.ts";

/** The Pi-facing composition for work that shares settlement and initiation policy. */
export function installWorkAdapter(
	pi: ExtensionAPI,
	dependencies: {
		readonly applicationEffects: ApplicationEffects;
		readonly editor: EditorComposition;
		readonly toolSelection: ToolSelection;
	},
) {
	const taskWork = tasks(pi, dependencies.toolSelection, dependencies.applicationEffects);
	const rescuedInputWork = interruptOnEmptyEnter(pi, dependencies.editor);
	const scheduleWork = schedule(pi, dependencies.applicationEffects);
	bindTaskEvents(pi, taskWork.events);

	modelShortcuts(pi);
	retry(pi);
	retryEmptyResponse(pi);

	return { taskWork, rescuedInputWork, scheduleWork };
}

/** The Work adapter owns the Pi event boundary for task state. */
export function bindTaskEvents(pi: ExtensionAPI, events: TaskEventHandlers): void {
	pi.on("tool_call", events.toolCall);
	pi.on("tool_result", events.toolResult);
	pi.on("input", events.input);
	pi.on("session_before_tree", events.sessionBeforeTree);
	pi.on("session_compact", events.sessionCompact);
	pi.on("session_start", events.sessionStart);
	pi.on("agent_start", events.agentStart);
	pi.on("session_tree", events.sessionTree);
	pi.on("agent_settled", events.agentSettled);
	pi.on("session_shutdown", events.sessionShutdown);
}
