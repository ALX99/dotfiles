import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { toError } from "../_shared/errors.ts";
import type { AgentSummary } from "./agent-types.ts";
import { requiresExactResultRead } from "./tool-activation.ts";
import type { CapacitySnapshot } from "./spawn-admission.ts";
import { toPiUsage, type ReadonlyRunDetails, type RunUsage } from "./run-state.ts";

export interface AgentSummaryDetails {
	readonly summaries: readonly AgentSummary[];
	readonly capacity?: CapacitySnapshot;
}

export type WaitOutcomeStatus = "settled" | "waiting_input" | "cancelled" | "failed";

export interface WaitOutcome {
	readonly agent_id: string;
	readonly status: WaitOutcomeStatus;
	readonly error?: string;
}

export interface WaitDetails extends AgentSummaryDetails {
	readonly elapsedMs: number;
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

export function formatAgentCompletion(summary: AgentSummary, includeRetention = false): string {
	const retention = includeRetention ? `\nretained: ${summary.retained}` : "";
	const retainedNextStep =
		summary.retained && (summary.status === "idle" || summary.status === "failed" || summary.status === "aborted")
			? "\n\nThis retained agent is settled. Use followup_agent for another task or close_agent to release its admission slot."
			: "";
	const exactResultGuidance = requiresExactResultRead(summary)
		? "\n\nUse read_agent_result for exact cursor-paged reconstruction."
		: "";
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}${retention}\n\n${summary.final_text || summary.error || "(no output)"}${retainedNextStep}${exactResultGuidance}`;
}

/** Describe a launched background generation without promising invalid controls. */
export function formatAgentLaunch(summary: AgentSummary): string {
	const pendingQuestion = formatPendingQuestion(summary);
	if (pendingQuestion) return pendingQuestion;
	const nextStep = summary.retained
		? "Use wait_agent, send_agent, interrupt_agent, or close_agent while it runs. After it settles, use followup_agent or close_agent."
		: "Use wait_agent, send_agent, interrupt_agent, or close_agent while it runs; one-shot agents archive after settlement.";
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\nretained: ${summary.retained}\n\nCompletion will be delivered automatically. ${nextStep}`;
}

export function waitDetails(
	summaries: readonly AgentSummary[],
	elapsedMs: number,
	outcomes: readonly WaitOutcome[] = summaries.map((summary) => ({
		agent_id: summary.agent_id,
		status: "settled",
	})),
): WaitDetails {
	return { summaries, elapsedMs, outcomes };
}

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	const bounded = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 512, maxLines: DEFAULT_MAX_LINES - 2 });
	const output = bounded.truncated
		? `${bounded.content}\n\n[Tool output truncated; query fewer agents or request a smaller response.]`
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
