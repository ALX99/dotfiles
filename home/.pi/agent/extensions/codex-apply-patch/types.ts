export const APPLY_PATCH_TOOL_NAME = "apply_patch" as const;
export const APPLY_PATCH_TOOL_DESCRIPTION =
	"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

/**
 * Keep Codex's OpenAI custom-tool transport without duplicating its parser.
 *
 * The executable remains the authority for patch syntax and application. This
 * deliberately only rejects input that lacks the outer patch markers, while
 * accepting arbitrary content between them so parser changes or lenient
 * whitespace do not make the model unable to call the tool.
 */
export const APPLY_PATCH_OPENAI_LARK_GRAMMAR = String.raw`start: /.*\*\*\* Begin Patch.*\*\*\* End Patch.*/s`;
