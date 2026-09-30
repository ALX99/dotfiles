import type { ExtensionAPI, ExtensionCommandContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { toError } from "../_shared/errors.ts";

export const MODEL_SHORTCUTS = [
	{ command: "luna", provider: "openai", model: "gpt-6-luna", thinkingLevel: "xhigh" },
	{ command: "astra", provider: "openai", model: "gpt-6-astra", thinkingLevel: "medium" },
	{ command: "sol", provider: "openai", model: "gpt-6.1-sol", thinkingLevel: "medium" },
	{ command: "free", provider: "commandcode", model: "stealth/space-bunny-alpha", thinkingLevel: "high" },
] as const;

export default function modelShortcuts(pi: ExtensionAPI) {
	let pending: { shortcut: (typeof MODEL_SHORTCUTS)[number]; ctx: ExtensionCommandContext; epoch: number } | undefined;
	let applying = false;
	let epoch = 0;
	let idleWait: Promise<unknown> | undefined;

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

	/**
	 * Compaction and branch summarization keep the session busy without ever firing
	 * `agent_settled`, so a queued shortcut also waits on the session's own idle
	 * promise. The waiter re-arms while a shortcut is still queued, because a new
	 * turn or compaction can start before the queue drains.
	 */
	const applyWhenIdle = (ctx: ExtensionCommandContext): void => {
		if (idleWait) return;
		const arm = async (): Promise<void> => {
			idleWait = undefined;
			await applyPending();
			if (pending) applyWhenIdle(ctx);
		};
		idleWait = ctx.waitForIdle().then(arm, arm);
	};

	const reset = (): void => {
		epoch++;
		pending = undefined;
		idleWait = undefined;
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
						ctx.ui.notify(
							`Queued ${shortcut.model}; it will switch once the current turn or compaction settles.`,
							"info",
						);
					}
					applyWhenIdle(ctx);
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
	ctx: Pick<ExtensionCommandContext, "modelRegistry" | "scopedModels">,
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
	ctx: ExtensionCommandContext,
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
