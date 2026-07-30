import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { toError } from "../_shared/errors.ts";
import type { AgentSummary } from "./agent-types.ts";
import type { CapacitySnapshot } from "./spawn-admission.ts";
import { toPiUsage, type ReadonlyRunDetails, type RunUsage } from "./run-state.ts";

export interface AgentSummaryDetails {
	readonly summaries: readonly AgentSummary[];
	readonly capacity?: CapacitySnapshot;
}

export type WaitOutcomeStatus = "settled" | "waiting_input" | "deferred" | "timed_out" | "cancelled" | "failed";

export interface WaitOutcome {
	readonly agent_id: string;
	readonly status: WaitOutcomeStatus;
	readonly error?: string;
}

export interface WaitDetails extends AgentSummaryDetails {
	readonly elapsedMs: number;
	readonly timeoutMs?: number;
	readonly outcomes: readonly WaitOutcome[];
	readonly accountedGenerations?: readonly {
		readonly agentId: string;
		readonly generation: number;
	}[];
}

export function agentSummaryDetails(
	summaries: readonly AgentSummary[],
	capacity?: CapacitySnapshot,
): AgentSummaryDetails {
	return { summaries, ...(capacity === undefined ? {} : { capacity }) };
}

export function formatPendingQuestion(summary: AgentSummary): string | undefined {
	const question = summary.pending_question;
	if (!question) return undefined;
	return `agent_id: ${summary.agent_id}
status: waiting_input
generation: ${summary.generation}
question_id: ${question.question_id}

${question.question}

Options:
${question.options.map((option) => `- ${option}`).join("\n")}

Answer with answer_agent, then use wait_agent to collect the resumed run. If external input is required, call ask_question first with only the substantive alternatives; it adds 'Compare options' and 'Something else' automatically.`;
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
		? `${bounded.content}\n\n[Management preview truncated; query fewer agents or use read_agent_result to page an exact terminal result.]`
		: bounded.content;
	return { content: [{ type: "text", text: output }], details };
}

/** Include nested child usage only when this tool call synchronously completed its generation. */
export function completedRunResult(
	text: string,
	details: ReadonlyRunDetails,
	usage: Readonly<RunUsage> | undefined,
): AgentToolResult<ReadonlyRunDetails> {
	const result = textResult(text, details);
	return usage === undefined ? result : { ...result, usage: toPiUsage(usage) };
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
