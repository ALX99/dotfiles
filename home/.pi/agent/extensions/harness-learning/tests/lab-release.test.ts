import assert from "node:assert/strict";
import test from "node:test";
import type { LabDocument } from "../lab/schema.ts";
import { finishedDocument } from "../lab/tests/fixtures.ts";
import { renderGuidance } from "../procedures.ts";
import type { HarnessDocument, LabReleaseEvent } from "../schema.ts";
import {
	activeProcedures,
	appendEvent,
	emptyDocument,
	evaluationPlan,
	labReleasePlan,
	modelProcedures,
	replayDocument,
} from "../state.ts";
import {
	decision,
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

const witness = finishedDocument();
const MODEL = "test/executor";
const empty = () => success(emptyDocument("/repo"));
const release = (lab: LabDocument = witness, parentVersion = "root", id = "release1"): LabReleaseEvent => ({
	id,
	at: 10_000,
	kind: "lab-release",
	parentVersion,
	model: MODEL,
	lab,
	reason: "Reviewed the complete experimental evidence and applicability.",
});

function approved(behavior: string, model: string): HarnessDocument {
	const probes = suite("suite1", behavior);
	return history(
		evidence("e1", "s1", behavior),
		evidence("e2", "s2", behavior),
		proposal("p1", behavior),
		probes,
		{ ...evaluation("eval1", probes), model },
		decision(),
	);
}

function withBaseline(document: HarnessDocument): LabDocument {
	const baseline = modelProcedures(stateOf(document), MODEL).map(({ id, procedure }) => ({ id, procedure }));
	return {
		...witness,
		events: witness.events.map((event) => {
			if (event.kind === "started")
				return {
					...event,
					config: { ...event.config, baseline: { productionVersion: stateOf(document).head.id, procedures: baseline } },
				};
			if (event.kind === "candidate") return { ...event, replaces: baseline[0]?.id ?? null };
			return event;
		}),
	};
}

test("release retains its exact witness, model binding, ancestry, and reversible guidance without fake probe records", () => {
	const before = empty();
	const original = structuredClone(before);
	const next = success(appendEvent(before, release()));
	assert.deepEqual(before, original);
	assert.equal(next.state.head.parentVersion, "root");
	assert.deepEqual(next.state.head.candidateIds, ["release1/lab/candidate1"]);
	assert.equal(next.state.proposals.length, 0);
	assert.equal(next.state.evaluations.length, 0);
	assert.equal(next.state.decisions.length, 0);
	assert.deepEqual(next.state.releases[0]?.lab, witness);
	assert.equal(modelProcedures(next.state, MODEL).length, 1);
	assert.equal(modelProcedures(next.state, "other/model").length, 0);
	assert.deepEqual(success(replayDocument(JSON.parse(JSON.stringify(next.document)))), next.state);
	const rolled = success(
		appendEvent(next.document, {
			id: "rollback1",
			at: 11_000,
			kind: "rollback",
			versionId: "root",
			reason: "Restore empty guidance",
		}),
	);
	assert.equal(renderGuidance(modelProcedures(rolled.state, MODEL)), "");
	const restored = success(
		appendEvent(rolled.document, {
			id: "rollback2",
			at: 12_000,
			kind: "rollback",
			versionId: "release1",
			reason: "Restore reviewed release",
		}),
	);
	assert.equal(
		renderGuidance(modelProcedures(restored.state, MODEL)),
		renderGuidance(modelProcedures(next.state, MODEL)),
	);
	failure(
		appendEvent(rolled.document, { ...release(), id: "again", parentVersion: "rollback1" }),
		/already been released/,
	);
});

test("release refuses a stale production parent, wrong repository/model, mismatched snapshot, or forged schema", () => {
	const state = stateOf(empty());
	failure(appendEvent(empty(), release(witness, "stale")), /current production parent/);
	failure(labReleasePlan(stateOf(approved("other/behavior", "other/model")), witness, MODEL), /parent is stale/);
	failure(labReleasePlan(state, { ...witness, scope: "/different" }, MODEL), /different repository/);
	failure(labReleasePlan(state, witness, "other/model"), /physical target model/);
	failure(labReleasePlan(state, { ...witness, unexpected: true }, MODEL), /unexpected/);
	failure(appendEvent(empty(), { ...release(), scores: { passing: true } }), /scores/);
	const production = approved("editing/generated", MODEL);
	const correct = withBaseline(production);
	assert.ok(success(labReleasePlan(stateOf(production), correct, MODEL)));
	for (const field of ["id", "title", "action"] as const) {
		const changed = {
			...correct,
			events: correct.events.map((event) =>
				event.kind !== "started"
					? event
					: {
							...event,
							config: {
								...event.config,
								baseline: {
									...event.config.baseline,
									procedures: event.config.baseline.procedures.map((entry) =>
										field === "id"
											? { ...entry, id: "forged-id" }
											: { ...entry, procedure: { ...entry.procedure, [field]: "Forged snapshot" } },
									),
								},
							},
						},
			),
		};
		failure(labReleasePlan(stateOf(production), changed, MODEL), /baseline|replace/);
	}
});

test("replay rechecks complete final and development evidence rather than trusting a completed label", () => {
	for (const mutation of [
		(lab: LabDocument) => ({
			...lab,
			events: lab.events.filter((entry) => entry.kind !== "task" || entry.phase !== "holdout"),
		}),
		(lab: LabDocument) => ({
			...lab,
			events: lab.events.map((entry) =>
				entry.kind === "task" &&
				entry.phase === "holdout" &&
				entry.arm === "candidate" &&
				entry.outcome.status === "completed"
					? { ...entry, outcome: { ...entry.outcome, verificationExitCode: 1 } }
					: entry,
			),
		}),
		(lab: LabDocument) => ({
			...lab,
			events: lab.events.map((entry) =>
				entry.kind === "task" &&
				entry.phase === "development" &&
				entry.arm === "candidate" &&
				entry.outcome.status === "completed"
					? { ...entry, outcome: { ...entry.outcome, verificationExitCode: 1 } }
					: entry,
			),
		}),
		(lab: LabDocument) => ({
			...lab,
			events: lab.events.map((entry) =>
				entry.kind === "finished" ? { ...entry, status: "cancelled" as const } : entry,
			),
		}),
		(lab: LabDocument) => ({
			...lab,
			events: lab.events.map((entry) => (entry.kind === "request-end" ? { ...entry, usage: null } : entry)),
		}),
		(lab: LabDocument) => ({
			...lab,
			events: lab.events.map((entry) => (entry.kind === "task" ? { ...entry, model: "other/model" } : entry)),
		}),
	]) {
		const bad = mutation(witness);
		failure(appendEvent(empty(), release(bad)), /witness|release refused/);
	}
	failure(appendEvent(empty(), { ...release(), at: 0 }), /precede/);
});

test("release preserves unrelated model guidance and explicitly replaces only the tested model pool", () => {
	const other = approved("other/behavior", "other/model");
	const added = success(appendEvent(other, release(withBaseline(other), "v1")));
	assert.deepEqual(added.state.head.candidateIds, ["p1", "release1/lab/candidate1"]);
	assert.deepEqual(modelProcedures(added.state, "other/model"), modelProcedures(stateOf(other), "other/model"));
	assert.equal(modelProcedures(added.state, MODEL).length, 1);
	const target = approved("editing/generated", MODEL);
	const replaced = success(appendEvent(target, release(withBaseline(target), "v1")));
	assert.deepEqual(replaced.state.head.candidateIds, ["release1/lab/candidate1"]);
	assert.equal(modelProcedures(stateOf(target), MODEL)[0]?.id, "p1");
	const conflicting = approved("editing/generated", "other/model");
	failure(appendEvent(conflicting, release(withBaseline(conflicting), "v1")), /one procedure per behavior/);
});

test("release participates in normal proposal/replacement gates and makes older pending proposals stale", () => {
	const released = success(appendEvent(pendingHistory(), release()));
	failure(evaluationPlan(released.state, "p1"), /stale/);
	const p = { ...proposal("p2"), parentVersion: "release1", replaces: "release1/lab/candidate1" };
	const proposed = success(appendEvent(released.document, p));
	assert.deepEqual(success(evaluationPlan(proposed.state, "p2")).candidateIds, ["p2"]);
	const evaluated = success(
		appendEvent(proposed.document, {
			...evaluation("eval2"),
			candidateId: "p2",
			parentVersion: "release1",
			model: MODEL,
		}),
	);
	const replaced = success(appendEvent(evaluated.document, { ...decision("v2", "p2"), evaluationId: "eval2" }));
	assert.deepEqual(modelProcedures(replaced.state, MODEL), [p]);
	failure(
		appendEvent(released.document, { ...p, procedure: activeProcedures(released.state)[0]!.procedure }),
		/Duplicate procedure/,
	);
});

test("derived procedure IDs remain reserved in logical history and cannot be reused by later events", () => {
	const next = success(appendEvent(empty(), release()));
	failure(appendEvent(next.document, evidence("release1/lab/candidate1")), /Duplicate history ID/);
	const pending = history(evidence("release1/lab/candidate1"));
	failure(appendEvent(pending, release()), /collide/);
	failure(appendEvent(empty(), release(witness, "root", "x".repeat(200))), /identifier limit/);
});

test("the production pool limit applies to the combined released and preserved model pools", () => {
	let production = empty();
	for (let i = 0; i < 5; i++) {
		const behavior = `other/${i}`;
		const p = {
			...proposal(`p${i}`, behavior),
			parentVersion: stateOf(production).head.id,
			evidenceIds: [`ea${i}`, `eb${i}`],
		};
		const s = suite(`s${i}`, behavior);
		const probes = {
			...s,
			suite: {
				...s.suite,
				cases: [
					...s.suite.cases,
					...Array.from({ length: i }, (_, j) => ({
						...s.suite.cases[2]!,
						id: `reg-${j}`,
						behavior: `other/${j}`,
					})),
				],
			},
		};
		production = history(
			...production.events,
			evidence(`ea${i}`, "s1", behavior),
			evidence(`eb${i}`, "s2", behavior),
			p,
			probes,
			{ ...evaluation(`eval${i}`, probes), candidateId: p.id, parentVersion: p.parentVersion, model: "other/model" },
			{ ...decision(`v${i}`, p.id), evaluationId: `eval${i}` },
		);
	}
	failure(appendEvent(production, release(withBaseline(production), "v4")), /at most 5 procedures/);
});
