import assert from "node:assert/strict";
import { test } from "node:test";
import { renderGuidance } from "../../procedures.ts";
import { failure, success } from "../../tests/fixtures.ts";
import type { LabDocument, LabEvent, LabTaskEvent } from "../schema.ts";
import { MAX_LAB_EVENTS } from "../schema.ts";
import {
	appendLabEvent,
	developmentGate,
	finalGate,
	labBudget,
	labProcedures,
	labReleaseGate,
	labTaskPlan,
	replayLabDocument,
} from "../state.ts";
import {
	candidate,
	candidateDocument,
	completed,
	config,
	developmentDocument,
	finishedDocument,
	heldOutDocument,
	nextAt,
	push,
	request,
	seededDocument,
	selectedDocument,
	startedDocument,
	stateOf,
	trial,
} from "./fixtures.ts";

function changeTasks(document: LabDocument, change: (task: LabTaskEvent) => LabTaskEvent): LabDocument {
	return { ...document, events: document.events.map((event) => (event.kind === "task" ? change(event) : event)) };
}

test("the frozen production baseline is independent of experimental versions and pending candidates", () => {
	const document = candidateDocument();
	const before = structuredClone(document);
	const state = stateOf(document);
	assert.equal(state.head.id, "root");
	assert.equal(renderGuidance(labProcedures(state)), "");
	assert.equal(state.started.config.baseline.productionVersion, "root");
	const plan = success(labTaskPlan(state, "development", "candidate1"));
	assert.equal(renderGuidance(plan.baseline), "");
	assert.match(renderGuidance(plan.candidate!), /strategy candidate1/);
	assert.equal(
		plan.tasks.some((task) => task.kind === "holdout"),
		false,
	);
	assert.deepEqual(document, before);
	failure(labTaskPlan(state, "development", "unknown"), /Unknown/);
	failure(labTaskPlan(state, "holdout"), /accepted/);
});

test("configuration replacement, duplicate IDs, baseline collisions, and nonmonotonic events fail closed", () => {
	const document = startedDocument();
	failure(appendLabEvent(document, { ...document.events[0], id: "second-start" }), /cannot be changed/);
	failure(appendLabEvent(document, { ...document.events[0] }), /Duplicate/);
	failure(
		appendLabEvent(document, { kind: "finished", id: "early", at: 1, status: "stopped", reason: "Stopped." }),
		/monotonic/,
	);
	const settings = config();
	settings.baseline.procedures = [
		{
			id: "root",
			procedure: {
				behavior: "editing/generated",
				title: "Old",
				trigger: "When appropriate.",
				action: "Do old work.",
				verify: "Run tests.",
				avoid: "Otherwise.",
			},
		},
	];
	failure(replayLabDocument({ ...document, events: [{ ...document.events[0], config: settings }] }), /collide/);
});

test("proposals require complete seed executions and an independent completed researcher request", () => {
	const proposed = candidate();
	failure(appendLabEvent(startedDocument(), { ...proposed.event, at: 1001 }), /seed/);
	const seeds = seededDocument();
	failure(appendLabEvent(seeds, { ...proposed.event, at: nextAt(seeds), requestId: "fake" }), /researcher/);
	const executor = request(seeds, "executor");
	failure(
		appendLabEvent(executor.document, { ...proposed.event, at: nextAt(executor.document), requestId: executor.id }),
		/researcher/,
	);
	failure(
		appendLabEvent(proposed.document, { ...proposed.event, parentVersion: "foreign" }),
		/current experimental parent/,
	);
	failure(appendLabEvent(proposed.document, { ...proposed.event, replaces: "foreign" }), /explicitly replace/);
	const pending = push(proposed.document, proposed.event);
	failure(appendLabEvent(pending, { ...proposed.event, id: "second", at: nextAt(pending) }), /pending candidate/);
});

test("recurrence and attribution cannot be manufactured from repeated failures of one task", () => {
	const proposed = candidate();
	failure(
		appendLabEvent(proposed.document, { ...proposed.event, evidenceIds: ["unknown", "also-unknown"] }),
		/evidence/,
	);
	failure(
		appendLabEvent(proposed.document, {
			...proposed.event,
			evidenceIds: [proposed.event.evidenceIds[0], proposed.event.evidenceIds[0]],
		}),
		/unique/,
	);
	const control = stateOf(proposed.document).tasks.find((task) => task.taskId.startsWith("control"))!;
	failure(
		appendLabEvent(proposed.document, { ...proposed.event, evidenceIds: [proposed.event.evidenceIds[0], control.id] }),
		/failing/,
	);
	const seeds = seededDocument();
	const changed = {
		...seeds,
		events: seeds.events.map(
			(event): LabEvent =>
				event.kind === "task" && event.taskId === "target-1" ? { ...event, taskId: "target-0", repeat: 1 } : event,
		),
	};
	failure(replayLabDocument(changed), /repeat matrix/);
	failure(appendLabEvent(proposed.document, { ...proposed.event, attribution: "UNKNOWN" }), /attribution/);
	failure(
		appendLabEvent(proposed.document, {
			...proposed.event,
			procedure: { ...proposed.event.procedure, behavior: "other/behavior" },
		}),
		/evidence/,
	);
	const second = candidate(selectedDocument(), "candidate2");
	const repeated = stateOf(second.document).tasks.filter(
		(task) => task.phase === "development" && task.arm === "baseline" && task.taskId === "target-0",
	);
	failure(
		appendLabEvent(second.document, { ...second.event, evidenceIds: repeated.slice(0, 2).map((task) => task.id) }),
		/two distinct tasks/,
	);
});

