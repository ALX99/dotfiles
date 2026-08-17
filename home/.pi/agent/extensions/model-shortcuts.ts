import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MODEL_SHORTCUTS = [
	{ shortcut: "alt+1", provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" },
	{ shortcut: "alt+2", provider: "openai-codex", model: "gpt-5.6-terra", thinkingLevel: "high" },
	{ shortcut: "alt+3", provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "medium" },
] as const;

export default function modelShortcuts(pi: ExtensionAPI) {
	for (const shortcut of MODEL_SHORTCUTS) {
		pi.registerShortcut(shortcut.shortcut, {
			description: `Switch to ${shortcut.model}`,
			handler: async (ctx) => {
				const scoped = ctx.scopedModels.find(
					({ model }) => model.provider === shortcut.provider && model.id === shortcut.model,
				);
				const model =
					ctx.scopedModels.length > 0 ? scoped?.model : ctx.modelRegistry.find(shortcut.provider, shortcut.model);
				if (!model) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Model not found: ${shortcut.provider}/${shortcut.model}`, "warning");
					}
					return;
				}

				const switched = await pi.setModel(model);
				if (!switched) {
					if (ctx.hasUI) {
						ctx.ui.notify(`No API key for ${shortcut.provider}/${shortcut.model}`, "warning");
					}
					return;
				}
				pi.setThinkingLevel(scoped?.thinkingLevel ?? shortcut.thinkingLevel);

				if (ctx.hasUI) {
					ctx.ui.notify(`Switched to ${shortcut.provider}/${shortcut.model}`, "info");
				}
			},
		});
	}
}
