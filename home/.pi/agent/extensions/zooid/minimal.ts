import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Predicate } from "effect";
import { TASK_TOOL_NAMES } from "../tasks/index.ts";

const SESSION_STATE_TYPE = "minimal-mode-state";
const STATE_VERSION = 1;

/** Tools minimal mode always exposes: the shell and direct file reads. */
export const MINIMAL_CORE_TOOL_NAMES = ["bash", "read"] as const;

/**
 * FFF's tools use either the prefixed names in its normal modes or the builtin
 * names when it runs in override mode. Keep whichever names the extension has
 * activated so minimal mode does not disable FFF search.
 */
const MINIMAL_FFF_TOOL_NAMES = ["fffind", "ffgrep", "fff-multi-grep", "find", "grep", "multi_grep"] as const;

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
 * The mode's selection for a session: the core tools, the editing tool it already has, the task
 * tools the tasks extension currently exposes, and the FFF search tools it has activated. Those
 * extensions reveal some tools lazily, so carrying over what they have activated keeps an active
 * queue and FFF search workable without exposing unrelated tools. Pi ignores names the session does
 * not allow, so the fallback editor is harmless when nothing provides one.
 */
export function minimalToolNames(active: readonly string[]): string[] {
	const editor = MINIMAL_EDITOR_TOOL_NAMES.find((name) => active.includes(name)) ?? FALLBACK_EDITOR_TOOL_NAME;
	return [
		...MINIMAL_CORE_TOOL_NAMES,
		editor,
		...TASK_TOOL_NAMES.filter((name) => active.includes(name)),
		...MINIMAL_FFF_TOOL_NAMES.filter((name) => active.includes(name)),
	];
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

/** The branch-local choice: whether the mode restricts this branch, and the selection it restores. */
interface MinimalState {
	enabled: boolean;
	previousTools: string[];
}

/**
 * Minimal mode is the session default: a session or branch that has never recorded a choice runs
 * restricted. `/minimal off` records the opposite choice on that branch, so the mode stays off
 * there across resumes and navigation.
 */
export default function minimalExtension(pi: ExtensionAPI): void {
	// Live mode state for the current branch. `previousTools` is the session's unrestricted
	// selection, which the mode restores on exit and carries into a branch that recorded none.
	let state: MinimalState = { enabled: false, previousTools: [] };

	function persistState(): void {
		// Session entries are authoritative for branch-local restore; the tool snapshot travels with them.
		pi.appendEntry(SESSION_STATE_TYPE, { version: STATE_VERSION, ...state });
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!state.enabled) {
			ctx.ui.setStatus("minimal", undefined);
			return;
		}
		ctx.ui.setStatus("minimal", ctx.ui.theme.fg("accent", `minimal: ${pi.getActiveTools().join(", ")}`));
	}

	/** Reduce the live selection to the minimal toolset. */
	function restrictTools(): void {
		applyTools(pi, minimalToolNames(pi.getActiveTools()));
	}

	/**
	 * Turn the mode on for this branch, capturing the live selection as the exit baseline when the
	 * session knows none. A session that lacks a core tool cannot run the mode, so it stays off.
	 */
	function enable(ctx: ExtensionContext, announce: boolean): void {
		const missing = missingMinimalTools(pi);
		if (missing.length > 0) {
			const verb = missing.length === 1 ? "is" : "are";
			updateUi(ctx);
			ctx.ui.notify(`Cannot enable minimal mode: ${missing.join(", ")} ${verb} unavailable.`, "error");
			return;
		}
		if (state.previousTools.length === 0) state.previousTools = pi.getActiveTools();
		state.enabled = true;
		persistState();
		restrictTools();
		updateUi(ctx);
		if (announce) ctx.ui.notify(`Minimal mode on: ${pi.getActiveTools().join(", ")} only.`, "info");
	}

	/** Record the mode as off for this branch and restore its selection. */
	function disable(ctx: ExtensionContext): void {
		const restore = state.previousTools;
		state = { enabled: false, previousTools: restore };
		persistState();
		updateUi(ctx);
		if (restore.length > 0) {
			applyTools(pi, restore);
			ctx.ui.notify("Minimal mode off.", "info");
			return;
		}
		// The mode only narrows the live selection, so a baseline it never recorded cannot be
		// reconstructed here: the session kept no earlier selection to read. Restoring nothing would
		// leave the session with no tools at all, and /reload rebuilds the runtime from the current
		// selection, so only a new session re-derives the configured default tools.
		ctx.ui.notify(
			"Minimal mode off, but no earlier tool selection was recorded, so the session keeps the minimal toolset. Start a new session (/new) to get the configured default tools back.",
			"warning",
		);
	}

	/** Re-apply the branch's recorded choice, adopting the default on a branch that recorded none. */
	function applyBranchState(ctx: ExtensionContext): void {
		const recorded = readBranchState(ctx);
		if (recorded === undefined) {
			enable(ctx, false);
			return;
		}
		state = {
			enabled: recorded.enabled,
			// The branch's baseline when it has one; otherwise the session keeps its own, so a branch
			// that was restricted when it was left never adopts that restriction as its baseline.
			previousTools: recorded.previousTools.length > 0 ? recorded.previousTools : state.previousTools,
		};
		if (state.enabled) restrictTools();
		updateUi(ctx);
	}

	pi.registerCommand("minimal", {
		description: `Toggle minimal mode: keep ${MINIMAL_CORE_TOOL_NAMES.join(", ")}, its editing tool, active task tools, and active FFF search tools`,
		handler: async (args, ctx) => {
			switch (args.trim().toLowerCase()) {
				case "":
					if (state.enabled) disable(ctx);
					else enable(ctx, true);
					break;
				case "on":
					if (state.enabled) ctx.ui.notify("Minimal mode is already on.", "info");
					else enable(ctx, true);
					break;
				case "off":
					if (state.enabled) disable(ctx);
					else ctx.ui.notify("Minimal mode is already off.", "info");
					break;
				case "status":
					ctx.ui.notify(
						state.enabled
							? `Minimal mode on. Tools: ${pi.getActiveTools().join(", ") || "none"}.`
							: "Minimal mode off.",
						"info",
					);
					break;
				default:
					ctx.ui.notify("Usage: /minimal [on|off|status]", "warning");
			}
		},
	});

	/**
	 * The mode's selection is an invariant of the live session, not just of a turn: other extensions
	 * add their deferred loader tools while the session starts, and each addition lands after the last
	 * restriction. Re-asserting keeps every view of the selection — status line, `/minimal status`,
	 * and the prompt `/systemprompt` renders — equal to the mode's choice.
	 */
	function reassert(ctx: ExtensionContext): void {
		if (state.enabled) restrictTools();
		updateUi(ctx);
	}

	pi.on("before_agent_start", (_event, ctx) => reassert(ctx));

	/**
	 * Pi emits this after every `session_start` handler has run — startup, `/new`, `/resume`,
	 * `/fork`, and `/reload` — so it is the first moment the tools other extensions contribute at
	 * session start are all known.
	 */
	pi.on("resources_discover", (_event, ctx) => reassert(ctx));

	pi.on("session_start", (_event, ctx) => applyBranchState(ctx));
	pi.on("session_tree", (_event, ctx) => applyBranchState(ctx));
}

/** The branch's most recently recorded state, or undefined when it records none. */
function readBranchState(ctx: ExtensionContext): MinimalState | undefined {
	let state: MinimalState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) continue;
		const parsed = parseState(entry.data);
		if (parsed !== undefined) state = parsed;
	}
	return state;
}

function parseState(data: unknown): MinimalState | undefined {
	if (!Predicate.isObject(data) || data.version !== STATE_VERSION) return undefined;
	if (typeof data.enabled !== "boolean" || !isStringArray(data.previousTools)) return undefined;
	return { enabled: data.enabled, previousTools: [...data.previousTools] };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
