import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_SHORTCUTS } from "../model-shortcuts.ts";

test("maps Alt+1/2/3 to Luna, Terra, and Sol", () => {
	assert.deepEqual(MODEL_SHORTCUTS, [
		{ shortcut: "alt+1", provider: "openai-codex", model: "gpt-5.6-luna" },
		{ shortcut: "alt+2", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ shortcut: "alt+3", provider: "openai-codex", model: "gpt-5.6-sol" },
	]);
});
