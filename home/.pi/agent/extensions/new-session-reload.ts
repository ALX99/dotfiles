import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RELOAD_AFTER_NEW_COMMAND = "reload-after-new";

/**
 * Built-in /new is handled before extension commands, so observe the replacement
 * session instead of trying to override /new. Reload is command-only; defer an
 * internal command until the replacement session has finished binding.
 */
export default function newSessionReloadExtension(pi: ExtensionAPI): void {
	let pendingReload: ReturnType<typeof setTimeout> | undefined;

	pi.registerCommand(RELOAD_AFTER_NEW_COMMAND, {
		description: "Reload extensions after starting a new session",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	pi.on("session_start", (event) => {
		if (event.reason !== "new") return;

		if (pendingReload !== undefined) clearTimeout(pendingReload);
		pendingReload = setTimeout(() => {
			pendingReload = undefined;
			pi.sendUserMessage(`/${RELOAD_AFTER_NEW_COMMAND}`, {
				expandPromptTemplates: true,
			});
		}, 0);
	});

	pi.on("session_shutdown", () => {
		if (pendingReload === undefined) return;
		clearTimeout(pendingReload);
		pendingReload = undefined;
	});
}
