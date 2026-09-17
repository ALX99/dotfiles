import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import caffeinate from "./caffeinate.ts";
import compactBash from "./compact.ts";
import copyCode from "./copy-code.ts";
import interruptOnEmptyEnter from "./interrupt-on-empty-enter.ts";
import minimal from "./minimal.ts";
import modelShortcuts from "./model-shortcuts.ts";
import nestedContext from "./nested-context.ts";
import registerProcessReaper from "./process-reaper.ts";
import retry from "./retry.ts";
import statusbar from "./statusbar.ts";
import systemPrompt from "./systemprompt.ts";
import title from "./title.ts";

/**
 * Register zooid's features as one Pi extension.
 *
 * Keep this order aligned with the former package manifest: several features
 * intentionally use Pi's last-registration-wins behavior.
 */
export default function zooid(pi: ExtensionAPI): void {
	registerProcessReaper(pi);
	caffeinate(pi);
	compactBash(pi);
	copyCode(pi);
	interruptOnEmptyEnter(pi);
	minimal(pi);
	modelShortcuts(pi);
	nestedContext(pi);
	retry(pi);
	statusbar(pi);
	systemPrompt(pi);
	title(pi);
}
