import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toError } from "./_shared/errors.ts";

export const MODEL_SHORTCUTS = [
	{ shortcut: "alt+1", provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" },
	{ shortcut: "alt+2", provider: "openai-codex", model: "gpt-5.6-terra", thinkingLevel: "high" },
	{ shortcut: "alt+3", provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "medium" },
] as const;

export default function modelShortcuts(pi: ExtensionAPI) {
	let pending: { shortcut: (typeof MODEL_SHORTCUTS)[number]; ctx: ExtensionContext; epoch: number } | undefined;
	let applying = false;
	let epoch = 0;

	const applyPending = async (): Promise<void> => {
		if (applying) return;
		applying = true;
		try {
			while (pending && pending.ctx.isIdle()) {
				const request = pending;
				pending = undefined;
				const isCurrent = () => request.epoch === epoch;
				try {
					await applyShortcut(pi, request.shortcut, request.ctx, isCurrent);
				} catch (error) {
					if (isCurrent() && request.ctx.hasUI)
						request.ctx.ui.notify(`Could not switch model: ${toError(error).message}`, "warning");
				}
			}
		} finally {
			applying = false;
		}
	};

	const reset = (): void => {
		epoch++;
		pending = undefined;
	};
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("agent_settled", () => applyPending());

	for (const shortcut of MODEL_SHORTCUTS) {
		pi.registerShortcut(shortcut.shortcut, {
			description: `Switch to ${shortcut.model}`,
			handler: async (ctx) => {
				pending = { shortcut, ctx, epoch };
				if (!ctx.isIdle() || applying) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Queued ${shortcut.model}; it will switch after the current turn settles.`, "info");
					}
					return;
				}
				await applyPending();
			},
		});
	}
}

async function applyShortcut(
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "setModel" | "setThinkingLevel">,
	shortcut: (typeof MODEL_SHORTCUTS)[number],
	ctx: ExtensionContext,
	isCurrent: () => boolean,
): Promise<void> {
	const scoped = ctx.scopedModels.find(
		({ model }) => model.provider === shortcut.provider && model.id === shortcut.model,
	);
	const model = ctx.scopedModels.length > 0 ? scoped?.model : ctx.modelRegistry.find(shortcut.provider, shortcut.model);
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify(`Model not found: ${shortcut.provider}/${shortcut.model}`, "warning");
		return;
	}

	const switched = await pi.setModel(model);
	if (!isCurrent()) return;
	if (!switched) {
		if (ctx.hasUI) ctx.ui.notify(`No API key for ${shortcut.provider}/${shortcut.model}`, "warning");
		return;
	}
	pi.setThinkingLevel(scoped?.thinkingLevel ?? shortcut.thinkingLevel);
	if (ctx.hasUI) {
		ctx.ui.notify(`Switched to ${shortcut.provider}/${shortcut.model} (${pi.getThinkingLevel()} thinking)`, "info");
	}
}
