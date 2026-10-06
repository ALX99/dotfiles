import type { CustomEditor, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import type { EditorComposition } from "../integration/editor.ts";

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
 * Replaying Escape through the composed session editor keeps Pi's own interrupt
 * pipeline in charge: it restores queued steering messages and cancels retry
 * backoff and auto-compaction. The restored text is captured synchronously,
 * then offered to run control after settlement, when new prompts are accepted.
 * Child sessions have their own extension state and never install a TUI editor.
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

export interface EmptyEnterState {
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
 * getter because it changes as the session emits lifecycle events after the
 * editor handler is composed.
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

/**
 * Send the message an interrupting Enter rescued from the queue. The editor is
 * cleared only while it still holds exactly that text, so a draft the user
 * started typing in the meantime survives. Pi reports send failures through
 * its own error channel, so the text is put back only for a synchronous throw.
 */
export function deliverRestoredText(pi: Pick<ExtensionAPI, "sendUserMessage">, state: EmptyEnterState): void {
	const text = state.restoredText?.trim();
	state.restoredText = undefined;
	if (text === undefined || text === "") return;

	const ui = state.ui;
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

export interface RescuedInputWork {
	rescuedInput(): Effect.Effect<void> | undefined;
	setActiveRuns(count: number): void;
}

export default function interruptOnEmptyEnter(pi: ExtensionAPI, editor: EditorComposition): RescuedInputWork {
	const state: EmptyEnterState = {
		activeRuns: 0,
		ui: undefined,
		hasQueuedMessages: () => false,
		onInterrupt: (restoredText) => {
			state.restoredText = restoredText;
		},
		restoredText: undefined,
	};

	let interactive = false;

	editor.setInputHandler((instance, data, original) => {
		createEmptyEnterHandler(
			original,
			() => state.activeRuns,
			() => state.hasQueuedMessages(),
			(restoredText) => state.onInterrupt(restoredText),
		).call(instance, data);
	});

	pi.on("session_start", (_event, ctx) => {
		interactive = ctx.mode === "tui";
		if (!interactive) return;
		state.ui = ctx.ui;
		state.hasQueuedMessages = () => ctx.hasPendingMessages();
	});

	// Settling is the normal release path; this only catches teardown that
	// skipped it, so a dead run cannot leave the editor interrupting forever.
	pi.on("session_shutdown", () => {
		if (!interactive) return;
		interactive = false;
		state.activeRuns = 0;
		state.ui = undefined;
		state.hasQueuedMessages = () => false;
		state.restoredText = undefined;
	});

	return {
		rescuedInput() {
			if (!interactive || state.restoredText === undefined) return undefined;
			return Effect.sync(() => deliverRestoredText(pi, state));
		},
		setActiveRuns(count) {
			state.activeRuns = Math.max(0, count);
		},
	};
}
