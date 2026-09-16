import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createApplyPatchTool, registerCodexCompat } from "../index.ts";

initTheme("dark");

const patch = [
	"*** Begin Patch",
	"*** Update File: src/config.ts",
	"*** Move to: src/options.ts",
	"@@",
	" context",
	"-old",
	"+new",
	"*** Add File: src/new.ts",
	"+first",
	"+second",
	"*** Delete File: src/legacy.ts",
	"*** End Patch",
	"",
].join("\n");
const success = {
	content: [{ type: "text", text: "Success. Updated the following files:\nM src/options.ts" }],
	details: { exitCode: 0 },
	isError: false,
};

function setup(
	input = patch,
	definition: ConstructorParameters<typeof ToolExecutionComponent>[4] = createApplyPatchTool(),
	requestRender = () => {},
) {
	const row = new ToolExecutionComponent(
		"apply_patch",
		"patch-test",
		{ patch: input },
		{},
		definition,
		{ requestRender } as TUI,
		process.cwd(),
	);
	return { row, render: (width = 120) => row.render(width).map((line) => stripTerminalSequences(line).trimEnd()) };
}

test("patch collapses to honest input counts and expands operations, colored input and stdout", () => {
	const { row, render } = setup();
	row.updateResult(success);
	assert.deepEqual(render(), ["", "✓ patch · 3 files · patch lines +3 −1 · deletion lines unknown"]);
	row.invalidate();
	assert.equal(render().length, 2);
	row.setExpanded(true);
	const expanded = render().join("\n");
	for (const text of [
		"Patch input (not an applied-file diff)",
		"M src/config.ts",
		"→ src/options.ts",
		"A src/new.ts",
		"D src/legacy.ts",
		patch.trimEnd(),
		"Success. Updated",
	]) {
		assert.ok(expanded.includes(text), text);
	}
	const colored = row.render(120).find((line) => stripTerminalSequences(line).trim() === "+new");
	assert.ok(colored && colored !== stripTerminalSequences(colored));
	row.setExpanded(false);
	assert.equal(render().length, 2);
});

test("single-file patches name the file instead of showing a file count", () => {
	for (const operation of ["Add", "Update", "Delete"]) {
		const input = `*** Begin Patch\n*** ${operation} File: src/config.ts\n*** End Patch`;
		const { row, render } = setup(input);
		row.updateResult(success);
		assert.deepEqual(render(), [
			"",
			`✓ patch · src/config.ts · patch lines +0 −0${operation === "Delete" ? " · deletion lines unknown" : ""}`,
		]);
		row.invalidate();
		assert.match(render()[1]!, /patch · src\/config\.ts/);
	}
	const { row, render } = setup("*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n*** End Patch");
	row.updateResult(success);
	assert.match(render()[1]!, /patch · src\/old\.ts/);
});

test("partial and malformed patch input remains inspectable, without claiming it applied", () => {
	for (const input of ["", "*** Begin Patch\n*** Update File: src/界.ts\n@@\n+partial", "not a patch"]) {
		const { row, render } = setup(input);
		assert.match(render()[1]!, /^· patch/);
		row.setExpanded(true);
		assert.ok(render().join("\n").includes(input));
	}
});

test("patch failure does not claim atomic rejection and retains full diagnostics on expansion", () => {
	const { row, render } = setup();
	const diagnostic = "Context not found in src/config.ts\nfirst\nsecond\nfourth\napply_patch exited with status 1";
	row.updateResult({ content: [{ type: "text", text: diagnostic }], isError: true });
	assert.deepEqual(render(), ["", "✗ patch · failed", "  Context not found in src/config.ts", "  first", "  second"]);
	for (const width of [1, 8, 30, 100]) {
		assert.ok(render(width).every((line) => visibleWidth(line) <= width));
	}
	row.setExpanded(true);
	assert.ok(render().join("\n").includes(diagnostic));
});

test("wide filenames and terminal controls cannot break the collapsed patch row", () => {
	const { row, render } = setup("*** Begin Patch\n*** Add File: 界\u001b[31m.ts\n+\tcode\n*** End Patch");
	row.updateResult(success);
	for (const width of [1, 8, 30, 100]) {
		assert.equal(render(width).length, 2);
		assert.ok(render(width).every((line) => visibleWidth(line) <= width));
	}
	row.setExpanded(true);
	assert.ok(render().join("\n").includes("+    code"));
});

test("registered patch animates without output and stops on completion, error, switch and shutdown", async (suite) => {
	for (const end of ["success", "error", "session_start", "session_shutdown"]) {
		await suite.test(end, async (t) => {
			let definition: ToolDefinition | undefined;
			const handlers = new Map<string, (() => void)[]>();
			registerCodexCompat({
				on(event: string, handler: () => void) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
				},
				registerTool(tool: ToolDefinition) {
					definition = tool;
				},
			} as ExtensionAPI);
			assert.ok(definition);
			// The first start handler owns animation; the other selects model tools.
			t.after(() => handlers.get("session_shutdown")?.[0]?.());
			let redraws = 0;
			const { row, render } = setup(patch, definition, () => {
				redraws++;
			});
			row.markExecutionStarted();
			const initial = render()[1];
			const initialRedraws = redraws;
			await t.waitFor(() => assert.ok(redraws > initialRedraws), { interval: 10, timeout: 1000 });
			assert.notEqual(render()[1], initial);
			if (end === "success" || end === "error") row.updateResult({ ...success, isError: end === "error" });
			else handlers.get(end)?.[0]?.();
			const settled = redraws;
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(redraws, settled);
		});
	}
});
