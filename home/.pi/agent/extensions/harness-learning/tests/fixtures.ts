import assert from "node:assert/strict";
import { Result } from "effect";
import {
	EVALUATION_REPEATS,
	type EvidenceEvent,
	type HarnessDocument,
	type HarnessEvent,
	type ProposalEvent,
	type SuiteEvent,
	type EvaluationEvent,
	type DecisionEvent,
} from "../schema.ts";
import { appendEvent, emptyDocument, replayDocument } from "../state.ts";

export function success<A, E extends { readonly message: string }>(result: Result.Result<A, E>): A {
	assert.ok(Result.isSuccess(result), Result.isFailure(result) ? result.failure.message : "");
	return result.success;
}

export function failure<A, E extends { readonly message: string }>(result: Result.Result<A, E>, message: RegExp): void {
	assert.ok(Result.isFailure(result), "Expected a rejected operation");
	assert.match(result.failure.message, message);
}

export function evidence(id = "e1", sessionId = "s1", behavior = "editing/generated"): EvidenceEvent {
	return {
		kind: "evidence",
		id,
		at: 1000,
		evidence: {
			sessionId,
			sessionFile: `/sessions/${sessionId}.jsonl`,
			entryId: "entry1",
			quote: "The generated output was edited instead of the source.",
			behavior,
			attribution: "HARNESS_DEFICIENCY",
		},
	};
}

export function proposal(id = "p1", behavior = "editing/generated"): ProposalEvent {
	return {
		kind: "proposal",
		id,
		at: 2000,
		parentVersion: "root",
		replaces: null,
		procedure: {
			behavior,
			title: "Edit generator inputs",
			trigger: "The requested change affects generated files.",
			action: "Edit the generator input, then regenerate the output.",
			verify: "Run the generator twice and confirm the second run has no diff.",
			avoid: "The file is maintained by hand.",
		},
		hypothesis: "Source-first edits avoid overwritten fixes.",
		evidenceIds: ["e1", "e2"],
		authorModel: "test/model",
	};
}

export function suite(id = "suite1", behavior = "editing/generated"): SuiteEvent {
	return {
		kind: "suite",
		id,
		at: 3000,
		suite: {
			name: "Source-first decisions",
			cases: (["target", "control", "regression", "holdout"] as const).map((kind) => ({
				id: kind,
				kind,
				behavior,
				prompt:
					kind === "control"
						? "A handwritten file needs editing. What should you edit?"
						: "A generator input and generated output need changing. What should you edit?",
				choices: [
					{ id: "source", text: "Edit the source." },
					{ id: "output", text: "Edit the output." },
				],
				expectedChoice: kind === "control" ? "output" : "source",
			})),
		},
	};
}

export function evaluation(id = "eval1", probes = suite()): EvaluationEvent {
	return {
		kind: "evaluation",
		id,
		at: 4000,
		candidateId: "p1",
		parentVersion: "root",
		suiteId: probes.id,
		model: "test/model",
		pairs: probes.suite.cases.flatMap((probe) =>
			Array.from({ length: EVALUATION_REPEATS }, (_, repeat) => ({
				caseId: probe.id,
				repeat,
				baselineOutput: probe.kind === "target" ? "output" : probe.expectedChoice,
				candidateOutput: probe.expectedChoice,
			})),
		),
	};
}

export function decision(id = "v1", candidateId = "p1"): DecisionEvent {
	return {
		kind: "decision",
		id,
		at: 5000,
		candidateId,
		decision: "approve",
		evaluationId: "eval1",
		reason: "Probe gate passed; reviewed the procedure.",
	};
}

export function history(...events: readonly HarnessEvent[]): HarnessDocument {
	let document = success(emptyDocument("/repo"));
	for (const event of events) document = success(appendEvent(document, event)).document;
	return document;
}

export function pendingHistory(): HarnessDocument {
	return history(evidence(), evidence("e2", "s2"), proposal(), suite());
}

export function evaluatedHistory(): HarnessDocument {
	return history(...pendingHistory().events, evaluation());
}

export function stateOf(document: HarnessDocument) {
	return success(replayDocument(document));
}
