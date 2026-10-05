import assert from "node:assert/strict";
import test from "node:test";
import {
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type Theme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createCompactBash, createCompactEdit, createCompactRead } from "../../zooid/compact.ts";
import { patchRenderers } from "../../codex-apply-patch/render.ts";
import { createToolStatus, renderToolDuration, type ToolStatusState } from "../tool-status.ts";

initTheme("dark");

const names = ["bash", "edit", "read", "apply_patch"];

function entry(data: unknown, customType = "tool-duration"): SessionEntry {
	return {
		type: "custom",
		id: "duration-entry",
		parentId: null,
		timestamp: "2026-10-04T00:00:00.000Z",
		customType,
		data,
	};
}

function setup(branch: SessionEntry[] = [], toolNames = names) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const records: SessionEntry[] = [];
	const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(name, handler);
		},
		appendEntry(customType: string, data: unknown) {
			const record = entry(data, customType);
			records.push(record);
			branch.push(record);
		},
	} as unknown as ExtensionAPI;
	const statusFor = createToolStatus(pi, toolNames);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	const start = (id: string, toolName = "bash", parentToolCallId?: string) =>
		emit("tool_execution_start", { toolCallId: id, toolName, parentToolCallId });
	const end = (id: string, toolName = "bash", isError = false) =>
		emit("tool_execution_end", { toolCallId: id, toolName, isError });
	const stateFor = (id: string, state: ToolStatusState = {}) => {
		statusFor(
			{ fg: (_color: string, text: string) => text } as Theme,
			{
				state,
				toolCallId: id,
				isPartial: false,
				isError: false,
			} as Parameters<typeof statusFor>[1],
		);
		return state;
	};
	return { statusFor, records, emit, start, end, stateFor };
}

test("execution events record concurrent success and failure durations once, independently of rendering", (t) => {
	let now = 100;
	t.mock.method(performance, "now", () => now);
	const harness = setup();
	harness.start("first");
	now = 300;
	harness.start("second", "edit");
	now = 650;
	harness.end("second", "edit", true);
	now = 1600;
	harness.end("first");
	harness.end("first");
	assert.deepEqual(
		harness.records.map((record) => record.type === "custom" && record.data),
		[
			{ toolCallId: "second", toolName: "edit", durationMs: 350 },
			{ toolCallId: "first", toolName: "bash", durationMs: 1500 },
		],
	);
	assert.equal(harness.stateFor("first").durationMs, 1500);
	assert.equal(harness.stateFor("second").durationMs, 350);
	assert.equal(harness.stateFor("missing").durationMs, undefined);
	const reopened = setup([...harness.records]);
	assert.equal(reopened.stateFor("first").durationMs, 1500);
	assert.equal(reopened.stateFor("second").durationMs, 350);
});

test("timings follow the active branch and reject malformed, unrelated and unsupported records", () => {
	const branch = [
		entry({ toolCallId: "known", toolName: "bash", durationMs: 1200 }),
		entry({ toolCallId: "negative", toolName: "bash", durationMs: -1 }),
		entry({ toolCallId: "infinite", toolName: "bash", durationMs: Infinity }),
		entry({ toolCallId: "nan", toolName: "bash", durationMs: NaN }),
		entry({ toolCallId: "string", toolName: "bash", durationMs: "1200" }),
		entry({ toolCallId: "", toolName: "bash", durationMs: 1200 }),
		entry({ toolCallId: "missing-field", durationMs: 1200 }),
		entry({ toolCallId: "other-type", toolName: "bash", durationMs: 1200 }, "unrelated"),
		entry({ toolCallId: "other-tool", toolName: "write", durationMs: 1200 }),
	];
	const harness = setup(branch);
	const oldState = harness.stateFor("known");
	assert.equal(oldState.durationMs, 1200);
	for (const id of ["negative", "infinite", "nan", "string", "", "missing-field", "other-type", "other-tool"]) {
		assert.equal(harness.stateFor(id).durationMs, undefined);
	}
	branch.splice(0, branch.length, entry({ toolCallId: "alternate", toolName: "edit", durationMs: 250 }));
	harness.emit("session_tree");
	assert.equal(harness.stateFor("known").durationMs, undefined);
	assert.equal(harness.stateFor("known", oldState).durationMs, undefined);
	assert.equal(harness.stateFor("alternate").durationMs, 250);
	branch.length = 0;
	harness.emit("session_start");
	assert.equal(harness.stateFor("alternate").durationMs, undefined);
});

