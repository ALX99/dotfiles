import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createEditToolDefinition,
	initTheme,
	ToolExecutionComponent,
	type ExtensionContext,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createCompactEdit } from "../compact.ts";
import compact from "../compact.ts";

initTheme("dark");

function setup(path = "src/config.ts") {
	const definition = createCompactEdit();
	const row = new ToolExecutionComponent(
		"edit",
		"edit-test",
		{ path, edits: [{ oldText: "old", newText: "new" }] },
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

const content = [{ type: "text", text: "Successfully replaced 1 block." }];
const diff = "  1 context\n- 2 old\n+ 2 new\n+ 3 extra\n  4 tail";

test("edit replay shows result-derived counts and expands the colored numbered diff", () => {
	const { row, render } = setup();
	assert.deepEqual(render(), ["", "· edit src/config.ts"]);
	row.updateResult({ content, details: { diff, patch: "" }, isError: false });
	assert.deepEqual(render(), ["", "✓ edit src/config.ts · +2 −1"]);
	row.invalidate();
	assert.deepEqual(render(), ["", "✓ edit src/config.ts · +2 −1"]);
	row.setExpanded(true);
	assert.ok(render().join("\n").includes(diff));
	const colored = row.render(100).find((line) => stripTerminalSequences(line).includes("+ 2 new"));
	assert.ok(colored && colored !== stripTerminalSequences(colored));
	row.setExpanded(false);
	assert.equal(render().length, 2);
});

test("edit fallback results do not invent statistics; failures retain full diagnostics on expansion", () => {
	const { row, render } = setup();
	row.updateResult({ content, isError: false });
	assert.deepEqual(render(), ["", "✓ edit src/config.ts · done"]);
	row.setExpanded(true);
	assert.match(render().join("\n"), /Successfully replaced 1 block/);
	row.setExpanded(false);
	const diagnostic = "Context not found\nfirst\nsecond\nfourth diagnostic";
	row.updateResult({ content: [{ type: "text", text: diagnostic }], isError: true });
	assert.deepEqual(render(), ["", "✗ edit src/config.ts · failed", "  Context not found", "  first", "  second"]);
	row.setExpanded(true);
	assert.ok(render().join("\n").includes(diagnostic));
});

test("edit headers and failure excerpts fit narrow terminals and sanitize paths", () => {
	const { row, render } = setup("src/界界\u001b[31m\nconfig.ts");
	row.updateResult({ content: [{ type: "text", text: "界".repeat(120) }], isError: true });
	for (const width of [1, 8, 30, 100]) {
		assert.ok(render(width).every((line) => visibleWidth(line) <= width));
	}
	assert.match(render()[1]!, /src\/界界 config.ts/);
});

test("compact edit delegates native execution, including ctx.cwd, and renders its actual result", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "compact-edit-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "config.ts"), "const timeout = 1000;\n");
	const { row, render, definition } = setup();
	const builtin = createEditToolDefinition(process.cwd());
	for (const key of ["parameters", "description", "promptSnippet", "promptGuidelines", "executionMode"] as const) {
		assert.deepEqual(definition[key], builtin[key]);
	}
	const result = await definition.execute(
		"edit-test",
		{
			path: "config.ts",
			edits: [{ oldText: "1000", newText: "5000" }],
		},
		undefined,
		undefined,
		{ cwd } as ExtensionContext,
	);
	assert.equal(await readFile(join(cwd, "config.ts"), "utf8"), "const timeout = 5000;\n");
	assert.ok(result.details?.patch);
	row.updateResult({ ...result, isError: false });
	assert.deepEqual(render(), ["", "✓ edit src/config.ts · +1 −1"]);
	row.setExpanded(true);
	assert.ok(render().join("\n").includes(result.details.diff));
});

test("registered edit owns independent animation and cleans up with the session", async (t) => {
	let definition: ToolDefinition | undefined;
	const handlers = new Map<string, () => void>();
	compact({
		on(event: string, handler: () => void) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "edit") definition = tool;
		},
	} as ExtensionAPI);
	assert.ok(definition);
	t.after(() => handlers.get("session_shutdown")?.());
	let redraws = 0;
	const makeRow = (id: string) =>
		new ToolExecutionComponent(
			"edit",
			id,
			{ path: `${id}.ts`, edits: [] },
			{},
			definition,
			{
				requestRender() {
					redraws++;
				},
			} as TUI,
			process.cwd(),
		);
	const first = makeRow("first");
	const second = makeRow("second");
	first.markExecutionStarted();
	second.markExecutionStarted();
	const initial = second.render(100)[1];
	first.updateResult({ content, isError: false });
	await t.waitFor(() => assert.notEqual(second.render(100)[1], initial), { interval: 10, timeout: 1000 });
	assert.match(stripTerminalSequences(first.render(100)[1]!), /^✓ edit/);
	handlers.get("session_shutdown")?.();
	const settled = redraws;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(redraws, settled);
});
