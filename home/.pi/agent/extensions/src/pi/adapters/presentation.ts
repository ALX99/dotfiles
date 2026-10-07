import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ActiveProfileState } from "../../agents/active-profile.ts";
import type { EditorComposition } from "../../integration/editor.ts";
import type { ToolStatusRenderer } from "../../support/tool-status.ts";
import compactBash from "../../ui/compact.ts";
import copyCode from "../../ui/copy-code.ts";
import statusbar from "../../ui/statusbar.ts";

/** TUI capabilities share the session editor and the application's activity projection. */
export function installPresentationAdapter(
	pi: ExtensionAPI,
	editor: EditorComposition,
	statusFor: ToolStatusRenderer,
	activeProfile?: ActiveProfileState,
) {
	compactBash(pi, statusFor);
	copyCode(pi);
	const activity = statusbar(pi, editor, activeProfile);
	bindStatusbarEvents(pi, activity);
	return activity;
}

/** Activity indicators share the Presentation domain; shutdown cleanup follows runtime disposal. */
export function bindStatusbarEvents(pi: ExtensionAPI, activity: ReturnType<typeof statusbar>): void {
	pi.on("session_start", activity.events.sessionStart);
	pi.on("model_select", activity.events.modelSelect);
	pi.on("turn_start", activity.events.turnStart);
	pi.on("message_end", activity.events.messageEnd);
	pi.on("turn_end", activity.events.turnEnd);
	pi.on("session_compact", activity.events.sessionCompact);
	pi.on("session_tree", activity.events.sessionTree);
}
