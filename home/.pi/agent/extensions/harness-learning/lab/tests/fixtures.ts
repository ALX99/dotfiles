import { proposal, success } from "../../tests/fixtures.ts";
import type { ProcedureEntry } from "../../procedures.ts";
import type { LabCandidate, LabConfig, LabDocument, LabEvent, LabTaskEvent, LabTaskOutcome } from "../schema.ts";
import { appendLabEvent, initialLabDocument, labTaskPlan, replayLabDocument } from "../state.ts";

export function config() {
	return {
		researcherModel: "test/researcher",
		targetModel: "test/executor",
		image: `local/node@sha256:${"a".repeat(64)}`,
		baseline: { productionVersion: "root", procedures: [] as ProcedureEntry[] },
		suite: {
			name: "Synthetic domain-test suite, not a production evaluator",
			tasks: (["target", "target", "control", "regression", "holdout", "holdout"] as const).map((kind, i) => ({
				id: `${kind}-${i}`,
				kind,
				behavior: "editing/generated",
				prompt: `Synthetic ${kind} coding scenario ${i}.`,
				files: [{ path: "src/input.mjs", content: `export const value = ${i};\n` }],
				solutionPaths: ["src/input.mjs"],
				verify: {
					files: [{ path: "test.mjs", content: "import assert from 'node:assert/strict';\nassert.ok(true);\n" }],
					argv: ["node", "/verify/test.mjs"],
				},
			})),
		},
		limits: {
			maxCandidates: 3,
			repeats: 3,
			maxRequests: 100,
			maxOutputTokens: 256,
			maxTotalTokens: 100_000,
			maxReportedCostUsd: 10,
			maxWallTimeMs: 100_000,
			maxRequestTimeMs: 1000,
			maxTaskTimeMs: 10_000,
			maxTurnsPerTask: 2,
		},
	} satisfies LabConfig;
}

export function nextAt(document: LabDocument): number {
	return (document.events.at(-1)?.at ?? 999) + 1;
}

export function stateOf(document: LabDocument) {
	return success(replayLabDocument(document));
}

export function startedDocument(settings: LabConfig = config(), scope = "/repo", runId = "run1"): LabDocument {
	return success(
		appendLabEvent(success(initialLabDocument(scope, runId)), {
			id: "start",
			at: 1000,
			kind: "started",
			config: settings,
		}),
	).document;
}

export function push(document: LabDocument, event: LabEvent): LabDocument {
	return success(appendLabEvent(document, event)).document;
}

export function request(document: LabDocument, role: "researcher" | "executor", tokens = 100, costUsd = 0.001) {
	const id = `request-${document.events.length}`;
	let next = push(document, {
		id,
		at: nextAt(document),
		kind: "request-start",
		role,
		reservedTokens: 512,
	});
	next = push(next, {
		id: `response-${document.events.length}`,
		at: nextAt(next),
		kind: "request-end",
		requestId: id,
		status: "completed",
		usage: { tokens, costUsd },
	});
	return { document: next, id };
}

export function completed(passed = true): LabTaskOutcome {
	return {
		status: "completed",
		artifacts: [{ path: "src/input.mjs", content: "export const value = 1;\n" }],
		verificationExitCode: passed ? 0 : 1,
		verificationOutput: passed ? "ok" : "assertion failed",
	};
}

interface TrialInput {
	readonly phase: LabTaskEvent["phase"];
	readonly taskId: string;
	readonly repeat?: number;
	readonly arm?: LabTaskEvent["arm"];
	readonly candidateId?: string | null;
	readonly outcome?: LabTaskOutcome;
}

export function trial(document: LabDocument, input: TrialInput): LabDocument {
	const plan = success(labTaskPlan(stateOf(document), input.phase, input.candidateId ?? null));
	const paid = request(document, "executor");
	const event: LabTaskEvent = {
		id: `task-${document.events.length}`,
		at: nextAt(paid.document),
		kind: "task",
		phase: input.phase,
		candidateId: plan.candidateId,
		baselineVersion: plan.baselineVersion,
		taskId: input.taskId,
		repeat: input.repeat ?? 0,
		arm: input.arm ?? "baseline",
		model: stateOf(document).started.config.targetModel,
		requestIds: [paid.id],
		trace: "Read authoritative source; retained verifier output follows.",
		outcome: input.outcome ?? completed(),
	};
	return push(paid.document, event);
}

export function seededDocument(settings: LabConfig = config()): LabDocument {
	let document = startedDocument(settings);
	for (const task of settings.suite.tasks.filter((entry) => entry.kind !== "holdout"))
		document = trial(document, { phase: "seed", taskId: task.id, outcome: completed(task.kind !== "target") });
	return document;
}

export function candidate(document = seededDocument(), id = "candidate1") {
	const paid = request(document, "researcher");
	const state = stateOf(paid.document);
	const input: LabCandidate = {
		id,
		at: nextAt(paid.document),
		kind: "candidate",
		parentVersion: state.head.id,
		requestId: paid.id,
		replaces: state.head.procedureIds.at(-1) ?? null,
		procedure: { ...proposal().procedure, action: `Edit source and regenerate; strategy ${id}.` },
		hypothesis: "Source-first editing should address recurring generated-file failures.",
		attribution: "HARNESS_DEFICIENCY",
		evidenceIds: state.tasks
			.filter(
				(task) =>
					task.phase === "seed" && task.outcome.status === "completed" && task.outcome.verificationExitCode !== 0,
			)
			.map((task) => task.id),
	};
	return { document: paid.document, event: input };
}

export function candidateDocument(): LabDocument {
	const pending = candidate();
	return push(pending.document, pending.event);
}

export function developmentDocument(): LabDocument {
	let document = candidateDocument();
	const plan = success(labTaskPlan(stateOf(document), "development", "candidate1"));
	for (const task of plan.tasks) {
		for (let repeat = 0; repeat < plan.repeats; repeat++) {
			for (const arm of ["baseline", "candidate"] as const)
				document = trial(document, {
					phase: "development",
					candidateId: "candidate1",
					taskId: task.id,
					repeat,
					arm,
					outcome: completed(arm === "candidate" || task.kind !== "target"),
				});
		}
	}
	return document;
}

export function selectedDocument(): LabDocument {
	const document = developmentDocument();
	return push(document, {
		id: "version1",
		at: nextAt(document),
		kind: "selection",
		candidateId: "candidate1",
		decision: "accept",
		reason: "Complete paired development gate passed.",
	});
}

export function heldOutDocument(): LabDocument {
	let document = selectedDocument();
	const plan = success(labTaskPlan(stateOf(document), "holdout"));
	for (const [i, task] of plan.tasks.entries()) {
		for (let repeat = 0; repeat < plan.repeats; repeat++) {
			for (const arm of ["baseline", "candidate"] as const)
				document = trial(document, {
					phase: "holdout",
					taskId: task.id,
					repeat,
					arm,
					outcome: completed(arm === "candidate" || i !== 0),
				});
		}
	}
	return document;
}

export function finishedDocument(): LabDocument {
	const document = heldOutDocument();
	return push(document, {
		id: "finish",
		at: nextAt(document),
		kind: "finished",
		status: "completed",
		reason: "Independent final gate passed.",
	});
}