test("nested calls, other tools and unmatched ends are not persisted; navigation and shutdown clear starts", (t) => {
	t.mock.method(performance, "now", () => 100);
	const harness = setup([], ["apply_patch"]);
	harness.start("bash");
	harness.end("bash");
	harness.start("nested", "apply_patch", "parent");
	harness.end("nested", "apply_patch");
	harness.end("never-started", "apply_patch");
	harness.start("before-tree", "apply_patch");
	harness.emit("session_tree");
	harness.end("before-tree", "apply_patch");
	harness.start("before-shutdown", "apply_patch");
	harness.emit("session_shutdown");
	harness.end("before-shutdown", "apply_patch");
	assert.deepEqual(harness.records, []);
	harness.start("patch", "apply_patch");
	harness.end("patch", "apply_patch");
	assert.equal(harness.records.length, 1);
	assert.equal(harness.stateFor("patch").durationMs, 0);
});

test("duration labels use millisecond, second and minute units with threshold colors", () => {
	const theme = { fg: (color: string, text: string) => `${color}:${text}` } as Theme;
	for (const [durationMs, expected] of [
		[0, "success:0ms"],
		[999.9, "success:999ms"],
		[1000, "success:1s"],
		[9999, "success:9s"],
		[10_000, "warning:10s"],
		[59_999, "warning:59s"],
		[60_000, "error:1m 0s"],
		[65_400, "error:1m 5s"],
	] as const) {
		assert.equal(renderToolDuration(theme, { durationMs }), expected);
	}
	assert.equal(renderToolDuration(theme, {}), undefined);
});

test("all four headers right-align durable timings on repaint, expansion, failures and narrow widths", () => {
	const durationMs = 65_400;
	const harness = setup(names.map((toolName) => entry({ toolCallId: toolName, toolName, durationMs })));
	const renderers: Record<string, ToolRenderers> = {
		bash: createCompactBash(harness.statusFor),
		edit: createCompactEdit(harness.statusFor),
		read: createCompactRead(undefined, harness.statusFor),
		apply_patch: patchRenderers(harness.statusFor) as unknown as ToolRenderers,
	};
	for (const name of names) {
		for (const isError of [false, true]) {
			const renderer = renderers[name]!;
			let renderTheme: Theme | undefined;
			const row = new ToolExecutionComponent(
				name,
				name,
				{
					command: "printf '界界界界界界界界界界界界'\n  printf done",
					path: "src/界界界界界界.ts",
					patch: "*** Begin Patch\n*** Add File: src/界.ts\n+new\n*** End Patch",
				},
				{},
				{
					...renderer,
					renderCall(args, theme, context) {
						renderTheme = theme;
						return renderer.renderCall!(args, theme, context);
					},
				},
				{ requestRender() {} } as TUI,
				process.cwd(),
			);
			row.updateResult({ content: [{ type: "text", text: "result" }], isError });
			for (const expanded of [false, true]) {
				row.setExpanded(expanded);
				for (const width of [1, 8, 12, 30, 100]) {
					row.invalidate();
					const lines = row.render(width);
					assert.ok(
						visibleWidth(lines[1]!) <= width,
						`${name}: ${width}: ${JSON.stringify(lines.map(stripTerminalSequences))}`,
					);
					if (width >= 12) {
						const header = lines[1]!;
						assert.equal(visibleWidth(header), width);
						assert.match(stripTerminalSequences(header), / 1m 5s$/);
						assert.ok(renderTheme);
						assert.ok(header.includes(renderTheme.fg("error", "1m 5s")));
					}
				}
			}
		}
	}
	harness.emit("session_shutdown");
});

test("a live header settles to its execution-event duration and retains it when reopened", (t) => {
	let now = 50;
	t.mock.method(performance, "now", () => now);
	const harness = setup();
	const makeRow = (renderer: ToolRenderers) =>
		new ToolExecutionComponent(
			"bash",
			"live",
			{ command: "sleep 12" },
			{},
			renderer,
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
	const row = makeRow(createCompactBash(harness.statusFor));
	t.after(() => harness.emit("session_shutdown"));
	assert.doesNotMatch(row.render(80).map(stripTerminalSequences).join("\n"), /12s$/);
	harness.start("live");
	row.markExecutionStarted();
	now = 12_550;
	harness.end("live");
	row.updateResult({ content: [{ type: "text", text: "(no output)" }], isError: false });
	const line = stripTerminalSequences(row.render(80)[1]!);
	assert.match(line, /^✓ \$ sleep 12 · no output +12s$/);
	assert.equal(visibleWidth(line), 80);
	row.invalidate();
	assert.equal(stripTerminalSequences(row.render(80)[1]!), line);
	const reopened = setup([...harness.records]);
	const replay = makeRow(createCompactBash(reopened.statusFor));
	replay.updateResult({ content: [{ type: "text", text: "(no output)" }], isError: false });
	assert.equal(stripTerminalSequences(replay.render(80)[1]!), line);
	harness.emit("session_shutdown");
	reopened.emit("session_shutdown");
});
