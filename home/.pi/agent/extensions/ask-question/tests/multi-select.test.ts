import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionContext,
	KeybindingsManager as AppKeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	TUI_KEYBINDINGS,
	visibleWidth,
	type Component,
	type KeybindingsConfig,
	type TUI,
} from "@earendil-works/pi-tui";

import { makeQuestionOptions } from "../choices.ts";
import { selectMultiple, type MultiSelectUi } from "../multi-select.ts";

class TestAbortSignal extends EventTarget {
	aborted = false;
	addCalls = 0;
	removeCalls = 0;

	override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
		this.addCalls++;
		super.addEventListener(...args);
	}

	override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
		this.removeCalls++;
		super.removeEventListener(...args);
	}

	abort(): void {
		this.aborted = true;
		this.dispatchEvent(new Event("abort"));
	}
}

class UiHarness {
	component: Component | undefined;
	factoryCalls = 0;
	doneCalls = 0;
	requestRenderCalls = 0;
	beforeFactory: (() => void) | undefined;
	readonly ui: MultiSelectUi;

	constructor(bindings: KeybindingsConfig = {}) {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
		this.ui = {
			custom: <T>(factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
				new Promise<T>((resolve) => {
					this.beforeFactory?.();
					this.factoryCalls++;
					const component = factory(
						{ requestRender: () => this.requestRenderCalls++ } as unknown as TUI,
						{ fg: (_color: string, text: string) => text } as unknown as Theme,
						keybindings as unknown as AppKeybindingsManager,
						(value) => {
							this.doneCalls++;
							resolve(value as T);
						},
					);
					if (component instanceof Promise) throw new Error("test factory must be synchronous");
					this.component = component;
				}),
		};
	}

	input(data: string): void {
		this.component?.handleInput?.(data);
	}

	render(width = 100): string[] {
		return this.component?.render(width) ?? [];
	}
}

const options = makeQuestionOptions([{ label: "Fast" }, { label: "Simple" }]);

test("uses injected select keybindings for input and help", async () => {
	const ui = new UiHarness({
		"tui.select.up": "k",
		"tui.select.down": "j",
		"tui.select.confirm": "x",
		"tui.select.cancel": "q",
	});
	const result = selectMultiple("Pick", options, undefined, ui.ui);

	assert.match(ui.render().join("\n"), /k\/j navigate • Space toggle • x submit • q cancel/u);
	ui.input("j");
	ui.input(" ");
	ui.input("x");

	assert.deepEqual(await result, [options[1]]);
	assert.equal(ui.requestRenderCalls, 2);
});

test("cancels through the injected cancel binding and settles only once", async () => {
	const signal = new TestAbortSignal();
	const ui = new UiHarness({ "tui.select.cancel": "q" });
	const result = selectMultiple("Pick", options, signal as unknown as AbortSignal, ui.ui);

	ui.input("q");
	ui.input("q");
	signal.abort();

	assert.equal(await result, null);
	assert.equal(ui.doneCalls, 1);
	assert.equal(signal.addCalls, 1);
	assert.equal(signal.removeCalls, 1);
});

test("returns without creating a component when already aborted", async () => {
	const signal = new TestAbortSignal();
	signal.abort();
	const ui = new UiHarness();

	assert.equal(await selectMultiple("Pick", options, signal as unknown as AbortSignal, ui.ui), null);
	assert.equal(ui.factoryCalls, 0);
	assert.equal(signal.addCalls, 0);
});

test("settles when aborted before the custom factory runs", async () => {
	const signal = new TestAbortSignal();
	const ui = new UiHarness();
	ui.beforeFactory = () => signal.abort();

	assert.equal(await selectMultiple("Pick", options, signal as unknown as AbortSignal, ui.ui), null);
	assert.equal(ui.factoryCalls, 1);
	assert.equal(ui.doneCalls, 1);
	assert.equal(signal.addCalls, 1);
	assert.equal(signal.removeCalls, 1);
});

test("settles when aborted while the selector is active", async () => {
	const signal = new TestAbortSignal();
	const ui = new UiHarness();
	const result = selectMultiple("Pick", options, signal as unknown as AbortSignal, ui.ui);

	signal.abort();

	assert.equal(await result, null);
	assert.equal(ui.doneCalls, 1);
	assert.equal(signal.addCalls, 1);
	assert.equal(signal.removeCalls, 1);
});

test("descriptions wrap beneath labels without exceeding terminal width", async () => {
	const ui = new UiHarness();
	const describedOptions = makeQuestionOptions([
		{ label: "Fast", description: "Recommended: lowest latency with a longer description that should wrap." },
		{ label: "Simple", description: "\x1b[31mFewer dependencies\x1b[0m" },
	]);
	const result = selectMultiple("Pick", describedOptions, undefined, ui.ui);
	const lines = ui.render(32);
	assert.match(lines.join("\n"), /Recommended: lowest/u);
	assert.match(lines.join("\n"), /Fewer dependencies/u);
	assert.ok(lines.every((line) => visibleWidth(line) <= 32));
	assert.ok(lines.every((line) => !line.includes("\x1b")));
	ui.input("\x1b");
	assert.equal(await result, null);
});

test("comparison submits checked alternatives rather than discarding them", async () => {
	const ui = new UiHarness({ "tui.select.down": "j", "tui.select.confirm": "x" });
	const three = makeQuestionOptions([{ label: "A" }, { label: "B" }, { label: "C" }]);
	const result = selectMultiple("Pick", three, undefined, ui.ui);
	for (const key of [" ", "j", "j", " ", "j", "x"]) ui.input(key);
	assert.deepEqual(await result, [three[0], three[2], three[3]]);
});

test("comment action carries checked answers and restored selection remains checked", async () => {
	const ui = new UiHarness({ "tui.select.down": "j", "tui.select.confirm": "x" });
	const result = selectMultiple("Pick", options, undefined, ui.ui, ["Simple"]);
	assert.match(ui.render().join("\n"), /\[x\] Simple/u);
	for (const key of ["j", "j", "j", "j", "x"]) ui.input(key);
	assert.deepEqual(await result, [options[1], options[4]]);
});
