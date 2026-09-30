import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createReadToolDefinition,
	initTheme,
	ToolExecutionComponent,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createCompactRead } from "../compact.ts";

initTheme("dark");

function setup(args = { path: "src/config.ts", offset: 10, limit: 20 }) {
	const definition = createCompactRead();
	const row = new ToolExecutionComponent(
		"read",
		"read-test",
		args,
		{},
		definition,
		{ requestRender() {} } as TUI,
		process.cwd(),
	);
	return {
		row,
		definition,
		render: (width = 100) => row.render(width).map((line) => stripTerminalSequences(line).trimEnd()),
	};
}

test("read stays one row and preserves native expanded output across collapse and repaint", () => {
	const { row, render } = setup();
	const output = "const answer = 42;\n\n[5 more lines in file. Use offset=30 to continue.]";
	row.updateResult({ content: [{ type: "text", text: output }], isError: false });
	assert.deepEqual(render(), ["", "✓ read src/config.ts · from 10 · limit 20"]);
	for (let i = 0; i < 2; i++) {
		row.setExpanded(true);
		assert.ok(render().join("\n").includes(output));
		row.setExpanded(false);
		row.invalidate();
		assert.equal(render().length, 2);
	}
});

test("read failures remain visible and fit narrow terminals", () => {
	const { row, render } = setup({ path: "界".repeat(60), offset: 1, limit: 2 });
	const output = "Cannot read file\nfirst\nsecond\nfourth";
	row.updateResult({ content: [{ type: "text", text: output }], isError: true });
	assert.equal(render().length, 5);
	assert.match(render()[1]!, /failed$/);
	for (const width of [1, 8, 30]) assert.ok(render(width).every((line) => visibleWidth(line) <= width));
	row.setExpanded(true);
	assert.ok(render().join("\n").includes(output));
});

test("read displays truncation without counting continuation diagnostics as file lines", () => {
	const { row, render } = setup();
	row.updateResult({
		content: [{ type: "text", text: "excerpt" }],
		details: { truncation: { truncated: true } },
		isError: false,
	});
	assert.match(render()[1]!, /· truncated$/);
	row.updateResult({
		content: [{ type: "text", text: "oversized line" }],
		details: { truncation: { firstLineExceedsLimit: true } },
		isError: false,
	});
	assert.match(render()[1]!, /line exceeds read limit$/);
});

test("compact read retains native metadata and reads requested lines relative to ctx.cwd", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "compact-read-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "config.ts"), "first\nsecond\nthird\nfourth");
	const { definition } = setup();
	const builtin = createReadToolDefinition(process.cwd());
	for (const key of ["parameters", "description", "promptSnippet", "promptGuidelines", "executionMode"] as const)
		assert.deepEqual(definition[key], builtin[key]);
	const execute = (args: { path: string; offset?: number; limit?: number }) =>
		definition.execute("read-test", args, undefined, undefined, { cwd } as ExtensionToolContext);
	const excerpt = await execute({ path: "config.ts", offset: 2, limit: 2 });
	assert.deepEqual(excerpt.content, [
		{ type: "text", text: "second\nthird\n\n[1 more lines in file. Use offset=4 to continue.]" },
	]);
	const remainder = await execute({ path: "config.ts", offset: 4 });
	assert.deepEqual(remainder.content, [{ type: "text", text: "fourth" }]);
	await assert.rejects(execute({ path: "missing.ts" }), { code: "ENOENT" });
});
