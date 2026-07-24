export const APPLY_PATCH_TOOL_NAME = "apply_patch" as const;
export const APPLY_PATCH_TOOL_DESCRIPTION =
	"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

// OpenAI Lark grammar constraining the model's single `patch` argument to the
// Codex `*** Begin Patch` format. Pi 0.82.0 emits this as an OpenAI `custom`
// grammar tool for grammar-capable providers (openai-codex and peers), so no
// patched pi-ai build is required.
//
// It mirrors Codex's own `apply_patch` grammar, but is tightened to match what
// `codex apply_patch` actually accepts at parse time (verified by running the
// real binary):
//   * `add_line*` (not `+`) so an `*** Add File` hunk may create an empty file;
//     the upstream grammar's `add_line+` wrongly rejects empty-file creation.
//   * `change` is required (not `change?`) so an `*** Update File` hunk must
//     contain at least one change line; Codex rejects empty update hunks
//     ("Update file hunk ... is empty"), including move-only renames.
//   * `change_context` uses `/.*/` (not `/.+`) so a bare `@@ ` context line is
//     accepted, matching Codex's lenient parser.
// The `*** Environment ID:` preamble is intentionally omitted: this extension is
// single-environment, and Codex ignores it for non-multi-environment runs.
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line*
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.*)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