test("task records bind phase, model, repeats, artifacts, and executor requests", () => {
	const full = developmentDocument();
	const last = full.events.at(-1)!;
	assert.equal(last.kind, "task");
	if (last.kind !== "task") return;
	const before = { ...full, events: full.events.slice(0, -1) };
	for (const [event, message] of [
		[{ ...last, model: "test/other" }, /different target model/],
		[{ ...last, taskId: "holdout-4" }, /phase/],
		[{ ...last, baselineVersion: "foreign" }, /parent/],
		[{ ...last, repeat: 3 }, /repeat matrix/],
		[{ ...last, requestIds: [] }, /executor requests/],
		[{ ...last, requestIds: ["foreign"] }, /own completed/],
		[{ ...last, requestIds: stateOf(before).tasks[0]!.requestIds }, /own completed/],
		[
			{ ...last, outcome: { ...completed(), artifacts: [{ path: "hidden-test.mjs", content: "modified" }] } },
			/solution files/,
		],
		[{ ...last, score: 1 }, /score/],
	] as const)
		failure(appendLabEvent(before, event), message);
	failure(appendLabEvent(full, { ...last, id: "duplicate-trial", at: nextAt(full) }), /only once/);
});

test("per-task turn limits and unsuccessful request completions cannot be hidden by a passing verifier", () => {
	const document = developmentDocument();
	const last = document.events.at(-1)!;
	assert.equal(last.kind, "task");
	if (last.kind !== "task") return;
	const before = { ...document, events: document.events.slice(0, -1) };
	const extra1 = request(before, "executor");
	const extra2 = request(extra1.document, "executor");
	failure(
		appendLabEvent(extra2.document, {
			...last,
			at: nextAt(extra2.document),
			requestIds: [...last.requestIds, extra1.id, extra2.id],
		}),
		/turn limit/,
	);
	const failedRequest = {
		...before,
		events: before.events.map(
			(event): LabEvent =>
				event.kind === "request-end" && event.requestId === last.requestIds[0] ? { ...event, status: "failed" } : event,
		),
	};
	failure(appendLabEvent(failedRequest, last), /failed model request/);
});

test("candidate coverage is behavior-specific, not satisfied by unrelated control or holdout labels", () => {
	for (const kind of ["control", "holdout"] as const) {
		const settings = config();
		settings.suite.tasks = settings.suite.tasks.map((task) =>
			task.kind === kind ? { ...task, behavior: "other/behavior" } : task,
		);
		const proposed = candidate(seededDocument(settings));
		failure(appendLabEvent(proposed.document, proposed.event), /negative control, and held-out coverage/);
	}
});

test("selection needs every paired development repeat, all candidate passes, and actual targeted gain", () => {
	const full = developmentDocument();
	assert.deepEqual(developmentGate(stateOf(full), "candidate1"), { eligible: true, reasons: [] });
	const incomplete = { ...full, events: full.events.slice(0, -1) };
	assert.match(developmentGate(stateOf(incomplete), "candidate1").reasons.join(";"), /Incomplete/);
	for (const kind of ["target", "control", "regression"] as const) {
		const failed = changeTasks(full, (task) =>
			task.phase === "development" && task.arm === "candidate" && task.taskId.startsWith(kind) && task.repeat === 1
				? { ...task, outcome: completed(false) }
				: task,
		);
		assert.match(developmentGate(stateOf(failed), "candidate1").reasons.join(";"), new RegExp(kind));
		failure(
			appendLabEvent(failed, {
				id: "select",
				at: nextAt(failed),
				kind: "selection",
				candidateId: "candidate1",
				decision: "accept",
				reason: "I think it works.",
			}),
			/refused/,
		);
	}
	const perfectBaseline = changeTasks(full, (task) =>
		task.phase === "development" && task.arm === "baseline" ? { ...task, outcome: completed() } : task,
	);
	assert.match(developmentGate(stateOf(perfectBaseline), "candidate1").reasons.join(";"), /No measured targeted/);
	const transportError = changeTasks(full, (task) =>
		task.phase === "development" && task.arm === "baseline"
			? { ...task, outcome: { status: "error", failure: "model", message: "Transport failed." } }
			: task,
	);
	assert.match(
		developmentGate(stateOf(transportError), "candidate1").reasons.join(";"),
		/Baseline execution was invalid/,
	);
});

