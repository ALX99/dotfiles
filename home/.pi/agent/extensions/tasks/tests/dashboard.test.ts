import * as assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TaskDashboard, type TaskDashboardQueue } from "../dashboard.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("dashboard scrolls full outcomes, clips narrow screens, and closes without writing", () => {
	let closed = false;
	let rows = 30;
	const queues: TaskDashboardQueue[] = [
		{
			id: "q",
			progress: "1 completed",
			tasks: [
				{
					id: "t1",
					title: "Fix parser",
					status: "completed",
					detail: Array.from({ length: 80 }, (_, i) => `Outcome line ${i}`).join("\n"),
				},
				{ id: "t2", title: "Run tests", status: "current", detail: "No outcome yet" },
			],
		},
	];
	const view = new TaskDashboard(
		() => queues,
		theme,
		() => rows,
		() => {},
		() => {
			closed = true;
		},
	);
	assert.match(view.render(80).join("\n"), /No outcome yet/u);
	view.handleInput("\x1b[A");
	const firstPage = view.render(80).filter((line) => /^Outcome line \d+$/u.test(line));
	assert.equal(firstPage[0], "Outcome line 0");
	view.handleInput("\x1b[6~");
	assert.equal(
		view.render(80).find((line) => /^Outcome line \d+$/u.test(line)),
		`Outcome line ${firstPage.length}`,
	);
	view.handleInput("\x1b[F");
	assert.ok(view.render(80).includes("Outcome line 79"));
	view.handleInput("\x1b[H");
	assert.ok(view.render(80).includes("Outcome line 0"));
	rows = 18;
	assert.ok(view.render(20).every((line) => visibleWidth(line) <= 20));
	assert.equal(view.render(20).length, rows);
	const narrowPage = view.render(20).filter((line) => /^Outcome line \d+$/u.test(line));
	view.handleInput("]");
	assert.equal(
		view.render(20).find((line) => /^Outcome line \d+$/u.test(line)),
		`Outcome line ${narrowPage.length}`,
	);
	view.handleInput("[");
	assert.ok(view.render(20).includes("Outcome line 0"));
	assert.ok(view.render(20).some((line) => line.includes("Esc close")));
	view.handleInput("\x1b");
	assert.equal(closed, true);
});

test("dashboard keeps selection by ID when discoveries are inserted and sanitizes terminal text", () => {
	const queue: TaskDashboardQueue = {
		id: "q",
		progress: "0 completed",
		tasks: [
			{ id: "t1", title: "Investigate", status: "current", detail: "Working" },
			{ id: "t2", title: "Test\x1b[2J", status: "pending", detail: "First\nSecond\x1b[31m" },
		],
	};
	const view = new TaskDashboard(
		() => [queue],
		theme,
		() => 30,
		() => {},
		() => {},
	);
	view.render(80);
	view.handleInput("\x1b[B");
	queue.tasks.splice(1, 0, { id: "t3", title: "Fix", status: "pending", detail: "New" });
	const screen = view.render(80).join("\n");
	assert.match(screen, /pending · Test/u);
	assert.match(screen, /First\nSecond/u);
	assert.equal(screen.includes("\x1b"), false);
});

test("panel geometry stays fixed while browsing outcomes and queues", () => {
	const queues: TaskDashboardQueue[] = [
		{
			id: "q",
			progress: "1 completed",
			tasks: [
				{ id: "t1", title: "Short outcome", status: "completed", detail: "Done." },
				{ id: "t2", title: "Long outcome", status: "current", detail: "Detail\n".repeat(80) },
			],
		},
	];
	const view = new TaskDashboard(
		() => queues,
		theme,
		() => 24,
		() => {},
		() => {},
	);
	const initial = view.render(90);
	const separator = initial.findIndex((line) => line.startsWith("─"));
	const assertGeometry = () => {
		const lines = view.render(90);
		assert.equal(lines.length, 24);
		assert.equal(
			lines.findIndex((line) => line.startsWith("─")),
			separator,
		);
		assert.equal(lines[22], "");
		assert.equal(lines[23], initial[23]);
	};
	view.handleInput("\x1b[A");
	assertGeometry();
	queues.push({
		id: "q2",
		progress: "0 completed",
		tasks: [{ id: "t1", title: "Another queue", status: "current", detail: "Working." }],
	});
	view.handleInput("\x1b[C");
	assertGeometry();
	queues.length = 0;
	const empty = view.render(90);
	assert.equal(empty.length, 3);
	assert.equal(empty[2], "Esc close");
});

test("panel sizes to the longest wrapped outcome rather than the selected task", () => {
	const queues: TaskDashboardQueue[] = [
		{
			id: "q",
			progress: "1 completed",
			tasks: [
				{ id: "t1", title: "Short", status: "current", detail: "Done." },
				{ id: "t2", title: "Longer", status: "completed", detail: "a".repeat(120) },
			],
		},
	];
	const view = new TaskDashboard(
		() => queues,
		theme,
		() => 30,
		() => {},
		() => {},
	);
	assert.equal(view.render(60).length, 12);
	view.handleInput("\x1b[B");
	assert.equal(view.render(60).length, 12);
	assert.equal(view.render(20).length, 16);
	queues[0]!.tasks[1]!.detail = "Updated\n".repeat(100);
	assert.equal(view.render(60).length, 30);
});
