import assert from "node:assert/strict";
import test, { after } from "node:test";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import titleExtension, { createHerdrLabeler, MOODS, TITLE_STARTUP_DELAY_MS, TITLE_UPDATE_DELAY_MS } from "../title.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function createHarness(mode = "tui") {
	const handlers = new Map<string, Handler>();
	const titles: string[] = [];
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	const ctx = {
		mode,
		cwd: "/Users/dozy/dotfiles",
		ui: { setTitle: (title: string) => titles.push(title) },
	} as unknown as ExtensionContext;
	return { handlers, titles, pi, ctx };
}

const savedHerdrPaneId = process.env.HERDR_PANE_ID;
delete process.env.HERDR_PANE_ID;
after(() => {
	if (savedHerdrPaneId !== undefined) process.env.HERDR_PANE_ID = savedHerdrPaneId;
});

async function withCapturedWrites(fn: () => void | Promise<void>): Promise<string[]> {
	const writes: string[] = [];
	const stdout = process.stdout as unknown as { write: (...args: never[]) => boolean };
	const originalWrite = stdout.write.bind(process.stdout);
	stdout.write = (...args: never[]) => {
		const chunk: unknown = args[0];
		if (typeof chunk === "string") {
			writes.push(chunk);
			if (chunk.startsWith("\x1b]2;") && chunk.endsWith("\x07")) return true;
		}
		return originalWrite(...args);
	};
	try {
		await fn();
	} finally {
		stdout.write = originalWrite;
	}
	return writes;
}

function titleSequence(mood: string): string {
	return `\x1b]2;π ${mood} v${VERSION}\x07`;
}

test("the mood pool is unique and safe for an OSC title", () => {
	assert.equal(MOODS.length, 50);
	assert.equal(new Set(MOODS).size, MOODS.length);
	for (const mood of MOODS) {
		for (const char of mood) {
			const code = char.codePointAt(0) ?? 0;
			assert.ok(code >= 0x20 && code !== 0x7f, `unsafe codepoint U+${code.toString(16)} in ${mood}`);
		}
	}
});

test("a TUI session uses one random title until shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { handlers, pi, ctx } = createHarness();
	const random = Math.random;
	Math.random = () => 0;
	try {
		titleExtension(pi);
		const writes = await withCapturedWrites(() => {
			handlers.get("session_start")!({}, ctx);
			t.mock.timers.tick(TITLE_STARTUP_DELAY_MS);
			handlers.get("session_info_changed")!({}, ctx);
			t.mock.timers.tick(TITLE_UPDATE_DELAY_MS);
			handlers.get("turn_start")!({}, ctx);
			handlers.get("session_shutdown")!({}, ctx);
		});
		assert.deepEqual(writes, [
			titleSequence(MOODS[0]!),
			titleSequence(MOODS[0]!),
			titleSequence(MOODS[0]!),
			"\x1b]2;\x07",
		]);
	} finally {
		Math.random = random;
	}
});

test("a turn or shutdown cancels an obsolete delayed title", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { handlers, pi, ctx } = createHarness();
	const random = Math.random;
	Math.random = () => 0;
	try {
		titleExtension(pi);
		const writes = await withCapturedWrites(() => {
			handlers.get("session_start")!({}, ctx);
			handlers.get("turn_start")!({}, ctx);
			t.mock.timers.tick(TITLE_STARTUP_DELAY_MS);
			handlers.get("session_info_changed")!({}, ctx);
			handlers.get("session_shutdown")!({}, ctx);
			t.mock.timers.tick(TITLE_UPDATE_DELAY_MS);
		});
		assert.deepEqual(writes, [titleSequence(MOODS[0]!), "\x1b]2;\x07"]);
	} finally {
		Math.random = random;
	}
});

test("non-TUI sessions use the extension UI instead of stdout", async () => {
	const { handlers, titles, pi, ctx } = createHarness("rpc");
	titleExtension(pi);
	const writes = await withCapturedWrites(() => {
		handlers.get("session_start")!({}, ctx);
		handlers.get("turn_start")!({}, ctx);
		handlers.get("session_shutdown")!({}, ctx);
	});
	assert.deepEqual(writes, []);
	assert.equal(titles[0]?.startsWith("π "), true);
	assert.equal(titles[0]?.endsWith(` v${VERSION}`), true);
	assert.equal(titles[1], "");
	assert.equal(titles.length, 2);
});

test("herdr labeler renames and clears the pane", () => {
	const calls: string[][] = [];
	const errors: Error[] = [];
	const labeler = createHerdrLabeler(
		"w5:pF6",
		"herdr",
		(_bin, args) => {
			calls.push([...args]);
			return { once: () => {} };
		},
		(error) => errors.push(error),
	);
	labeler.apply(`π (•̀ω•́) v${VERSION}`);
	labeler.clear();
	assert.deepEqual(calls, [
		["pane", "rename", "w5:pF6", `π (•̀ω•́) v${VERSION}`],
		["pane", "rename", "w5:pF6", "--clear"],
	]);
	assert.deepEqual(errors, []);
});
