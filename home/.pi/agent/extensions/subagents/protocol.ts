import { z } from "zod";
import { isRecord } from "../_shared/json.ts";
import { parseAgentEvent, type AgentEvent } from "./event-schema.ts";

const SuccessResponseSchema = z.strictObject({
	type: z.literal("response"),
	id: z.string().min(1),
	command: z.string().optional(),
	success: z.literal(true),
	data: z.unknown().optional(),
});

const FailureResponseSchema = z.strictObject({
	type: z.literal("response"),
	id: z.string().min(1),
	command: z.string().optional(),
	success: z.literal(false),
	error: z.string().trim().min(1),
});

const TimeoutSchema = z.number().int().nonnegative().optional();
const DialogBase = {
	type: z.literal("extension_ui_request"),
	id: z.string().min(1),
	title: z.string(),
	timeout: TimeoutSchema,
};
const ExtensionUiRequestSchema = z.discriminatedUnion("method", [
	z.strictObject({ ...DialogBase, method: z.literal("select"), options: z.array(z.string()) }),
	z.strictObject({ ...DialogBase, method: z.literal("confirm"), message: z.string() }),
	z.strictObject({ ...DialogBase, method: z.literal("input"), placeholder: z.string().optional() }),
	z.strictObject({ ...DialogBase, method: z.literal("editor"), prefill: z.string().optional() }),
	z.strictObject({
		type: z.literal("extension_ui_request"),
		id: z.string().min(1),
		method: z.literal("notify"),
		message: z.string(),
		notifyType: z.enum(["info", "warning", "error"]).optional(),
	}),
	z.strictObject({
		type: z.literal("extension_ui_request"),
		id: z.string().min(1),
		method: z.literal("setStatus"),
		statusKey: z.string(),
		statusText: z.string().optional(),
	}),
	z.strictObject({
		type: z.literal("extension_ui_request"),
		id: z.string().min(1),
		method: z.literal("setWidget"),
		widgetKey: z.string(),
		widgetLines: z.array(z.string()).optional(),
		widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
	}),
	z.strictObject({
		type: z.literal("extension_ui_request"),
		id: z.string().min(1),
		method: z.literal("setTitle"),
		title: z.string(),
	}),
	z.strictObject({
		type: z.literal("extension_ui_request"),
		id: z.string().min(1),
		method: z.literal("set_editor_text"),
		text: z.string(),
	}),
]);

export type RpcResponse = Readonly<z.infer<typeof SuccessResponseSchema> | z.infer<typeof FailureResponseSchema>>;
export type ExtensionUiRequest = Readonly<z.infer<typeof ExtensionUiRequestSchema>>;
export type UnsupportedRpcEvent = Readonly<Record<string, unknown> & { type: string }>;
export type RpcEvent = UnsupportedRpcEvent;

export type ParsedRpcRecord =
	| { readonly kind: "response"; readonly response: RpcResponse }
	| { readonly kind: "ui-request"; readonly request: ExtensionUiRequest }
	| { readonly kind: "agent-event"; readonly event: AgentEvent }
	| { readonly kind: "event"; readonly event: RpcEvent }
	| { readonly kind: "error"; readonly error: Error };

export function parseRpcRecord(value: unknown): ParsedRpcRecord {
	if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) {
		return { kind: "error", error: new Error("RPC record must be an object with a non-empty string type.") };
	}
	if (value.type === "response") {
		const parsed = z.union([SuccessResponseSchema, FailureResponseSchema]).safeParse(value);
		return parsed.success
			? { kind: "response", response: parsed.data }
			: { kind: "error", error: new Error(`Malformed RPC response: ${z.prettifyError(parsed.error)}`) };
	}
	if (value.type === "extension_ui_request") {
		const parsed = ExtensionUiRequestSchema.safeParse(value);
		return parsed.success
			? { kind: "ui-request", request: parsed.data }
			: { kind: "error", error: new Error(`Malformed extension UI request: ${z.prettifyError(parsed.error)}`) };
	}
	const parsed = parseAgentEvent(value);
	if (parsed.kind === "error") return parsed;
	if (parsed.kind === "event") return { kind: "agent-event", event: parsed.event };
	return { kind: "event", event: parsed.event };
}
