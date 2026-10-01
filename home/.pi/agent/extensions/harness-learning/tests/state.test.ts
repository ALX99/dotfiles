import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { MAX_ACTIVE_PROCEDURES, MAX_EVENTS, MAX_GUIDANCE_CHARS, type HarnessDocument } from "../schema.ts";
import {
	activeProcedures,
	appendEvent,
	decodeHarnessDocument,
	emptyDocument,
	evaluationPlan,
	promotionGate,
	renderGuidance,
	replayDocument,
} from "../state.ts";
import {
	decision,
	evaluatedHistory,
	evaluation,
	evidence,
	failure,
	history,
	pendingHistory,
	proposal,
	stateOf,
	success,
	suite,
} from "./fixtures.ts";

test("an empty scope has no persistent guidance or proposals", () => {
	const state = stateOf(success(emptyDocument("/repo")));
	assert.equal(state.head.id, "root");
	assert.deepEqual(state.versions, [{ id: "root", parentVersion: null, candidateIds: [], restoredFrom: null }]);
	assert.equal(renderGuidance(activeProcedures(state)), "");
	failure(emptyDocument("relative/path"), /absolute/);
});

test("Schema rejects incompatible formats, extra fields, blank guidance, and bounded-field overflow", () => {
	const pending = pendingHistory();
	failure(decodeHarnessDocument({ ...pending, format: 2 }), /1/);
	failure(replayDocument({ ...pending, unexpected: true }), /unexpected/);
	failure(appendEvent(pending, { ...proposal("p2"), unsafeCode: "eval()" }), /unsafeCode/);
	failure(appendEvent(pending, { ...proposal("p2"), procedure: { ...proposal().procedure, action: " " } }), /blank/);
	failure(
		appendEvent(pending, { ...proposal("p2"), procedure: { ...proposal().procedure, trigger: "x".repeat(301) } }),
		/300/,
	);
	failure(appendEvent(pending, { ...evidence("e3", "s3"), at: -1 }), /0/);
	failure(
		appendEvent(pending, { ...evidence("e3", "s3"), evidence: { ...evidence().evidence, attribution: "LLM_SAYS_SO" } }),
		/attribution/,
	);
});

test("replay refuses duplicate IDs, reserved root IDs, and out-of-order references", () => {
	failure(replayDocument({ ...pendingHistory(), events: [evidence(), evidence()] }), /Duplicate/);
	failure(replayDocument({ ...pendingHistory(), events: [evidence("root")] }), /Duplicate/);
	failure(replayDocument({ ...pendingHistory(), events: [proposal()] }), /Evidence must exist/);
	failure(
		appendEvent(pendingHistory(), { kind: "rollback", id: "r1", at: 9, versionId: "unknown", reason: "test" }),
		/Unknown/,
	);
});

test("repeated evidence must refer to distinct sessions, with consistent file identity", () => {
	const first = evidence();
	const second = evidence("e2", "s1");
	const sameSession = history(first, { ...second, evidence: { ...second.evidence, entryId: "entry2" } });
	failure(appendEvent(sameSession, proposal()), /two distinct sessions/);
	failure(appendEvent(history(first), second), /already supplies evidence/);
	failure(
		appendEvent(history(first), { ...evidence("e2", "s2"), evidence: { ...first.evidence, sessionId: "s2" } }),
		/consistently/,
	);
	failure(
		appendEvent(history(first), { ...second, evidence: { ...second.evidence, sessionFile: "/different.jsonl" } }),
		/consistently/,
	);
});

test("proposals require matching evidence and an actionable diagnosis, not a one-off model failure", () => {
	for (const attribution of [
		"MODEL_LIMITATION",
		"TOOL_FAILURE",
		"ENVIRONMENT_FAILURE",
		"EVALUATOR_FAILURE",
		"STOCHASTIC_FAILURE",
		"UNKNOWN",
	] as const) {
		const second = evidence("e2", "s2");
		failure(
			appendEvent(history(evidence(), { ...second, evidence: { ...second.evidence, attribution } }), proposal()),
			/do not authorize/,
		);
	}
	failure(appendEvent(history(evidence(), evidence("e2", "s2", "other/behavior")), proposal()), /match/);
	failure(
		appendEvent(history(evidence(), evidence("e2", "s2")), { ...proposal(), evidenceIds: ["e1", "e1"] }),
		/unique/,
	);
});

