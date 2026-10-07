import { Context, Effect, Layer, Ref } from "effect";

export type ActivitySignal =
	| "session_start"
	| "session_shutdown"
	| "agent_start"
	| "agent_end"
	| "agent_settled"
	| "ui_prompt_start"
	| "ui_prompt_end";

export interface ActivitySnapshot {
	readonly activeRuns: number;
	readonly indicatorActive: boolean;
	readonly keepAwakeActive: boolean;
}

interface ActivityState {
	readonly activeRuns: number;
	readonly agentEnded: boolean;
	readonly promptActive: boolean;
}

function snapshot(state: ActivityState): ActivitySnapshot {
	return {
		activeRuns: state.activeRuns,
		indicatorActive: state.activeRuns > 0 && !state.agentEnded && !state.promptActive,
		keepAwakeActive: state.activeRuns > 0 && !state.agentEnded && !state.promptActive,
	};
}

/** One owner for the distinct statusbar, editor, keep-awake, and empty-Enter activity views. */
export class AgentActivity extends Context.Service<
	AgentActivity,
	{
		update(signal: ActivitySignal): Effect.Effect<ActivitySnapshot>;
	}
>()("personal/AgentActivity") {
	static readonly layer = Layer.effect(
		AgentActivity,
		Effect.gen(function* () {
			const state = yield* Ref.make<ActivityState>({ activeRuns: 0, agentEnded: true, promptActive: false });

			const update = Effect.fnUntraced(function* (signal: ActivitySignal) {
				return yield* Ref.modify(state, (current) => {
					let next = current;
					switch (signal) {
						case "session_start":
						case "session_shutdown":
							next = { activeRuns: 0, agentEnded: true, promptActive: false };
							break;
						case "agent_start":
							next = { ...current, activeRuns: current.activeRuns + 1, agentEnded: false };
							break;
						case "agent_end":
							next = { ...current, agentEnded: true };
							break;
						case "agent_settled":
							next = {
								...current,
								activeRuns: Math.max(0, current.activeRuns - 1),
								agentEnded: current.activeRuns <= 1,
							};
							break;
						case "ui_prompt_start":
							next = { ...current, promptActive: true };
							break;
						case "ui_prompt_end":
							next = { ...current, promptActive: false };
							break;
					}
					return [snapshot(next), next] as const;
				});
			});

			return AgentActivity.of({ update });
		}),
	);
}
