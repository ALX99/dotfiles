import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import { MODEL_SHORTCUTS, resolveShortcutModel } from "../model-shortcuts.ts";

const luna = MODEL_SHORTCUTS[0];
const free = MODEL_SHORTCUTS.find((shortcut) => shortcut.command === "free");
assert.ok(free, "expected a /free shortcut");

function model(provider: string, id: string): Model<any> {
	return { provider, id } as Model<any>;
}

function context(options: {
	scoped?: ScopedModel[];
	catalogue?: Model<any>[];
}): Pick<ExtensionContext, "modelRegistry" | "scopedModels"> {
	const catalogue = options.catalogue ?? [];
	return {
		scopedModels: options.scoped ?? [],
		modelRegistry: {
			find: (provider: string, id: string) => catalogue.find((m) => m.provider === provider && m.id === id),
		},
	} as unknown as Pick<ExtensionContext, "modelRegistry" | "scopedModels">;
}

test("resolves a shortcut from the session scope and its pattern thinking level", () => {
	const scoped = model(luna.provider, luna.model);
	const resolved = resolveShortcutModel(luna, context({ scoped: [{ model: scoped, thinkingLevel: "low" }] }));

	assert.deepEqual(resolved, { model: scoped, thinkingLevel: "low" });
});

test("resolves the shortcut's own thinking level when the scope sets none", () => {
	const scoped = model(luna.provider, luna.model);
	const resolved = resolveShortcutModel(luna, context({ scoped: [{ model: scoped }] }));

	assert.equal(resolved?.thinkingLevel, luna.thinkingLevel);
});

test("falls back to the full catalogue for a model outside the scope", () => {
	const catalogued = model(free.provider, free.model);
	const resolved = resolveShortcutModel(free, context({ scoped: [], catalogue: [catalogued] }));

	assert.deepEqual(resolved, { model: catalogued, thinkingLevel: free.thinkingLevel });
});

test("prefers the scoped model over an identically referenced catalogue entry", () => {
	const scoped = model(free.provider, free.model);
	const other = { ...model(free.provider, free.model), name: "from catalogue" } as Model<any>;
	const resolved = resolveShortcutModel(free, context({ scoped: [{ model: scoped }], catalogue: [other] }));

	assert.equal(resolved?.model, scoped);
});

test("reports no resolution when the model is in neither the scope nor the catalogue", () => {
	assert.equal(resolveShortcutModel(free, context({ scoped: [], catalogue: [model("other", "x")] })), undefined);
});
