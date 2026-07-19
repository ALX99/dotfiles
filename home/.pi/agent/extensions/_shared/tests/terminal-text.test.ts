import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import fc from "fast-check";
import {
	clipTerminalText,
	clipText,
	clipTextAtWord,
	sanitizeTerminalBlock,
	sanitizeTerminalLine,
	sanitizeTerminalText,
} from "../terminal-text.ts";

test("terminal sanitization removes ANSI and controls and handles tabs and line separators", () => {
	const unsafe = "\u001b]0;owned\u0007red\u001b[31m!\u001b[0m\tline\nnext\u2028last\u007f";
	assert.equal(sanitizeTerminalText(unsafe), "red! line next last");
	assert.equal(sanitizeTerminalLine("a\tb\u2028c"), "a    b c");
	assert.equal(sanitizeTerminalBlock("a\tb\u2028c\n\u001b[31md"), "a    b\nc\nd");
});

test("text clipping preserves Unicode code points and uses word boundaries", () => {
	assert.equal(clipText("A😀BC", 3), "A😀…");
	assert.equal(clipTextAtWord("alpha beta gamma", 11), "alpha beta…");
});

test("terminal clipping applies display width after sanitization", () => {
	assert.equal(clipTerminalText("\u001b[31m界界界\u001b[0m", 5), "界界…");
	assert.equal(clipTerminalText("a\tb", 3), "a b");
});

test("terminal sanitization and clipping remain safe for arbitrary Unicode", () => {
	fc.assert(
		fc.property(fc.string(), fc.integer({ min: 0, max: 200 }), (value, width) => {
			const sanitized = sanitizeTerminalText(value);
			assert.equal(sanitizeTerminalText(sanitized), sanitized);
			for (const character of sanitized) {
				const code = character.codePointAt(0)!;
				assert.equal(code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029, false);
			}

			const clipped = clipTerminalText(value, width);
			assert.ok(visibleWidth(clipped) <= width);
			assert.equal(sanitizeTerminalLine(clipped), clipped);
		}),
	);
});
