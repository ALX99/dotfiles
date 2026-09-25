import type { ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { toError } from "../_shared/errors.ts";

export const MODEL_SHORTCUTS = [
	{ command: "luna", provider: "openai-codex", model: "gpt-6-luna", thinkingLevel: "xhigh" },
	{ command: "astra", provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "medium" },
	{ command: "sol", provider: "openai-codex", model: "gpt-6-sol", thinkingLevel: "medium" },
	{ command: "free", provider: "commandcode", model: "stealth/space-bunny-alpha", thinkingLevel: "high" },
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
		pi.registerCommand(shortcut.command, {
			description: `Switch to ${shortcut.model}`,
			handler: async (_args, ctx) => {
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

type Shortcut = (typeof MODEL_SHORTCUTS)[number];

/**
 * Resolves a shortcut's model, preferring the session scope so an explicit
 * `model:level` scope pattern wins, then falling back to the full catalogue.
 * Scoping (enabledModels) only gates the model picker and Ctrl+P cycling, not
 * setModel, so a shortcut does not have to be listed in the scope to work.
 */
export function resolveShortcutModel(
	shortcut: Shortcut,
	ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
): { model: Model<any>; thinkingLevel: NonNullable<ScopedModel["thinkingLevel"]> } | undefined {
	const scoped = ctx.scopedModels.find(
		({ model }) => model.provider === shortcut.provider && model.id === shortcut.model,
	);
	const model = scoped?.model ?? ctx.modelRegistry.find(shortcut.provider, shortcut.model);
	if (!model) return undefined;
	return { model, thinkingLevel: scoped?.thinkingLevel ?? shortcut.thinkingLevel };
}

async function applyShortcut(
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "setModel" | "setThinkingLevel">,
	shortcut: Shortcut,
	ctx: ExtensionContext,
	isCurrent: () => boolean,
): Promise<void> {
	const resolved = resolveShortcutModel(shortcut, ctx);
	if (!resolved) {
		if (ctx.hasUI) ctx.ui.notify(`Model not found: ${shortcut.provider}/${shortcut.model}`, "warning");
		return;
	}

	const switched = await pi.setModel(resolved.model);
	if (!isCurrent()) return;
	if (!switched) {
		if (ctx.hasUI) ctx.ui.notify(`No API key for ${shortcut.provider}/${shortcut.model}`, "warning");
		return;
	}
	pi.setThinkingLevel(resolved.thinkingLevel);
	if (ctx.hasUI) {
		ctx.ui.notify(`Switched to ${shortcut.provider}/${shortcut.model} (${pi.getThinkingLevel()} thinking)`, "info");
	}
}
