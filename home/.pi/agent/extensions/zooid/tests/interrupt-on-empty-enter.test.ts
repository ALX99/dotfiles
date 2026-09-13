import assert from "node:assert/strict";
import test from "node:test";

import {
	type EmptyEnterConditions,
	type EmptyEnterPatch,
	type EmptyEnterUi,
	createEmptyEnterHandler,
	deliverRestoredText,
	installEmptyEnterInterrupt,
	isPlainEnter,
	shouldInterruptOnEmptyEnter,
} from "../interrupt-on-empty-enter.ts";

const INTERRUPTING: EmptyEnterConditions = {
	key: "\r",
	text: "",
	autocompleteOpen: false,
	submitDisabled: false,
	busy: true,
	queued: true,
};

const editor = (text: string, autocompleteOpen = false, submitDisabled = false) =>
	({ getText: () => text, isShowingAutocomplete: () => autocompleteOpen, disableSubmit: submitDisabled }) as never;

function fakeUi(text = ""): { readonly ui: EmptyEnterUi; readonly editorText: () => string; readonly notes: string[] } {
	let current = text;
	const notes: string[] = [];
	return {
		ui: {
			getEditorText: () => current,
			setEditorText: (next) => {
				current = next;
			},
			notify: (message) => {
				notes.push(message);
			},
		},
		editorText: () => current,
		notes,
	};
}

function fakePatch(ui?: EmptyEnterUi, restoredText?: string): EmptyEnterPatch {
	return {
		original: () => {},
		activeRuns: 0,
		ui,
		hasQueuedMessages: () => false,
		onInterrupt: () => {},
		restoredText,
	};
}

test("interrupts on an empty Enter while an agent run is in flight", () => {
	assert.equal(shouldInterruptOnEmptyEnter(INTERRUPTING), true);
});

test("treats whitespace as no message", () => {
	assert.equal(shouldInterruptOnEmptyEnter({ ...INTERRUPTING, text: " \n\t " }), true);
});

test("ignores keys the editor does not submit with plain Enter", () => {
	for (const key of ["\n", "a", "\x1b", "\x1b\r", "\x1b[13;2~"]) {
		assert.equal(shouldInterruptOnEmptyEnter({ ...INTERRUPTING, key }), false, JSON.stringify(key));
	}
});

test("does not interrupt for messages, autocomplete, disabled submits, or idle sessions", () => {
	assert.equal(shouldInterruptOnEmptyEnter({ ...INTERRUPTING, text: "keep going" }), false);
	assert.equal(shouldInterruptOnEmptyEnter({ ...INTERRUPTING, autocompleteOpen: true }), false);
	assert.equal(shouldInterruptOnEmptyEnter({ ...INTERRUPTING, submitDisabled: true }), false);
	assert.equal(shouldInterruptOnEmptyEnter({ ...INTERRUPTING, busy: false }), false);
});

test("leaves a stray empty Enter alone when nothing is queued to deliver", () => {
	assert.equal(shouldInterruptOnEmptyEnter({ ...INTERRUPTING, queued: false }), false);
});

test("matches Enter but not newline keys", () => {
	assert.equal(isPlainEnter("\r"), true);
	assert.equal(isPlainEnter("\n"), false);
	assert.equal(isPlainEnter("\x1b[13;2~"), false);
});

test("replays Escape and reports the text the interrupt restored", () => {
	const seen: string[] = [];
	const restored: string[] = [];
	let editorText = "";
	const target = {
		getText: () => editorText,
		isShowingAutocomplete: () => false,
		disableSubmit: false,
	};
	const handler = createEmptyEnterHandler(
		(data) => {
			seen.push(data);
			// What Pi's Escape handler does: put the queued message back in the editor.
			if (data === "\x1b") editorText = "stop, do X instead";
		},
		() => 1,
		() => true,
		(text) => restored.push(text),
	);

	handler.call(target as never, "\r");

	assert.deepEqual(seen, ["\x1b"]);
	assert.deepEqual(restored, ["stop, do X instead"]);
});

test("passes every other key through untouched", () => {
	const seen: string[] = [];
	const recording = (data: string) => {
		seen.push(data);
	};
	const busy = createEmptyEnterHandler(
		recording,
		() => 1,
		() => true,
		() => {},
	);
	const idle = createEmptyEnterHandler(
		recording,
		() => 0,
		() => true,
		() => {},
	);
	const emptyQueue = createEmptyEnterHandler(
		recording,
		() => 1,
		() => false,
		() => {},
	);

	busy.call(editor("hi"), "\r");
	busy.call(editor(""), "\x1b");
	busy.call(editor(""), "\n");
	busy.call(editor("", true), "\r");
	busy.call(editor("", false, true), "\r");
	idle.call(editor(""), "\r");
	emptyQueue.call(editor(""), "\r");

	assert.deepEqual(seen, ["\r", "\x1b", "\n", "\r", "\r", "\r", "\r"]);
});

test("nothing is delivered when the interrupt restored no message", () => {
	const { ui, editorText } = fakeUi();
	const sent: string[] = [];
	const pi = {
		sendUserMessage: (content: string | unknown[]) => {
			if (typeof content === "string") sent.push(content);
		},
	};
	deliverRestoredText(pi, fakePatch(ui));
	deliverRestoredText(pi, fakePatch(ui, "  "));

	assert.deepEqual(sent, []);
	assert.equal(editorText(), "");
});

test("sends the restored message and clears the editor", () => {
	const { ui, editorText } = fakeUi("stop, do X instead");
	const patch = fakePatch(ui, "stop, do X instead");
	const sent: { text: string; expandPromptTemplates?: boolean }[] = [];
	deliverRestoredText(
		{
			sendUserMessage: (content, options) => {
				if (typeof content !== "string") return;
				sent.push({ text: content, ...options });
			},
		},
		patch,
	);

	assert.deepEqual(sent, [{ text: "stop, do X instead", expandPromptTemplates: true }]);
	assert.equal(editorText(), "");
	// A delivered message is not delivered twice.
	deliverRestoredText({ sendUserMessage: () => assert.fail("sent twice") }, patch);
});

test("keeps a draft the user typed after the interrupt", () => {
	const { ui, editorText } = fakeUi("stop, do X instead\n\nand also this");
	const sent: string[] = [];
	deliverRestoredText(
		{
			sendUserMessage: (content) => {
				if (typeof content === "string") sent.push(content);
			},
		},
		fakePatch(ui, "stop, do X instead"),
	);

	assert.deepEqual(sent, ["stop, do X instead"]);
	assert.equal(editorText(), "stop, do X instead\n\nand also this");
});

test("restores the editor and reports a failed send", () => {
	const { ui, editorText, notes } = fakeUi("stop, do X instead");
	deliverRestoredText(
		{
			sendUserMessage: () => {
				throw new Error("Agent is already processing");
			},
		},
		fakePatch(ui, "stop, do X instead"),
	);

	assert.equal(editorText(), "stop, do X instead");
	assert.deepEqual(notes, ["Could not send the interrupted message: Agent is already processing"]);
});

test("installs a single wrapper that later extension instances reuse", () => {
	const first = installEmptyEnterInterrupt();
	assert.equal(installEmptyEnterInterrupt(), first);
	assert.equal(installEmptyEnterInterrupt().original, first.original);
});