test("pending, rejected, and approved candidates are deduplicated without changing trusted guidance", () => {
	const pending = pendingHistory();
	assert.equal(renderGuidance(activeProcedures(stateOf(pending))), "");
	failure(appendEvent(pending, proposal("duplicate")), /Duplicate procedure/);
	const rejected = success(appendEvent(pending, { ...decision(), decision: "reject", evaluationId: null })).document;
	assert.equal(stateOf(rejected).head.id, "root");
	failure(appendEvent(rejected, proposal("duplicate")), /Duplicate procedure/);
	assert.equal(stateOf(rejected).decisions[0]?.reason, decision().reason);
	failure(
		appendEvent(pending, {
			...proposal("renamed"),
			procedure: { ...proposal().procedure, title: "A cosmetic rename" },
		}),
		/Duplicate procedure/,
	);
});

test("evaluation plans require target, negative control, regression, and held-out coverage", () => {
	const withoutSuite = history(evidence(), evidence("e2", "s2"), proposal());
	failure(evaluationPlan(stateOf(withoutSuite), "p1"), /Configure/);
	failure(evaluationPlan(stateOf(pendingHistory()), "unknown"), /Unknown/);
	for (const kind of ["target", "control", "regression", "holdout"] as const) {
		const probes = suite();
		const incomplete = {
			...probes,
			suite: {
				...probes.suite,
				cases: probes.suite.cases.map((probe) =>
					probe.kind === kind
						? { ...probe, kind: kind === "target" ? ("regression" as const) : ("target" as const) }
						: probe,
				),
			},
		};
		failure(evaluationPlan(stateOf(history(...withoutSuite.events, incomplete)), "p1"), new RegExp(kind));
	}
	const plan = success(evaluationPlan(stateOf(pendingHistory()), "p1"));
	assert.equal(plan.baseline.id, "root");
	assert.deepEqual(plan.candidateIds, ["p1"]);
});

test("suites cannot have duplicate cases, duplicate choices, or nonexistent expected choices", () => {
	const probes = suite();
	const first = probes.suite.cases[0]!;
	for (const invalid of [
		{ ...first, choices: [first.choices[0]!, first.choices[0]!] },
		{ ...first, expectedChoice: "nonexistent" },
	]) {
		failure(
			appendEvent(pendingHistory(), {
				...suite("suite2"),
				suite: { ...probes.suite, cases: [invalid, ...probes.suite.cases.slice(1)] },
			}),
			/choices/,
		);
	}
	failure(
		appendEvent(pendingHistory(), {
			...suite("suite2"),
			suite: { ...probes.suite, cases: [first, first, ...probes.suite.cases.slice(2)] },
		}),
		/unique/,
	);
});

test("evaluation records require a complete paired matrix with exactly three repeats", () => {
	const pending = pendingHistory();
	const complete = evaluation();
	const first = complete.pairs[0]!;
	failure(appendEvent(pending, { ...complete, pairs: complete.pairs.slice(1) }), /12/);
	failure(appendEvent(pending, { ...complete, pairs: [first, ...complete.pairs.slice(1, -1), first] }), /exactly one/);
	failure(
		appendEvent(pending, {
			...complete,
			pairs: complete.pairs.map((pair, i) => (i === 0 ? { ...pair, caseId: "unknown" } : pair)),
		}),
		/exactly one/,
	);
	failure(appendEvent(pending, { ...complete, candidateId: "unknown" }), /existing candidate/);
	failure(appendEvent(pending, { ...complete, pairs: [{ ...first, repeat: 3 }, ...complete.pairs.slice(1)] }), /2/);
	failure(
		appendEvent(pending, {
			...complete,
			pairs: [{ ...first, candidateOutput: "x".repeat(2049) }, ...complete.pairs.slice(1)],
		}),
		/2048/,
	);
});

