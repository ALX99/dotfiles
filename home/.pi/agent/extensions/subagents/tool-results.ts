import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { toError } from "../_shared/errors.ts";
import type { AgentSummary } from "./agent-types.ts";

export interface AgentSummaryDetails {
	readonly summaries: readonly AgentSummary[];
}

export type WaitOutcomeStatus = "settled" | "timed_out" | "cancelled" | "failed";

export interface WaitOutcome {
	readonly agent_id: string;
	readonly status: WaitOutcomeStatus;
	readonly error?: string;
}

export interface WaitDetails extends AgentSummaryDetails {
	readonly elapsedMs: number;
	readonly timeoutMs?: number;
	readonly outcomes: readonly WaitOutcome[];
}

export function agentSummaryDetails(summaries: readonly AgentSummary[]): AgentSummaryDetails {
	return { summaries };
}

export function waitDetails(
	summaries: readonly AgentSummary[],
	elapsedMs: number,
	timeoutMs: number | undefined,
	outcomes: readonly WaitOutcome[] = summaries.map((summary) => ({
		agent_id: summary.agent_id,
		status: "settled",
	})),
): WaitDetails {
	return {
		summaries,
		elapsedMs,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		outcomes,
	};
}

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	const bounded = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 512, maxLines: DEFAULT_MAX_LINES - 2 });
	const output = bounded.truncated
		? `${bounded.content}\n\n[Management output truncated; query fewer agents.]`
		: bounded.content;
	return { content: [{ type: "text", text: output }], details };
}

export function jsonResult<TDetails>(value: unknown, details: TDetails): AgentToolResult<TDetails> {
	return textResult(JSON.stringify(value, null, 2), details);
}

export function resultText(result: Pick<AgentToolResult<unknown>, "content">): string {
	const text = result.content[0];
	return text?.type === "text" ? text.text : "(no output)";
}

export function toolError(prefix: string, cause: unknown): Error {
	const error = toError(cause);
	return new Error(`${prefix}: ${error.message}`, { cause: error });
}
