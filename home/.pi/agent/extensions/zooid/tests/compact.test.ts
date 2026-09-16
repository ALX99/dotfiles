import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	createBashToolDefinition,
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import compactBash from "../compact.ts";

initTheme("dark");

function setup(command = "printf hello", requestRender = () => {}) {
	let definition: ToolDefinition | undefined;
	let renderTheme: Theme | undefined;
	const handlers = new Map<string, () => void>();
	compactBash({
		on(event: string, handler: () => void) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition) {
			const renderCall = tool.renderCall!;
			definition = {
				...tool,
				renderCall(args, theme, context) {
					renderTheme = theme;
					return renderCall(args, theme, context);
				},
			};
		},
	} as ExtensionAPI);
	assert.ok(definition);
	const row = new ToolExecutionComponent(
		"bash",
		"call",
		{ command },
		{ showImages: false },
		definition,
		{ requestRender } as TUI,
		process.cwd(),
	);
	const render = (width = 80) => row.render(width).map(stripTerminalSequences);
	return {
		row,
		render,
		definition,
		handlers,
		get theme() {
			assert.ok(renderTheme);
			return renderTheme;
		},
	};
}

function result(text: string, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

test("successful bash output occupies one content line, including after replay and repaint", () => {
	const { row, render } = setup();
	row.updateResult(result("hello\nworld\n"));
	assert.deepEqual(render(), ["", "✓ $ printf hello · 2 lines"]);
	row.invalidate();
	assert.deepEqual(render(), ["", "✓ $ printf hello · 2 lines"]);
	row.updateResult(result("(no output)"));
	assert.deepEqual(render(), ["", "✓ $ printf hello · no output"]);
});

test("pending and streaming calls stay compact until expanded", () => {
	const { row, render } = setup();
	assert.deepEqual(render(), ["", "· $ printf hello"]);
	row.markExecutionStarted();
	assert.deepEqual(render(), ["", "⠛ $ printf hello"]);
	row.updateResult(result("partial output"), true);
	assert.deepEqual(render(), ["", "⠛ $ printf hello · running"]);
	row.setExpanded(true);
	assert.ok(render().some((line) => line.includes("partial output")));
	row.updateResult(result("done"));
	row.setExpanded(false);
	assert.deepEqual(render(), ["", "✓ $ printf hello · 1 line"]);
});

test("commands fit terminal cells while expansion preserves multiline command and output indentation", () => {
	const command = "printf '界界界界界界界界界界界界界界界界'\n  printf done";
	const { row, render } = setup(command);
	row.updateResult(result("  indented output\nlast line"));
	for (const width of [1, 8, 30, 80]) {
		const lines = render(width);
		assert.equal(lines.length, 2);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	row.setExpanded(true);
	assert.match(render().join("\n"), /  printf done/);
	assert.match(render().join("\n"), /  indented output/);
	assert.match(render().join("\n"), /last line/);
});

test("failures show at most three excerpt lines and retain exit, timeout and abort diagnostics", () => {
	for (const diagnostic of ["Command exited with code 1", "Command timed out after 5 seconds", "Command aborted"]) {
		const { row, render } = setup();
		row.updateResult(result(`first\nsecond\nthird\n${"long ".repeat(30)}\n\n${diagnostic}`, true));
		const lines = render(40);
		assert.equal(lines.length, 5);
		assert.match(lines[1]!, /^✗ .*failed$/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
		assert.equal(lines.at(-1), `  ${diagnostic}`);
		row.setExpanded(true);
		assert.ok(render().some((line) => line.trimEnd() === "first"));
	}
});

test("truncated output stays visible in the summary and the full-output locator is expandable", () => {
	const { row, render } = setup();
	row.updateResult({
		...result("tail\nFull output: /tmp/pi-output"),
		details: {
			truncation: { truncated: true, totalLines: 3000 },
			fullOutputPath: "/tmp/pi-output",
		},
	});
	assert.match(render()[1]!, /3000 lines · truncated$/);
	row.setExpanded(true);
	assert.ok(render().some((line) => line.trimEnd() === "Full output: /tmp/pi-output"));
});

test("command titles use theme colors and bold styling in collapsed, narrow and expanded views", () => {
	const { row, render, theme } = setup();
	row.updateResult(result("hello"));
	for (const width of [8, 20, 80]) {
		const line = row.render(width)[1]!;
		assert.ok(line.includes(theme.getFgAnsi("toolTitle")));
		assert.ok(line.includes(theme.fg("toolTitle", theme.bold("$ "))));
		assert.ok(line.includes(theme.fg("success", "✓")));
		assert.ok(visibleWidth(line) <= width);
	}
	assert.ok(row.render(80)[1]!.includes(theme.fg("dim", " · 1 line")));
	row.setExpanded(true);
	assert.ok(row.render(80)[1]!.includes(theme.fg("toolTitle", theme.bold("$ printf hello"))));
	assert.ok(row.render(80).some((line) => line.includes(theme.fg("toolOutput", "hello"))));
	assert.ok(render().some((line) => line.includes("$ printf hello")));
});

test("registration preserves the built-in schema and prompt metadata", () => {
	const { definition } = setup();
	const builtin = createBashToolDefinition(process.cwd());
	assert.equal(definition.name, builtin.name);
	assert.equal(definition.description, builtin.description);
	assert.deepEqual(definition.parameters, builtin.parameters);
	assert.equal(definition.promptSnippet, builtin.promptSnippet);
	assert.deepEqual(definition.promptGuidelines, builtin.promptGuidelines);
});

test("the four-row spinner advances through a complete loop without repeating the boundary frame", async (t) => {
	const frames: string[] = [];
	const { row, render, handlers } = setup("sleep 10", () => {
		frames.push(render()[1]!.split(" ")[0]!);
	});
	t.after(() => handlers.get("session_shutdown")?.());
	row.markExecutionStarted();
	frames.length = 0;
	frames.push(render()[1]!.split(" ")[0]!);
	await t.waitFor(() => assert.ok(frames.length >= 10), { interval: 10, timeout: 3000 });
	row.updateResult(result("done"));
	assert.deepEqual(frames.slice(0, 10), ["⠛", "⠹", "⢸", "⣰", "⣤", "⣆", "⡇", "⠏", "⠛", "⠹"]);
});

test("quiet commands animate before any output, and stop on settlement or session teardown", async (suite) => {
	for (const end of ["success", "error", "session_start", "session_shutdown"]) {
		await suite.test(end, async (t) => {
			let redraws = 0;
			const { row, render, handlers } = setup("sleep 10", () => {
				redraws++;
			});
			t.after(() => handlers.get("session_shutdown")?.());
			row.markExecutionStarted();
			const initial = render()[1];
			const initialRedraws = redraws;
			await t.waitFor(() => assert.ok(redraws > initialRedraws), { interval: 10, timeout: 1000 });
			assert.notEqual(render()[1], initial);
			assert.equal(render().length, 2);
			if (end === "success" || end === "error") row.updateResult(result("done", end === "error"));
			else handlers.get(end)?.();
			const settledRedraws = redraws;
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(redraws, settledRedraws);
		});
	}
});
