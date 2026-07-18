import * as assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	aggregateTools,
	aggregateTurns,
	buildDashboardView,
	periodStart,
	startOfDay,
	startOfMonth,
	startOfWeek,
	type DashboardDiagnostics,
	type DashboardViewData,
} from "../aggregate.ts";
import { CostDashboard, DASHBOARD_VIEWPORT_LINES, type CostDashboardTheme } from "../dashboard.ts";
import { parseSessionLine, ToolRecordSchema, type ToolRecord, type TurnRecord } from "../schema.ts";
import { scanUsageRecords } from "../scan.ts";
import { CostTrackerStore, type StoreFileSystem } from "../store.ts";

const now = new Date(2024, 2, 13, 12, 0, 0).getTime();

async function temporaryDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cost-tracker-test-"));
}

function assistantLine(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message",
		timestamp: new Date(now).toISOString(),
		message: {
			role: "assistant",
			model: "provider/model",
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } },
		},
		...overrides,
	});
}

const diagnostics: DashboardDiagnostics = {
	scan: {
		filesFound: 0,
		filesScanned: 0,
		filesSkipped: 0,
		unreadableFiles: 0,
		unreadableDirectories: 0,
		emptyLines: 0,
		acceptedRecords: 0,
		unrelatedRecords: 0,
		malformedRecords: 0,
	},
	storeMessages: [],
};

test("session schemas distinguish unrelated entries from malformed assistant messages", () => {
	assert.equal(parseSessionLine(JSON.stringify({ type: "session" }), "fixture").kind, "unrelated");
	assert.equal(
		parseSessionLine(
			assistantLine({
				message: { role: "assistant", usage: { input: -1 } },
			}),
			"fixture",
		).kind,
		"malformed",
	);
	const currentUsage = parseSessionLine(assistantLine(), "fixture");
	assert.equal(currentUsage.kind, "accepted");
	if (currentUsage.kind === "accepted") {
		assert.deepEqual(currentUsage.record, {
			ts: now,
			model: "provider/model",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 2,
			cacheWriteTokens: 1,
			cost: 0.25,
		});
	}

	for (const reasoning of [0, 7.5]) {
		const parsed = parseSessionLine(
			assistantLine({
				message: {
					role: "assistant",
					model: "provider/model",
					usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning, cost: { total: 0.25 } },
				},
			}),
			"fixture",
		);
		assert.equal(parsed.kind, "accepted", `reasoning=${reasoning} must be accepted`);
	}
	assert.equal(
		parseSessionLine(assistantLine({ message: { role: "assistant", usage: { reasoning: -1 } } }), "fixture").kind,
		"malformed",
	);
	assert.equal(
		parseSessionLine(assistantLine({ message: { role: "assistant", usage: { unexpectedMetric: 1 } } }), "fixture").kind,
		"malformed",
	);
});

test("scanner streams empty, malformed, truncated, unrelated, and nested JSONL files", async (t) => {
	const directory = await temporaryDirectory();
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "empty.jsonl"), "");
	await writeFile(
		join(directory, "mixed.jsonl"),
		[
			assistantLine(),
			"{not-json}",
			JSON.stringify({ type: "session", timestamp: new Date(now).toISOString() }),
			assistantLine({ message: { role: "assistant", usage: { output: Number.NaN } } }),
			'{"type":"message","timestamp":',
		].join("\n"),
	);
	await mkdir(join(directory, "nested"));
	await writeFile(join(directory, "nested", "turn.jsonl"), assistantLine());

	const result = await scanUsageRecords({ sessionsDir: directory, now, concurrency: 2 });
	assert.equal(result.records.length, 2);
	assert.equal(result.diagnostics.filesFound, 3);
	assert.equal(result.diagnostics.filesScanned, 3);
	assert.equal(result.diagnostics.malformedRecords, 3);
	assert.equal(result.diagnostics.unrelatedRecords, 1);
});

