import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { patchRenderers } from "./render.ts";
import { renderToolStatus } from "../_shared/tool-status.ts";

import {
	APPLY_PATCH_OPENAI_LARK_GRAMMAR,
	APPLY_PATCH_TOOL_DESCRIPTION,
	APPLY_PATCH_TOOL_GUIDELINES,
	APPLY_PATCH_TOOL_NAME,
	APPLY_PATCH_TOOL_SNIPPET,
	type ApplyPatchRunner,
	type ApplyPatchToolDetails,
	type ApplyPatchToolOptions,
} from "./types.ts";

const APPLY_PATCH_PARAMETERS = Type.Object(
	{
		patch: Type.String({
			description: "Raw *** Begin Patch ... *** End Patch text.",
		}),
	},
	{ additionalProperties: false },
);

export function createApplyPatchToolDefinition(
	options: ApplyPatchToolOptions,
	runApplyPatchProcess: ApplyPatchRunner,
	statusFor = renderToolStatus,
): ToolDefinition<typeof APPLY_PATCH_PARAMETERS, ApplyPatchToolDetails> {
	return {
		...patchRenderers(statusFor),
		name: APPLY_PATCH_TOOL_NAME,
		label: "Apply Patch",
		description: APPLY_PATCH_TOOL_DESCRIPTION,
		promptSnippet: APPLY_PATCH_TOOL_SNIPPET,
		promptGuidelines: APPLY_PATCH_TOOL_GUIDELINES,
		parameters: APPLY_PATCH_PARAMETERS,
		// Codex registers apply_patch as an OpenAI custom/freeform tool. Keep
		// that transport while leaving complete syntax validation to Codex.
		constrainedSampling: {
			type: "grammar",
			variants: { openai_lark: APPLY_PATCH_OPENAI_LARK_GRAMMAR },
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const executable = options.executable ?? "codex";
			const result = await runApplyPatchProcess(executable, params.patch, ctx.cwd, signal, options.spawnProcess);
			return {
				content: [{ type: "text", text: result.stdout }],
				details: { exitCode: 0 },
			};
		},
	};
}
