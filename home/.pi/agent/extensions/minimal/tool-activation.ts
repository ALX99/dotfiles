import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tools minimal mode always exposes: the shell and direct file reads. */
export const MINIMAL_CORE_TOOL_NAMES = ["bash", "read"] as const;

/** The editor a session falls back to when no editing tool has selected one. */
const FALLBACK_EDITOR_TOOL_NAME = "edit";

/**
 * The file-editing tools a session can have active, most preferred first. Minimal mode keeps the one
 * the session uses rather than forcing a choice, so `codex-apply-patch`'s swap of builtin `edit` for
 * `apply_patch` survives the restriction. Pi runs sibling tool calls from one turn concurrently, so
 * batching them needs no tool of its own.
 */
const MINIMAL_EDITOR_TOOL_NAMES = ["apply_patch", FALLBACK_EDITOR_TOOL_NAME] as const;

type ToolSelectionAPI = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
type ToolRegistryAPI = Pick<ExtensionAPI, "getAllTools">;

/**
 * The mode's selection for a session: the core tools plus the editing tool it already has. Pi ignores
 * names the session does not allow, so the fallback editor is harmless when nothing provides one.
 */
export function minimalToolNames(active: readonly string[]): string[] {
	const editor = MINIMAL_EDITOR_TOOL_NAMES.find((name) => active.includes(name)) ?? FALLBACK_EDITOR_TOOL_NAME;
	return [...MINIMAL_CORE_TOOL_NAMES, editor];
}

/**
 * Minimal mode needs its core tools registered even when the session has no editing tool to keep,
 * because Pi drops unknown names from a selection instead of reporting them.
 */
export function missingMinimalTools(pi: ToolRegistryAPI): string[] {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	return MINIMAL_CORE_TOOL_NAMES.filter((name) => !available.has(name));
}

/**
 * Apply a selection, skipping a write that would leave the live one unchanged. Pi rebuilds the
 * session's base system prompt on every write, and the mode re-asserts its selection at each turn.
 */
export function applyTools(pi: ToolSelectionAPI, names: readonly string[]): void {
	const active = pi.getActiveTools();
	if (active.length === names.length && active.every((name, index) => name === names[index])) return;
	pi.setActiveTools([...names]);
}