test("scanner reports unreadable directories and files instead of treating them as an empty dataset", async (t) => {
	const directory = await temporaryDirectory();
	const blocked = join(directory, "blocked");
	await mkdir(blocked);
	await writeFile(join(blocked, "turn.jsonl"), assistantLine());
	const blockedFile = join(directory, "blocked.jsonl");
	await writeFile(blockedFile, assistantLine());
	await chmod(blocked, 0o000);
	await chmod(blockedFile, 0o000);
	t.after(() => chmod(blocked, 0o700));
	t.after(() => chmod(blockedFile, 0o600));
	t.after(() => rm(directory, { recursive: true, force: true }));

	const result = await scanUsageRecords({ sessionsDir: directory, now });
	assert.ok(result.diagnostics.unreadableDirectories + result.diagnostics.unreadableFiles >= 1);
});

test("aggregation separates models and tools and uses local calendar boundaries", () => {
	const day = startOfDay(now);
	const turns: TurnRecord[] = [
		{
			ts: day,
			model: "one",
			inputTokens: 10,
			outputTokens: 1,
			cacheReadTokens: 2,
			cacheWriteTokens: 3,
			cost: 1,
		},
		{
			ts: day,
			model: "two",
			inputTokens: 20,
			outputTokens: 2,
			cacheReadTokens: 4,
			cacheWriteTokens: 5,
			cost: 2,
		},
	];
	const tools: ToolRecord[] = [
		{ ts: day, toolCounts: { read: 2, bash: 1 } },
		{ ts: day, toolCounts: { read: 3 } },
	];
	const stats = aggregateTurns(turns);
	assert.deepEqual(stats.models.get("one"), { turns: 1, inputTokens: 10, outputTokens: 1, cost: 1 });
	assert.deepEqual(
		[...aggregateTools(tools, day)],
		[
			["read", 5],
			["bash", 1],
		],
	);
	assert.equal(buildDashboardView(turns, tools, now, diagnostics).periods.day.stats.turns, 2);

	const expectedDay = new Date(now);
	expectedDay.setHours(0, 0, 0, 0);
	const expectedWeek = new Date(now);
	expectedWeek.setDate(expectedWeek.getDate() - (expectedWeek.getDay() === 0 ? 6 : expectedWeek.getDay() - 1));
	expectedWeek.setHours(0, 0, 0, 0);
	const expectedMonth = new Date(now);
	expectedMonth.setDate(1);
	expectedMonth.setHours(0, 0, 0, 0);
	assert.equal(periodStart("day", now), expectedDay.getTime());
	assert.equal(startOfWeek(now), expectedWeek.getTime());
	assert.equal(startOfMonth(now), expectedMonth.getTime());
	// Calendar setters, rather than 24-hour arithmetic, preserve local/DST days.
	const dstNoon = new Date(new Date(now).getFullYear(), 2, 10, 12).getTime();
	const dstStart = startOfDay(dstNoon);
	const followingStart = startOfDay(new Date(new Date(dstNoon).getFullYear(), 2, 11, 12).getTime());
	assert.equal(new Date(dstStart).getHours(), 0);
	assert.equal(new Date(followingStart).getHours(), 0);
});

test("aggregation safely retains prototype-looking model and tool names", () => {
	const names = ["__proto__", "constructor", "prototype"];
	const turns = names.map(
		(model, index): TurnRecord => ({
			ts: now,
			model,
			inputTokens: index + 1,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: index + 1,
		}),
	);
	const toolRecord = ToolRecordSchema.parse({
		ts: now,
		toolCounts: JSON.parse('{"__proto__":2,"constructor":3,"prototype":4}'),
	});

	const models = aggregateTurns(turns).models;
	const tools = aggregateTools([toolRecord], now);
	assert.deepEqual(
		names.map((name) => models.get(name)?.turns),
		[1, 1, 1],
	);
	assert.deepEqual(
		names.map((name) => tools.get(name)),
		[2, 3, 4],
	);
	assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
});

