export const APPLY_PATCH_TOOL_NAME = "apply_patch" as const;
export const APPLY_PATCH_TOOL_DESCRIPTION =
	"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

/** Codex lists the tool in its available-tools section as a one-line snippet. */
export const APPLY_PATCH_TOOL_SNIPPET = "Use apply_patch for file edits";

/** Codex's file-editing guidance for the GPT-5.6/6 model templates, verbatim. */
export const APPLY_PATCH_TOOL_GUIDELINES = [
	"Use `apply_patch` for local file edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`. Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.",
];

/**
 * Codex's `apply_patch` grammar, copied verbatim from
 * `codex-rs/core/assets/tools/apply_patch.lark` (openai/codex 713caa89). Codex appends
 * `environment_id?` to `start` only for multi-environment sessions; Pi has one workspace,
 * so this is the single-environment form Codex ships by default.
 *
 * The grammar bounds sampling, so the model cannot emit a patch the parser rejects. Keep it
 * identical to upstream rather than trimming it: `text_file.rs` and the parser accept exactly
 * this language.
 */
export const APPLY_PATCH_OPENAI_LARK_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