test("promotion requires all candidate repeats to pass and a measurable targeted improvement", () => {
	assert.deepEqual(promotionGate(stateOf(evaluatedHistory()), "p1", "eval1"), { eligible: true, reasons: [] });
	for (const kind of ["target", "control", "regression", "holdout"] as const) {
		const result = evaluation();
		const failed = {
			...result,
			pairs: result.pairs.map((pair) =>
				pair.caseId === kind && pair.repeat === 1 ? { ...pair, candidateOutput: "I think source is right" } : pair,
			),
		};
		const state = stateOf(history(...pendingHistory().events, failed));
		const gate = promotionGate(state, "p1", "eval1");
		assert.equal(gate.eligible, false);
		assert.match(gate.reasons.join(";"), new RegExp(kind));
		failure(appendEvent(history(...pendingHistory().events, failed), decision()), /Promotion refused/);
	}
	const perfectBaseline = evaluation();
	const noGain = {
		...perfectBaseline,
		pairs: perfectBaseline.pairs.map((pair) => ({ ...pair, baselineOutput: pair.candidateOutput })),
	};
	assert.match(
		promotionGate(stateOf(history(...pendingHistory().events, noGain)), "p1", "eval1").reasons.join(";"),
		/No measured improvement/,
	);
	failure(appendEvent(pendingHistory(), decision()), /evaluation/);
	failure(appendEvent(pendingHistory(), { ...decision(), evaluationId: null }), /requires a passing evaluation/);
});

test("the gate scores exact retained output, never a supplied or self-reported score", () => {
	const output = evaluation();
	const padded = {
		...output,
		pairs: output.pairs.map((pair) => ({ ...pair, candidateOutput: `\n${pair.candidateOutput}\n` })),
	};
	assert.equal(promotionGate(stateOf(history(...pendingHistory().events, padded)), "p1", "eval1").eligible, true);
	failure(appendEvent(pendingHistory(), { ...output, score: 1 }), /score/);
});

test("invalid baseline output or transport failure cannot count as evidence of an improvement", () => {
	for (const baselineOutput of ["", "[probe failed: timeout]", "Maybe edit the source"]) {
		const result = evaluation();
		const invalid = { ...result, pairs: result.pairs.map((pair, i) => (i === 0 ? { ...pair, baselineOutput } : pair)) };
		const evaluated = history(...pendingHistory().events, invalid);
		assert.match(promotionGate(stateOf(evaluated), "p1", "eval1").reasons.join(";"), /Baseline.*valid choices/);
		failure(appendEvent(evaluated, decision()), /rerun the evaluation/);
	}
});

test("suite revisions and later failed evaluations invalidate earlier passing results", () => {
	const evaluated = evaluatedHistory();
	const revised = success(appendEvent(evaluated, suite("suite2"))).document;
	assert.match(promotionGate(stateOf(revised), "p1", "eval1").reasons.join(";"), /stale probe suite/);
	failure(appendEvent(revised, decision()), /stale probe suite/);
	const later = success(appendEvent(evaluated, evaluation("eval2"))).document;
	assert.match(promotionGate(stateOf(later), "p1", "eval1").reasons.join(";"), /latest evaluation/);
	assert.equal(promotionGate(stateOf(later), "p1", "eval2").eligible, true);
});

test("approval appends an auditable version, and replay produces exactly the same active guidance", () => {
	const before = evaluatedHistory();
	const original = structuredClone(before);
	const approved = success(appendEvent(before, decision()));
	assert.deepEqual(before, original);
	assert.equal(approved.state.head.id, "v1");
	assert.equal(approved.state.head.parentVersion, "root");
	assert.deepEqual(approved.document.events.slice(0, -1), before.events);
	assert.deepEqual(stateOf(JSON.parse(JSON.stringify(approved.document))), approved.state);
	assert.match(renderGuidance(activeProcedures(approved.state)), /When:.*generated/);
	failure(appendEvent(approved.document, decision("v2")), /already decided/);
});