test("accepted iterations preserve ancestry and require explicit replacements; rejected hypotheses remain deduplicated", () => {
	const first = selectedDocument();
	const before = structuredClone(first);
	assert.deepEqual(stateOf(first).head, {
		id: "version1",
		parentVersion: "root",
		candidateId: "candidate1",
		procedureIds: ["candidate1"],
	});
	const second = candidate(first, "candidate2");
	const pending = push(second.document, second.event);
	const rejected = push(pending, {
		kind: "selection",
		id: "reject2",
		at: nextAt(pending),
		candidateId: "candidate2",
		decision: "reject",
		reason: "Rejected narrow theory.",
	});
	assert.equal(stateOf(rejected).head.id, "version1");
	assert.deepEqual(
		stateOf(rejected).selections.map((entry) => entry.decision),
		["accept", "reject"],
	);
	const third = candidate(rejected, "candidate3");
	failure(
		appendLabEvent(third.document, {
			...third.event,
			procedure: { ...second.event.procedure, title: "Cosmetic rename" },
		}),
		/Duplicate/,
	);
	failure(appendLabEvent(third.document, { ...third.event, replaces: null }), /explicitly replace/);
	failure(
		appendLabEvent(rejected, {
			kind: "selection",
			id: "reconsider",
			at: nextAt(rejected),
			candidateId: "candidate2",
			decision: "accept",
			reason: "Changed my mind.",
		}),
		/already decided/,
	);
	failure(labTaskPlan(stateOf(rejected), "development", "candidate2"), /decided/);
	assert.deepEqual(first, before);
});

test("a second retained improvement becomes the next experimental parent without changing the original baseline", () => {
	const second = candidate(selectedDocument(), "candidate2");
	let document = push(second.document, second.event);
	const plan = success(labTaskPlan(stateOf(document), "development", "candidate2"));
	assert.equal(plan.baselineVersion, "version1");
	assert.match(renderGuidance(plan.baseline), /candidate1/);
	assert.match(renderGuidance(plan.candidate!), /candidate2/);
	for (const task of plan.tasks) {
		for (let repeat = 0; repeat < plan.repeats; repeat++) {
			for (const arm of ["baseline", "candidate"] as const)
				document = trial(document, {
					phase: "development",
					candidateId: "candidate2",
					taskId: task.id,
					repeat,
					arm,
					outcome: completed(arm === "candidate" || task.kind !== "target"),
				});
		}
	}
	document = push(document, {
		kind: "selection",
		id: "version2",
		at: nextAt(document),
		candidateId: "candidate2",
		decision: "accept",
		reason: "An incremental paired improvement.",
	});
	const state = stateOf(document);
	assert.deepEqual(
		state.versions.map((version) => [version.id, version.parentVersion]),
		[
			["root", null],
			["version1", "root"],
			["version2", "version1"],
		],
	);
	assert.deepEqual(state.head.procedureIds, ["candidate2"]);
	const holdout = success(labTaskPlan(state, "holdout"));
	assert.equal(holdout.baselineVersion, "root");
	assert.equal(renderGuidance(holdout.baseline), "");
	assert.match(renderGuidance(holdout.candidate!), /candidate2/);
});

test("candidate limits and frozen holdout phase prevent endless research or holdout-driven tuning", () => {
	const settings = config();
	settings.limits.maxCandidates = 1;
	const proposed = candidate(seededDocument(settings));
	const pending = push(proposed.document, proposed.event);
	const rejected = push(pending, {
		kind: "selection",
		id: "reject",
		at: nextAt(pending),
		candidateId: "candidate1",
		decision: "reject",
		reason: "Failed static review.",
	});
	failure(appendLabEvent(rejected, { ...proposed.event, id: "candidate2", at: nextAt(rejected) }), /budget/);
	const selected = selectedDocument();
	const firstHoldout = trial(selected, { phase: "holdout", taskId: "holdout-4" });
	const paid = request(firstHoldout, "executor");
	failure(
		appendLabEvent(paid.document, {
			...proposed.event,
			id: "candidate2",
			at: nextAt(paid.document),
			parentVersion: "version1",
			requestId: paid.id,
		}),
		/freezes/,
	);
	failure(
		appendLabEvent(firstHoldout, {
			kind: "request-start",
			id: "research-holdout",
			at: nextAt(firstHoldout),
			role: "researcher",
			reservedTokens: 512,
		}),
		/unfrozen/,
	);
	failure(labTaskPlan(stateOf(firstHoldout), "holdout", "foreign"), /shortlisted/);
	const recorded = stateOf(firstHoldout).tasks.at(-1)!;
	failure(appendLabEvent(firstHoldout, { ...recorded, id: "retry", at: nextAt(firstHoldout) }), /cannot be retried/);
});

