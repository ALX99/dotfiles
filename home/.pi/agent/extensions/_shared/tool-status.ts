import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber } from "effect";
import { runFork } from "./effect-runtime.ts";

const FRAMES = ["⠛", "⠹", "⢸", "⣰", "⣤", "⣆", "⡇", "⠏"];
/** Below this, a running call just shows its spinner. */
const ELAPSED_THRESHOLD_MS = 10_000;

export interface ToolStatusState {
	frame?: number;
	startedAt?: number;
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

/** Each registering extension owns its animations; no timer survives its session. */
export function createToolStatus(pi: ExtensionAPI): typeof renderToolStatus {
	const animations = new Map<ToolStatusState, Fiber.Fiber<never>>();
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
	pi.on("session_start", stopAll);
	pi.on("session_shutdown", stopAll);
	return (theme, context) => {
		const state = context.state;
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
