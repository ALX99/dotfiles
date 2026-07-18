import { z } from "zod";
import { isRecord } from "../_shared/json.ts";

const UsageSchema = z
	.object({
		input: z.number().finite().nonnegative().optional(),
		output: z.number().finite().nonnegative().optional(),
		cacheRead: z.number().finite().nonnegative().optional(),
		cacheWrite: z.number().finite().nonnegative().optional(),
		totalTokens: z.number().finite().nonnegative().optional(),
		cost: z.object({ total: z.number().finite().nonnegative().optional() }).optional(),
	})
	.strip();

const KnownContentPartSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }).strip(),
	z.object({ type: z.literal("toolCall"), name: z.string(), arguments: z.unknown() }).strip(),
]);

const UnknownContentPartSchema = z
	.looseObject({ type: z.string().min(1) })
	.refine((part) => part.type !== "text" && part.type !== "toolCall", {
		message: "known content types must satisfy their strict schema",
	});

const ContentPartSchema = z.union([KnownContentPartSchema, UnknownContentPartSchema]);

const MessageSchema = z
	.object({
		role: z.string(),
		content: z.array(ContentPartSchema),
		usage: UsageSchema.optional(),
		stopReason: z.string().optional(),
		errorMessage: z.string().optional(),
	})
	.strip();

const AgentEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("agent_start") }).strip(),
	z.object({ type: z.literal("agent_settled") }).strip(),
	z.object({ type: z.literal("message_end"), message: MessageSchema }).strip(),
	z
		.object({
			type: z.literal("tool_execution_start"),
			toolCallId: z.string(),
			toolName: z.string(),
			args: z.unknown(),
		})
		.strip(),
	z
		.object({
			type: z.literal("tool_execution_update"),
			toolCallId: z.string(),
			toolName: z.string(),
			args: z.unknown(),
			partialResult: z.unknown(),
		})
		.strip(),
	z
		.object({
			type: z.literal("tool_execution_end"),
			toolCallId: z.string(),
			toolName: z.string(),
			result: z.unknown(),
			isError: z.boolean(),
		})
		.strip(),
]);

export type AgentEvent = Readonly<z.infer<typeof AgentEventSchema>>;
export type WireMessage = Readonly<z.infer<typeof MessageSchema>>;

const FOLDED_EVENT_TYPES = new Set([
	"agent_start",
	"agent_settled",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

export type ParsedAgentEvent =
	| { readonly kind: "event"; readonly event: AgentEvent }
	| { readonly kind: "unsupported"; readonly event: Readonly<Record<string, unknown> & { type: string }> }
	| { readonly kind: "error"; readonly error: Error };

/**
 * Validate the envelope before deciding whether an event is supported. A
 * malformed supported discriminator is never allowed to fall through as an
 * unsupported event.
 */
export function parseAgentEvent(value: unknown): ParsedAgentEvent {
	if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) {
		return { kind: "error", error: new Error("RPC event must be an object with a non-empty string type.") };
	}
	if (!FOLDED_EVENT_TYPES.has(value.type)) {
		return { kind: "unsupported", event: { ...value, type: value.type } };
	}
	const parsed = AgentEventSchema.safeParse(value);
	if (!parsed.success) {
		return {
			kind: "error",
			error: new Error(`Malformed '${value.type}' RPC event: ${z.prettifyError(parsed.error)}`),
		};
	}
	return { kind: "event", event: parsed.data };
}
