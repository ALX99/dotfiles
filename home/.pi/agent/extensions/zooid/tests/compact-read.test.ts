import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createReadToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
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

test("read registration retains native execution and metadata", () => {
	const { definition } = setup();
	const builtin = createReadToolDefinition(process.cwd());
	for (const key of ["parameters", "description", "promptSnippet", "promptGuidelines", "executionMode"] as const)
		assert.deepEqual(definition[key], builtin[key]);
	assert.equal(definition.execute.toString(), builtin.execute.toString());
});
