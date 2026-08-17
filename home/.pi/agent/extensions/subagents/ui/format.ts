import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

export function contextUsagePercentage(usage: Readonly<ContextUsage>): number | undefined {
	return usage.tokens === null || usage.percent === null ? undefined : usage.percent;
}

export function formatContextPercentage(usage: Readonly<ContextUsage>): string | undefined {
	const percentage = contextUsagePercentage(usage);
	return percentage === undefined ? undefined : `${Math.round(percentage)}%`;
}

export function formatContextUsage(usage: Readonly<ContextUsage>): string | undefined {
	const percentage = formatContextPercentage(usage);
	return percentage === undefined ? undefined : `${percentage}/${formatTokens(usage.contextWindow)}`;
}