test("rollback creates a new version, restores guidance exactly, and makes pending candidates stale", () => {
	const approved = success(appendEvent(evaluatedHistory(), decision())).document;
	const candidate = {
		...proposal("p2"),
		parentVersion: "v1",
		replaces: "p1",
		procedure: { ...proposal().procedure, action: "Use the documented generator command." },
	};
	const pending = success(appendEvent(approved, candidate)).document;
	const rolledBack = success(
		appendEvent(pending, { kind: "rollback", id: "r1", at: 6000, versionId: "root", reason: "Restore empty guidance" }),
	);
	assert.equal(renderGuidance(activeProcedures(rolledBack.state)), "");
	assert.deepEqual(rolledBack.state.head, { id: "r1", parentVersion: "v1", candidateIds: [], restoredFrom: "root" });
	assert.equal(rolledBack.state.proposals.length, 2);
	failure(evaluationPlan(rolledBack.state, "p2"), /stale/);
	const restored = success(
		appendEvent(rolledBack.document, {
			kind: "rollback",
			id: "r2",
			at: 7000,
			versionId: "v1",
			reason: "Restore accepted version",
		}),
	);
	assert.equal(renderGuidance(activeProcedures(restored.state)), renderGuidance(activeProcedures(stateOf(approved))));
	failure(
		appendEvent(restored.document, { kind: "rollback", id: "r3", at: 8000, versionId: "r2", reason: "No-op" }),
		/already current/,
	);
});

test("replacement proposals must explicitly name the current procedure; old evaluations cannot bypass ancestry", () => {
	const approved = success(appendEvent(evaluatedHistory(), decision())).document;
	const replacement = {
		...proposal("p2"),
		parentVersion: "v1",
		replaces: "p1",
		procedure: { ...proposal().procedure, action: "Use the documented generator." },
	};
	failure(appendEvent(approved, { ...replacement, replaces: null }), /explicitly replace/);
	failure(appendEvent(approved, { ...replacement, replaces: "unknown" }), /explicitly replace/);
	failure(appendEvent(approved, { ...replacement, parentVersion: "root" }), /current parent/);
	const pending = success(appendEvent(approved, replacement)).document;
	const eval2 = { ...evaluation("eval2"), candidateId: "p2", parentVersion: "v1" };
	const evaluated = success(appendEvent(pending, eval2)).document;
	assert.equal(promotionGate(stateOf(evaluated), "p2", "eval1").eligible, false);
	const next = success(appendEvent(evaluated, { ...decision("v2", "p2"), evaluationId: "eval2" }));
	assert.deepEqual(next.state.head.candidateIds, ["p2"]);
	assert.deepEqual(next.state.versions[1]?.candidateIds, ["p1"]);
});

test("a version change blocks other outstanding candidates and their otherwise-passing evaluations", () => {
	const variant = {
		...proposal("p2"),
		procedure: { ...proposal().procedure, action: "Use the generator instructions from the repository." },
	};
	const pending = history(...pendingHistory().events, variant, evaluation(), {
		...evaluation("eval2"),
		candidateId: "p2",
	});
	const approved = success(appendEvent(pending, decision())).document;
	assert.match(promotionGate(stateOf(approved), "p2", "eval2").reasons.join(";"), /stale/);
	failure(appendEvent(approved, { ...decision("v2", "p2"), evaluationId: "eval2" }), /stale/);
	const rebased = { ...variant, id: "p3", parentVersion: "v1", replaces: "p1" };
	const reProposed = success(appendEvent(approved, rebased));
	assert.equal(success(evaluationPlan(reProposed.state, "p3")).baseline.id, "v1");
	assert.equal(reProposed.state.proposals.length, 3);
	failure(
		appendEvent(approved, { ...proposal("cosmetic"), parentVersion: "v1", replaces: "p1" }),
		/Duplicate procedure/,
	);
});

