import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalBlock } from "../../_shared/terminal-text.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import { manageTick, renderAgentSummaries, renderResultBlock, renderWaitResult } from "../render.ts";
import type { AgentSummaryDetails, WaitDetails } from "../tool-results.ts";
import { resultText } from "../tool-results.ts";

type RendererToolResult<TDetails> = Omit<AgentToolResult<TDetails>, "details"> & {
	readonly details?: TDetails;
};

export function renderRunToolResult(
	result: RendererToolResult<ReadonlyRunDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ticks: Map<string, NodeJS.Timeout>,
	toolCallId: string,
	invalidate: () => void,
): Text | ReturnType<typeof renderResultBlock> {
	if (!result.details) {
		if (!options.isPartial) manageTick(ticks, toolCallId, false, invalidate);
		return new Text(fallbackResultText(result), 0, 0);
	}
	manageTick(ticks, toolCallId, options.isPartial, invalidate);
	return renderResultBlock(result.details, options, theme);
}

export function renderSummaryToolResult(
	title: string,
	result: RendererToolResult<AgentSummaryDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text | ReturnType<typeof renderAgentSummaries> {
	return result.details
		? renderAgentSummaries(title, result.details.summaries, options.expanded, theme)
		: new Text(fallbackResultText(result), 0, 0);
}

export function renderWaitToolResult(
	result: RendererToolResult<WaitDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text | ReturnType<typeof renderWaitResult> {
	return result.details
		? renderWaitResult(result.details, options.expanded, theme)
		: new Text(fallbackResultText(result), 0, 0);
}

function fallbackResultText(result: Pick<AgentToolResult<unknown>, "content">): string {
	return sanitizeTerminalBlock(resultText(result));
}
