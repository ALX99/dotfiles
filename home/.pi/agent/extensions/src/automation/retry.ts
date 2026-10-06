import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export type UserPrompt = string | (TextContent | ImageContent)[];

export function getLastUserPrompt(
	entries: readonly SessionEntry[],
): { entryId: string; content: UserPrompt } | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "user") {
			return { entryId: entry.id, content: entry.message.content };
		}
	}

	return undefined;
}

export async function retryLastPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Cannot retry while the agent is busy.", "warning");
		return;
	}

	const prompt = getLastUserPrompt(ctx.sessionManager.getBranch());
	if (prompt === undefined) {
		ctx.ui.notify("No previous prompt to retry.", "warning");
		return;
	}

	const editorText = ctx.ui.getEditorText();
	// Selecting a user entry rewinds to its parent and restores its text into the editor.
	const result = await ctx.navigateTree(prompt.entryId, { summarize: false });
	if (result.cancelled) return;

	ctx.ui.setEditorText(editorText);
	pi.sendUserMessage(prompt.content);
}

export default function retry(pi: ExtensionAPI): void {
	pi.registerCommand("retry", {
		description: "Rewind to the last user prompt and replay it on a new branch",
		handler: async (_args, ctx) => retryLastPrompt(pi, ctx),
	});
}
