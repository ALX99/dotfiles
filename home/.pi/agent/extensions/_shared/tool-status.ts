import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber } from "effect";
import { runFork } from "./effect-runtime.ts";

const FRAMES = ["⠛", "⠹", "⢸", "⣰", "⣤", "⣆", "⡇", "⠏"];
export interface ToolStatusState {
	frame?: number;
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