test("the pool stays small and all previously active behaviors require regression coverage", () => {
	let document = success(emptyDocument("/repo"));
	for (let i = 0; i < MAX_ACTIVE_PROCEDURES; i++) {
		const behavior = `behavior/${i}`;
		const parent = stateOf(document).head.id;
		const candidate = { ...proposal(`p${i}`, behavior), parentVersion: parent, evidenceIds: [`ea${i}`, `eb${i}`] };
		const probes = suite(`suite${i}`, behavior);
		const cases = [
			...probes.suite.cases,
			...Array.from({ length: i }, (_, j) => ({
				...probes.suite.cases[2]!,
				id: `reg${j}`,
				behavior: `behavior/${j}`,
			})),
		];
		document = history(
			...document.events,
			evidence(`ea${i}`, "s1", behavior),
			evidence(`eb${i}`, "s2", behavior),
			candidate,
			{ ...probes, suite: { ...probes.suite, cases } },
		);
		if (i > 0) {
			const incomplete = suite(`incomplete${i}`, behavior);
			failure(
				evaluationPlan(stateOf(history(...document.events, incomplete)), candidate.id),
				/lacks regression coverage/,
			);
		}
		const result = {
			...evaluation(`eval${i}`, { ...probes, suite: { ...probes.suite, cases } }),
			candidateId: candidate.id,
			parentVersion: parent,
		};
		document = history(...document.events, result, { ...decision(`v${i}`, candidate.id), evaluationId: result.id });
	}
	assert.equal(activeProcedures(stateOf(document)).length, MAX_ACTIVE_PROCEDURES);
	assert.ok(renderGuidance(activeProcedures(stateOf(document))).length <= MAX_GUIDANCE_CHARS);
	const behavior = "behavior/extra";
	const withEvidence = history(
		...document.events,
		evidence("extra1", "s1", behavior),
		evidence("extra2", "s2", behavior),
	);
	failure(
		appendEvent(withEvidence, {
			...proposal("extra", behavior),
			parentVersion: stateOf(document).head.id,
			evidenceIds: ["extra1", "extra2"],
		}),
		/bounded/,
	);
});

test("character budget is enforced independently of procedure count", () => {
	let document = success(emptyDocument("/repo"));
	for (let i = 0; i < 4; i++) {
		const behavior = `behavior/${i}`;
		const parentVersion = stateOf(document).head.id;
		const candidate = {
			...proposal(`p${i}`, behavior),
			parentVersion,
			evidenceIds: [`ea${i}`, `eb${i}`],
			procedure: {
				behavior,
				title: `Title ${i}`,
				trigger: "t".repeat(300),
				action: "a".repeat(700),
				verify: "v".repeat(300),
				avoid: "n".repeat(300),
			},
		};
		document = history(...document.events, evidence(`ea${i}`, "s1", behavior), evidence(`eb${i}`, "s2", behavior));
		if (i === 3) {
			failure(appendEvent(document, candidate), /bounded/);
			break;
		}
		const probes = suite(`suite${i}`, behavior);
		const covered = {
			...probes,
			suite: {
				...probes.suite,
				cases: [
					...probes.suite.cases,
					...Array.from({ length: i }, (_, j) => ({
						...probes.suite.cases[2]!,
						id: `reg${j}`,
						behavior: `behavior/${j}`,
					})),
				],
			},
		};
		const result = { ...evaluation(`eval${i}`, covered), parentVersion, candidateId: candidate.id };
		document = history(...document.events, candidate, covered, result, {
			...decision(`v${i}`, candidate.id),
			evaluationId: result.id,
		});
	}
});

test("history capacity refuses additional writes rather than discarding evidence", () => {
	const events = Array.from({ length: MAX_EVENTS }, (_, i) => evidence(`e${i}`, `s${i}`));
	const document: HarnessDocument = { format: 1, scope: "/repo", events };
	assert.ok(Result.isSuccess(replayDocument(document)));
	failure(appendEvent(document, evidence("last", "last")), /capacity/);
	failure(replayDocument({ ...document, events: [...events, evidence("last", "last")] }), /1000/);
});