test("final evaluation compares the original baseline with the complete shortlist and needs independent held-out gain", () => {
	const full = heldOutDocument();
	const plan = success(labTaskPlan(stateOf(full), "holdout"));
	assert.equal(plan.baselineVersion, "root");
	assert.equal(plan.candidateId, "candidate1");
	assert.deepEqual(
		plan.tasks.map((task) => task.kind),
		["holdout", "holdout"],
	);
	assert.deepEqual(finalGate(stateOf(full)), { eligible: true, reasons: [] });
	assert.equal(labReleaseGate(stateOf(full)).eligible, false);
	const noGain = changeTasks(full, (task) =>
		task.phase === "holdout" && task.arm === "baseline" ? { ...task, outcome: completed() } : task,
	);
	assert.match(finalGate(stateOf(noGain)).reasons.join(";"), /No measured held-out/);
	const failed = changeTasks(full, (task) =>
		task.phase === "holdout" && task.arm === "candidate" && task.repeat === 2
			? { ...task, outcome: completed(false) }
			: task,
	);
	assert.equal(finalGate(stateOf(failed)).eligible, false);
	failure(
		appendLabEvent(failed, {
			id: "finish",
			at: nextAt(failed),
			kind: "finished",
			status: "completed",
			reason: "Overruled tests.",
		}),
		/refused/,
	);
	const truncated = { ...full, events: full.events.slice(0, -1) };
	assert.match(finalGate(stateOf(truncated)).reasons.join(";"), /Incomplete/);
});

test("finished histories replay deterministically and cannot be reopened or used to release stopped runs", () => {
	const full = finishedDocument();
	const original = structuredClone(full);
	const state = stateOf(full);
	assert.deepEqual(labReleaseGate(state), { eligible: true, reasons: [] });
	assert.deepEqual(stateOf(JSON.parse(JSON.stringify(full))), state);
	failure(
		appendLabEvent(full, { id: "resume", at: nextAt(full), kind: "finished", status: "stopped", reason: "Resume." }),
		/cannot be changed/,
	);
	failure(labTaskPlan(state, "holdout"), /finished/);
	const stopped = push(heldOutDocument(), {
		id: "stop",
		at: nextAt(heldOutDocument()),
		kind: "finished",
		status: "stopped",
		reason: "User declined final release.",
	});
	assert.equal(labReleaseGate(stateOf(stopped)).eligible, false);
	assert.deepEqual(full, original);
});

test("reported budget overshoot and outstanding calls cannot be overruled by passing task results", () => {
	const document = heldOutDocument();
	const lastRequest = document.events.findLast((event) => event.kind === "request-end")!;
	for (const usage of [
		{ tokens: 100_001, costUsd: 0 },
		{ tokens: 100, costUsd: 10.01 },
	]) {
		const overspent = {
			...document,
			events: document.events.map((event) =>
				event.id === lastRequest.id && event.kind === "request-end" ? { ...event, usage } : event,
			),
		};
		const state = stateOf(overspent);
		assert.ok(labBudget(state).tokens >= usage.tokens);
		assert.match(finalGate(state).reasons.join(";"), /exceeded the budget/);
		failure(
			appendLabEvent(overspent, {
				id: "finish",
				at: nextAt(overspent),
				kind: "finished",
				status: "completed",
				reason: "Tests passed despite overspend.",
			}),
			/refused/,
		);
	}
	const outstanding = push(document, {
		id: "pending-request",
		at: nextAt(document),
		kind: "request-start",
		role: "executor",
		reservedTokens: 512,
	});
	assert.match(finalGate(stateOf(outstanding)).reasons.join(";"), /outstanding/);
	failure(
		appendLabEvent(document, {
			id: "late-finish",
			at: 101_001,
			kind: "finished",
			status: "completed",
			reason: "Results arrived after the run deadline.",
		}),
		/wall-time/,
	);
});

test("event capacity is a hard stop, not evidence eviction", () => {
	const document = startedDocument();
	const event = document.events[0]!;
	failure(replayLabDocument({ ...document, events: Array.from({ length: MAX_LAB_EVENTS + 1 }, () => event) }), /2000/);
	const atCapacity = { ...document, events: Array.from({ length: MAX_LAB_EVENTS }, () => event) };
	failure(
		appendLabEvent(atCapacity, { id: "last", at: 1001, kind: "finished", status: "stopped", reason: "Stop." }),
		/capacity/,
	);
});
