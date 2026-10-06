import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

import { createEditorComposition } from "../editor.ts";

test("composes input and rendering on one session editor without changing Pi's prototype", () => {
	const nativeHandleInput = Object.getOwnPropertyDescriptor(CustomEditor.prototype, "handleInput")?.value;
	const composition = createEditorComposition();
	const input: string[] = [];
	let decorated = false;
	let prepared = false;
	let factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined;
	const context = {
		ui: {
			setEditorComponent(value: typeof factory) {
				factory = value;
			},
		},
	} as unknown as ExtensionContext;

	composition.setInputHandler((_editor, data, original) => {
		input.push(data);
		original(data);
	});
	composition.install(context, {
		beforeRender(editor) {
			prepared = true;
			editor.borderColor = (text) => text;
		},
		render(lines) {
			decorated = true;
			return [...lines, "composed"];
		},
	});

	assert.ok(factory);
	const editor = factory(
		{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
		{ borderColor: (text) => text, selectList: {} } as EditorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.handleInput("x");
	const rendered = editor.render(20);
	assert.equal(rendered[0], "─".repeat(20));
	assert.equal(rendered.at(-1), "composed");

	assert.deepEqual(input, ["x"]);
	assert.equal(prepared, true);
	assert.equal(decorated, true);
	assert.equal(Object.getOwnPropertyDescriptor(CustomEditor.prototype, "handleInput")?.value, nativeHandleInput);
});