const plainTheme: CostDashboardTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function periodData(modelCount: number): DashboardViewData {
	const models = new Map(
		Array.from({ length: modelCount }, (_, index) => [
			`model-${String(index).padStart(2, "0")}`,
			{ turns: 1, inputTokens: 1, outputTokens: 1, cost: index + 1 },
		]),
	);
	const longPeriod = {
		stats: {
			turns: modelCount,
			inputTokens: modelCount,
			outputTokens: modelCount,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: modelCount,
			models,
		},
		tools: new Map(Array.from({ length: modelCount }, (_, index) => [`tool-${index}`, index + 1])),
	};
	const shortPeriod = {
		stats: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
			models: new Map(),
		},
		tools: new Map(),
	};
	return {
		periods: { day: longPeriod, week: shortPeriod, month: shortPeriod },
		diagnostics: {
			scan: {
				...diagnostics.scan,
				filesFound: 4,
				filesScanned: 3,
				filesSkipped: 1,
				acceptedRecords: 12,
				malformedRecords: 2,
				unreadableFiles: 1,
			},
			storeMessages: ["store warning"],
		},
	};
}

test("dashboard keeps controls fixed, slices long content, clamps tabs, and truncates narrow output", () => {
	const renders: number[] = [];
	const dashboard = new CostDashboard(
		periodData(30),
		plainTheme,
		() => renders.push(1),
		() => undefined,
	);
	const initial = dashboard.render(200);
	assert.equal(initial.length, DASHBOARD_VIEWPORT_LINES + 4);
	assert.match(initial[0] ?? "", /\[Day\]/);
	assert.match(initial.at(-2) ?? "", /scroll/);

	for (let index = 0; index < 100; index++) dashboard.handleInput("\x1b[B");
	const scrolled = dashboard.render(200);
	assert.equal(scrolled.length, DASHBOARD_VIEWPORT_LINES + 4);
	assert.match(scrolled[0] ?? "", /\[Day\]/);
	assert.match(scrolled.at(-2) ?? "", /100%/);
	assert.ok(!scrolled.slice(2, 2 + DASHBOARD_VIEWPORT_LINES).some((line) => line.includes("Summary")));

	dashboard.handleInput("\x1b[C");
	const week = dashboard.render(200);
	assert.match(week[0] ?? "", /\[Week\]/);
	assert.match(week.at(-2) ?? "", /tabs  ·  esc close/);
	assert.match(week.join("\n"), /12 accepted · 1 skipped · 2 malformed · 1 unreadable/);
	assert.ok(renders.length > 0);

	const narrow = dashboard.render(12);
	assert.equal(narrow.length, DASHBOARD_VIEWPORT_LINES + 4);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 12));
});

test("store quarantines corrupt and unsupported-version files", async (t) => {
	const directory = await temporaryDirectory();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, "tools.json");
	await writeFile(file, '{"version":2,"records":[]}');

	const loaded = await new CostTrackerStore({ file, now: () => now }).load();
	assert.equal(loaded.records.length, 0);
	assert.equal(loaded.writable, true);
	assert.match(loaded.messages[0] ?? "", /moved aside/);
	assert.equal(
		(await readdir(directory)).some((name) => name.startsWith("tools.json.corrupt-")),
		true,
	);

	await writeFile(file, "{truncated");
	const corrupt = await new CostTrackerStore({ file, now: () => now }).load();
	assert.match(corrupt.messages[0] ?? "", /invalid JSON/);
});

test("store serializes concurrent saves and writes a validated versioned payload", async (t) => {
	const directory = await temporaryDirectory();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, "tools.json");
	const store = new CostTrackerStore({ file, now: () => now });
	await Promise.all([
		store.save([{ ts: now, toolCounts: { read: 1 } }]),
		store.save([{ ts: now, toolCounts: { bash: 2 } }]),
	]);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		version: 1,
		records: [{ ts: now, toolCounts: { bash: 2 } }],
	});
});

test("store leaves the prior file intact when rename fails", async (t) => {
	const directory = await temporaryDirectory();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, "tools.json");
	await writeFile(file, '{"version":1,"records":[]}');
	const failingFs: StoreFileSystem = {
		mkdir,
		readFile,
		writeFile,
		unlink: async () => undefined,
		rename: async () => {
			throw new Error("simulated rename failure");
		},
	};
	const store = new CostTrackerStore({ file, now: () => now, fs: failingFs });
	await assert.rejects(store.save([{ ts: now, toolCounts: { read: 1 } }]), /simulated rename failure/);
	assert.equal(await readFile(file, "utf8"), '{"version":1,"records":[]}');
});
