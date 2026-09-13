import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

/**
 * Cursor-style run control: while the agent works, Enter with a message steers
 * the current turn (built in), and Enter on an empty editor delivers the
 * message the interrupt pulled back out of the queue, so a correction lands
 * immediately instead of waiting for the current tool call.
 *
 * An empty editor only counts while a message is actually waiting. With an
 * empty queue the keystroke stays a no-op, so a stray Enter can never abort a
 * run; Escape remains the deliberate way to interrupt.
 *
 * Replaying Escape through the editor keeps Pi's own interrupt pipeline in
 * charge: it restores queued steering messages, and it cancels retry backoff
 * and auto-compaction, which swap in their own Escape handlers while they run.
 * The restored text is captured synchronously from the editor, then sent once
 * the run settles, because Pi only accepts a new prompt while idle.
 *
 * The wrapper lives on CustomEditor.prototype because the editor slot is
 * last-writer-wins and other extensions (statusbar) install editor components.
 * Subagent child sessions load this extension too, in print mode, so shared
 * state lives on the prototype and only TUI sessions count runs or hold UI.
 */

/** Editor UI this extension needs from the interactive session. */
export interface EmptyEnterUi {
	getEditorText(): string;
	setEditorText(text: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface EmptyEnterConditions {
	/** Raw terminal data for the pressed key. */
	readonly key: string;
	/** Current editor text. */
	readonly text: string;
	/** Whether the editor is showing an autocomplete popup. */
	readonly autocompleteOpen: boolean;
	/** Whether the editor is currently refusing submits. */
	readonly submitDisabled: boolean;
	/** Whether an agent run is in flight in an interactive session. */
	readonly busy: boolean;
	/** Whether a message is queued, so interrupting it has something to deliver. */
	readonly queued: boolean;
}

/** Plain Enter, excluding the newline keys the editor handles before submitting. */
export function isPlainEnter(data: string): boolean {
	return data !== "\n" && matchesKey(data, "enter");
}

export function shouldInterruptOnEmptyEnter(conditions: EmptyEnterConditions): boolean {
	return (
		isPlainEnter(conditions.key) &&
		conditions.text.trim() === "" &&
		!conditions.autocompleteOpen &&
		!conditions.submitDisabled &&
		conditions.busy &&
		conditions.queued
	);
}

type HandleInput = (this: CustomEditor, data: string) => void;

export interface EmptyEnterPatch {
	readonly original: HandleInput;
	/** Agent runs in flight in interactive sessions. */
	activeRuns: number;
	/** Editor UI of the interactive session; child sessions never set it. */
	ui: EmptyEnterUi | undefined;
	/** Whether a message is waiting in the session's queue. */
	hasQueuedMessages: () => boolean;
	/** Called with the editor text left behind by an interrupting Enter. */
	onInterrupt: (restoredText: string) => void;
	/** Text an interrupting Enter pulled out of the queue, awaiting delivery. */
	restoredText: string | undefined;
}

/**
 * Editor wrapper: an empty Enter while a run is in flight becomes Escape, and
 * reports the text the interrupt restored. The run count arrives through a
 * getter because installation and run accounting can come from different
 * extension instances (parent and children).
 */
export function createEmptyEnterHandler(
	original: HandleInput,
	activeRuns: () => number,
	hasQueuedMessages: () => boolean,
	onInterrupt: (restoredText: string) => void,
): HandleInput {
	return function (this: CustomEditor, data: string): void {
		if (
			shouldInterruptOnEmptyEnter({
				key: data,
				text: this.getText(),
				autocompleteOpen: this.isShowingAutocomplete(),
				submitDisabled: this.disableSubmit,
				busy: activeRuns() > 0,
				queued: hasQueuedMessages(),
			})
		) {
			// The interrupt handlers restore queued messages synchronously, so the
			// editor already holds them when this returns.
			original.call(this, "\x1b");
			onInterrupt(this.getText());
			return;
		}
		original.call(this, data);
	};
}

const PATCH: unique symbol = Symbol.for("pi.interrupt-on-empty-enter.patch");

interface PatchablePrototype {
	handleInput: HandleInput;
	[PATCH]?: EmptyEnterPatch;
}

/** Install the editor wrapper once per process; later extension instances reuse it. */
export function installEmptyEnterInterrupt(): EmptyEnterPatch {
	const prototype = CustomEditor.prototype as typeof CustomEditor.prototype & PatchablePrototype;
	const installed = prototype[PATCH];
	if (installed) return installed;

	const patch: EmptyEnterPatch = {
		original: prototype.handleInput,
		activeRuns: 0,
		ui: undefined,
		hasQueuedMessages: () => false,
		onInterrupt: () => {},
		restoredText: undefined,
	};
	prototype[PATCH] = patch;
	prototype.handleInput = createEmptyEnterHandler(
		patch.original,
		() => patch.activeRuns,
		() => patch.hasQueuedMessages(),
		(restoredText) => patch.onInterrupt(restoredText),
	);
	return patch;
}

/**
 * Send the message an interrupting Enter rescued from the queue. The editor is
 * cleared only while it still holds exactly that text, so a draft the user
 * started typing in the meantime survives. Pi reports send failures through
 * its own error channel, so the text is put back only for a synchronous throw.
 */
export function deliverRestoredText(pi: Pick<ExtensionAPI, "sendUserMessage">, patch: EmptyEnterPatch): void {
	const text = patch.restoredText?.trim();
	patch.restoredText = undefined;
	if (text === undefined || text === "") return;

	const ui = patch.ui;
	if (!ui) return;
	const cleared = ui.getEditorText().trim() === text;
	if (cleared) ui.setEditorText("");

	try {
		pi.sendUserMessage(text, { expandPromptTemplates: true });
	} catch (error) {
		if (cleared) ui.setEditorText(text);
		const message = error instanceof Error ? error.message : String(error);
		ui.notify(`Could not send the interrupted message: ${message}`, "error");
	}
}

export default function interruptOnEmptyEnter(pi: ExtensionAPI): void {
	const patch = installEmptyEnterInterrupt();
	patch.onInterrupt = (restoredText) => {
		patch.restoredText = restoredText;
	};

	let interactive = false;
	let activeRuns = 0;

	pi.on("session_start", (_event, ctx) => {
		interactive = ctx.mode === "tui";
		if (!interactive) return;
		patch.ui = ctx.ui;
		patch.hasQueuedMessages = () => ctx.hasPendingMessages();
	});

	pi.on("agent_start", () => {
		if (!interactive) return;
		activeRuns += 1;
		patch.activeRuns += 1;
	});

	pi.on("agent_settled", () => {
		if (!interactive) return;
		if (activeRuns > 0) {
			activeRuns -= 1;
			patch.activeRuns -= 1;
		}
		// Let Pi finish its settle bookkeeping before a new run starts.
		if (patch.restoredText !== undefined) setTimeout(() => deliverRestoredText(pi, patch), 0);
	});

	// Settling is the normal release path; this only catches teardown that
	// skipped it, so a dead run cannot leave the editor interrupting forever.
	pi.on("session_shutdown", () => {
		if (!interactive) return;
		interactive = false;
		patch.activeRuns -= activeRuns;
		activeRuns = 0;
		patch.ui = undefined;
		patch.hasQueuedMessages = () => false;
		patch.restoredText = undefined;
	});
}
