import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ToolSelection } from "../../integration/tool-selection.ts";
import type { ToolStatusRenderer } from "../../support/tool-status.ts";
import { supportsApplyPatchTransport } from "../../tools/apply-patch/register.ts";
import askQuestion from "../../tools/ask-question/register.ts";
import codexCompat from "../../tools/apply-patch/register.ts";

/** Tools and their transport-specific activation belong to one capability boundary. */
export function installToolAdapter(
	pi: ExtensionAPI,
	toolSelection: ToolSelection,
	statusFor: ToolStatusRenderer,
): void {
	askQuestion(pi);
	codexCompat(pi, statusFor);
	installApplyPatchSelection(pi, toolSelection);
}

export function installApplyPatchSelection(pi: ExtensionAPI, toolSelection: ToolSelection): void {
	pi.on("session_start", (_event, context) =>
		toolSelection.setApplyPatchActive(supportsApplyPatchTransport(context.model)),
	);
	pi.on("model_select", (event) => toolSelection.setApplyPatchActive(supportsApplyPatchTransport(event.model)));
}
