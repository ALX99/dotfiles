import { isRecord } from "../../_shared/json.ts";
import { sanitizeTerminalText } from "../../_shared/terminal-text.ts";

export function formatTranscript(messages: readonly unknown[]): string[] {
	return messages
		.slice(-50)
		.flatMap((message) => {
			if (!isRecord(message)) return [];
			const role = sanitizeTerminalText(typeof message.role === "string" ? message.role : "message");
			const content = Array.isArray(message.content) ? message.content : [];
			const parts = content.flatMap((part) => {
				if (!isRecord(part)) return [];
				if (part.type === "text" && typeof part.text === "string") {
					const oneLine = sanitizeTerminalText(part.text.slice(0, 1_000));
					return oneLine ? [oneLine] : [];
				}
				if (part.type === "toolCall" && typeof part.name === "string") {
					return [`→ ${sanitizeTerminalText(part.name)}`];
				}
				return [];
			});
			return parts.length ? [`${role}: ${parts.join(" · ")}`] : [];
		})
		.slice(-20);
}
