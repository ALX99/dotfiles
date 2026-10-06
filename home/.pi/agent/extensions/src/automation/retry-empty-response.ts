import type {
	AgentActivityOutcome,
	ExtensionAPI,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi already retries a failed assistant turn, but only for the provider text its retry
 * classifier recognizes. A stream that completes without producing any output reports
 * "Provider returned an empty response", which matches no transient-error pattern there, so
 * the run fails on the first occurrence even when an immediate retry would have answered.
 * This continues such a run once more, under Pi's own `retry` settings.
 */

/** Provider wording for a completed stream that carried no output. */
const EMPTY_RESPONSE_ERROR = /provider returned an empty response/i;

/** `retry.maxRetries` default from Pi's settings documentation. */
const DEFAULT_MAX_RETRIES = 3;

/** The `retry` settings this extension reads; Pi owns the rest of the policy. */
export interface EmptyResponseRetryConfig {
	readonly enabled?: boolean;
	readonly maxRetries?: number;
}

/** The slice of the extension API this extension needs, narrowed so tests can supply settings. */
export interface EmptyResponseRetryApi {
	getSettings(): { retry?: EmptyResponseRetryConfig };
}

export interface EmptyResponseRetryState {
	/** How the run ended, as Pi reported it at the settlement boundary. */
	readonly outcome: AgentActivityOutcome;
	/** The last assistant entry on the active branch, which carries the failure. */
	readonly failed: SessionMessageEntry | undefined;
	/** Continuation attempts already spent on this run. */
	readonly attempts: number;
	/** The effective `retry` settings. */
	readonly config: EmptyResponseRetryConfig | undefined;
}

/** The last assistant turn on the branch, which is the one a settled error comes from. */
export function lastAssistantEntry(entries: readonly SessionEntry[]): SessionMessageEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") return entry;
	}

	return undefined;
}

/**
 * The failed turn to retry, or undefined when the run should settle. Only an errored run
 * whose last assistant turn reported an empty response qualifies, and only while the run has
 * budget left under the configured `retry` policy.
 */
export function emptyResponseRetry(state: EmptyResponseRetryState): SessionMessageEntry | undefined {
	if (state.outcome !== "error") return undefined;
	if (state.config?.enabled === false) return undefined;
	if (state.attempts >= (state.config?.maxRetries ?? DEFAULT_MAX_RETRIES)) return undefined;

	const message = state.failed?.message;
	if (
		message?.role !== "assistant" ||
		message.stopReason !== "error" ||
		!EMPTY_RESPONSE_ERROR.test(message.errorMessage ?? "")
	) {
		return undefined;
	}

	return state.failed;
}

export default function retryEmptyResponse(pi: EmptyResponseRetryApi & ExtensionAPI): void {
	let attempts = 0;

	// Settlement is where the run ends, so it is where the next run's budget starts.
	pi.on("agent_settled", () => {
		attempts = 0;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const failed = emptyResponseRetry({
			outcome: event.outcome,
			failed: lastAssistantEntry(ctx.sessionManager.getBranch()),
			attempts,
			config: pi.getSettings().retry,
		});
		if (failed === undefined) return undefined;

		attempts += 1;
		// The failed turn stays in the raw session but leaves the model projection, which is
		// how Pi keeps its own recovery attempts out of the request that follows them.
		return { entries: [{ type: "context_edit", targetId: failed.id, replacement: null }], continue: true };
	});
}
