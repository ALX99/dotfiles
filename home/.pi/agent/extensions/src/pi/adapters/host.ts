import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import caffeinate from "../../host/caffeinate.ts";
import registerProcessReaper, { type ProcessReaperEvents } from "../../host/process-reaper.ts";
import title, { type TitleEvents } from "../../host/title.ts";

/** Host integration stays separate from session-domain state and owns its process resources. */
export function installHostAdapter(pi: ExtensionAPI) {
	const reaper = registerProcessReaper(pi);
	const keepAwake = caffeinate();
	const titleEvents = title();
	bindHostEvents(pi, reaper, titleEvents);
	return keepAwake;
}

/** Preserve host hook order while keeping subscriptions at the application boundary. */
export function bindHostEvents(pi: ExtensionAPI, reaper: ProcessReaperEvents, titleEvents: TitleEvents): void {
	bindProcessReaperEvents(pi, reaper);
	bindTitleEvents(pi, titleEvents);
}

export function bindProcessReaperEvents(pi: ExtensionAPI, events: ProcessReaperEvents): void {
	pi.on("tool_call", events.toolCall);
	pi.on("tool_result", events.toolResult);
	pi.on("session_shutdown", events.sessionShutdown);
}

export function bindTitleEvents(pi: ExtensionAPI, events: TitleEvents): void {
	pi.on("session_start", events.sessionStart);
	pi.on("session_info_changed", events.sessionInfoChanged);
	pi.on("turn_start", events.turnStart);
	pi.on("session_shutdown", events.sessionShutdown);
}
