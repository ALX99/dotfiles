import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAskQuestionTool } from "./tools.ts";

export { executeAskQuestion } from "./execution.ts";

export default function askQuestionExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		registerAskQuestionTool(pi);
	});
}
