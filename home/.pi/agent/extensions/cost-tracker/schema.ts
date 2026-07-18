import { z } from "zod";
import { isRecord, parseJson } from "../_shared/json.ts";

const MetricSchema = z.number().finite().nonnegative();
const TimestampSchema = z.union([z.string().min(1), MetricSchema]);
const ToolCountsSchema = z.custom<Record<string, number>>(
	(value): value is Record<string, number> =>
		isRecord(value) &&
		Object.entries(value).every(([name, count]) => name.length > 0 && MetricSchema.safeParse(count).success),
	"expected a record of non-negative finite tool counts",
);

/*
 * Session messages intentionally allow Pi's unrelated wire fields (content,
 * provider, stopReason, etc.). The cost payload itself is strict: Pi's
 * currently emitted supplementary metrics are listed, and an unknown metric
 * is diagnosed rather than being silently treated as trusted usage data.
 */
const UsageSchema = z.strictObject({
	input: MetricSchema.optional(),
	output: MetricSchema.optional(),
	cacheRead: MetricSchema.optional(),
	cacheWrite: MetricSchema.optional(),
	reasoning: MetricSchema.optional(),
	totalTokens: MetricSchema.optional(),
	cacheWrite1h: MetricSchema.optional(),
	cost: z
		.strictObject({
			input: MetricSchema.optional(),
			output: MetricSchema.optional(),
			cacheRead: MetricSchema.optional(),
			cacheWrite: MetricSchema.optional(),
			total: MetricSchema.optional(),
		})
		.optional(),
});

const AssistantMessageSchema = z
	.object({
		role: z.literal("assistant"),
		model: z.string().min(1).optional(),
		usage: UsageSchema,
	})
	.passthrough();

const AssistantSessionEntrySchema = z
	.object({
		type: z.literal("message"),
		timestamp: TimestampSchema,
		message: AssistantMessageSchema,
	})
	.passthrough();

export const ToolRecordSchema = z.strictObject({
	ts: MetricSchema,
	// z.record() materializes an ordinary object and drops an own "__proto__"
	// key. Preserve JSON's own keys here; aggregation consumes them via Map.
	toolCounts: ToolCountsSchema,
});

export const CostTrackerStoreV1Schema = z.strictObject({
	version: z.literal(1),
	records: z.array(ToolRecordSchema),
});

export type ToolRecord = z.infer<typeof ToolRecordSchema>;
export type CostTrackerStoreV1 = z.infer<typeof CostTrackerStoreV1Schema>;

export interface TurnRecord {
	readonly ts: number;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly cost: number;
}

export type SessionLineParseResult =
	| { readonly kind: "accepted"; readonly record: TurnRecord }
	| { readonly kind: "unrelated" }
	| { readonly kind: "malformed"; readonly message: string };

function timestampToMilliseconds(value: z.infer<typeof TimestampSchema>): number | undefined {
	const milliseconds = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/**
 * Validate one JSONL value. Unrelated session entries are deliberately
 * ignored, while a record claiming to be an assistant message is never
 * allowed to fall through after failing its relevant schema.
 */
export function parseSessionLine(line: string, source: string): SessionLineParseResult {
	const parsed = parseJson(line, source);
	if (!parsed.ok) return { kind: "malformed", message: parsed.diagnostic.message };
	if (!isRecord(parsed.value)) return { kind: "unrelated" };

	const value = parsed.value;
	if (value.type !== "message") return { kind: "unrelated" };
	if (!isRecord(value.message) || value.message.role !== "assistant") return { kind: "unrelated" };

	const result = AssistantSessionEntrySchema.safeParse(value);
	if (!result.success) {
		return {
			kind: "malformed",
			message: `${source}: invalid assistant message: ${result.error.issues[0]?.message ?? "unknown validation error"}`,
		};
	}

	const ts = timestampToMilliseconds(result.data.timestamp);
	if (ts === undefined) return { kind: "malformed", message: `${source}: invalid assistant timestamp` };

	const usage = result.data.message.usage;
	return {
		kind: "accepted",
		record: {
			ts,
			model: result.data.message.model ?? "unknown",
			inputTokens: usage.input ?? 0,
			outputTokens: usage.output ?? 0,
			cacheReadTokens: usage.cacheRead ?? 0,
			cacheWriteTokens: usage.cacheWrite ?? 0,
			cost: usage.cost?.total ?? 0,
		},
	};
}
