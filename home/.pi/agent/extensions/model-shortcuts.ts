import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MODEL_SHORTCUTS = [
	{ shortcut: "alt+1", provider: "openai-codex", model: "gpt-5.6-luna" },
	{ shortcut: "alt+2", provider: "openai-codex", model: "gpt-5.6-terra" },
	{ shortcut: "alt+3", provider: "openai-codex", model: "gpt-5.6-sol" },
] as const;

export default function modelShortcuts(pi: ExtensionAPI) {
	for (const shortcut of MODEL_SHORTCUTS) {
		pi.registerShortcut(shortcut.shortcut, {
			description: `Switch to ${shortcut.model}`,
			handler: async (ctx) => {
				const model = ctx.modelRegistry.find(shortcut.provider, shortcut.model);
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

				if (ctx.hasUI) {
					ctx.ui.notify(`Switched to ${shortcut.provider}/${shortcut.model}`, "info");
				}
			},
		});
	}
}
