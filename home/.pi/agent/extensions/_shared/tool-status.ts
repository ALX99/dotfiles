import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Result, Schema } from "effect";
import { runFork } from "./effect-runtime.ts";

const FRAMES = ["⠛", "⠹", "⢸", "⣰", "⣤", "⣆", "⡇", "⠏"];
/** Below this, a running call just shows its spinner. */
const ELAPSED_THRESHOLD_MS = 10_000;

export interface ToolStatusState {
	frame?: number;
	startedAt?: number;
	durationMs?: number;
}

const DURATION_ENTRY = "tool-duration";
const decodeDuration = Schema.decodeUnknownResult(
	Schema.Struct({
		toolCallId: Schema.NonEmptyString,
		toolName: Schema.NonEmptyString,
		durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	}),
);

/** Missing timings stay absent rather than being estimated from transcript timestamps. */
export function renderToolDuration(theme: Theme, state: ToolStatusState): string | undefined {
	const ms = state.durationMs;
	if (ms === undefined) return undefined;
	const text = ms < 1000 ? `${Math.floor(ms)}ms` : formatElapsed(ms);
	return theme.fg(ms < ELAPSED_THRESHOLD_MS ? "success" : ms < 60_000 ? "warning" : "error", text);
}

/** "12s" below a minute, then "1m 5s" as the minutes grow. */
export function formatElapsed(elapsedMs: number): string {
	const seconds = Math.floor(elapsedMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Elapsed time for a call that `createToolStatus` is animating, or undefined while it
 * is under the threshold. The animation redraws the row, so callers can read this at
 * paint time and see it tick every second.
 */
export function runningSince(state: ToolStatusState): string | undefined {
	if (state.startedAt === undefined) return undefined;
	const elapsedMs = performance.now() - state.startedAt;
	return elapsedMs >= ELAPSED_THRESHOLD_MS ? formatElapsed(elapsedMs) : undefined;
}

type StatusContext = Parameters<
	NonNullable<ToolDefinition<import("typebox").TSchema, unknown, ToolStatusState>["renderCall"]>
>[2];

export function renderToolStatus(theme: Theme, context: StatusContext): string {
	return context.isPartial
		? theme.fg("warning", context.executionStarted ? (FRAMES[context.state.frame ?? 0] ?? "⠛") : "·")
		: theme.fg(context.isError ? "error" : "success", context.isError ? "✗" : "✓");
}

/** Each registering extension owns animations and timings for its tool names. */
export function createToolStatus(pi: ExtensionAPI, toolNames: readonly string[]): typeof renderToolStatus {
	const animations = new Map<ToolStatusState, Fiber.Fiber<never>>();
	const starts = new Map<string, number>();
	const durations = new Map<string, number>();
	const names = new Set(toolNames);
	const stop = (state: ToolStatusState) => {
		const fiber = animations.get(state);
		if (!fiber) return;
		animations.delete(state);
		delete state.startedAt;
		runFork(Fiber.interrupt(fiber));
	};
	const stopAll = () => {
		for (const state of animations.keys()) stop(state);
	};
	const restore = (ctx: ExtensionContext) => {
		stopAll();
		starts.clear();
		durations.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== DURATION_ENTRY) continue;
			const decoded = decodeDuration(entry.data);
			if (Result.isSuccess(decoded) && names.has(decoded.success.toolName)) {
				durations.set(decoded.success.toolCallId, decoded.success.durationMs);
			}
		}
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		stopAll();
		starts.clear();
		durations.clear();
	});
	pi.on("tool_execution_start", (event) => {
		if (names.has(event.toolName) && event.parentToolCallId === undefined) {
			starts.set(event.toolCallId, performance.now());
		}
	});
	pi.on("tool_execution_end", (event) => {
		const start = starts.get(event.toolCallId);
		if (start === undefined) return;
		starts.delete(event.toolCallId);
		const durationMs = Math.max(0, performance.now() - start);
		pi.appendEntry(DURATION_ENTRY, { toolCallId: event.toolCallId, toolName: event.toolName, durationMs });
		durations.set(event.toolCallId, durationMs);
	});
	return (theme, context) => {
		const state = context.state;
		if (!context.isPartial) {
			const duration = durations.get(context.toolCallId);
			if (duration === undefined) delete state.durationMs;
			else state.durationMs = duration;
		}
		if (context.executionStarted && context.isPartial && !context.isError) {
			if (!animations.has(state)) {
				state.startedAt = performance.now();
				animations.set(
					state,
					runFork(
						Effect.gen(function* () {
							while (true) {
								yield* Effect.sleep(100);
								state.frame = ((state.frame ?? 0) + 1) % FRAMES.length;
								context.invalidate();
							}
						}),
					),
				);
			}
		} else stop(state);
		return renderToolStatus(theme, context);
	};
}
