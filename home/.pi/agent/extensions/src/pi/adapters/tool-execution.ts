import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ApplicationEffects } from "../../application.ts";
import { APPLY_PATCH_TOOL_NAME } from "../../tools/apply-patch/types.ts";
import { createToolStatus } from "../../support/tool-status.ts";

const OBSERVED_TOOL_NAMES = ["bash", "edit", "read", APPLY_PATCH_TOOL_NAME] as const;

/** Install one execution observer for all tools whose UI consumes persisted duration state. */
export function installToolExecutionAdapter(pi: ExtensionAPI, applicationEffects: ApplicationEffects) {
	return createToolStatus(pi, OBSERVED_TOOL_NAMES, (effect, options) => applicationEffects.run(effect, options));
}
