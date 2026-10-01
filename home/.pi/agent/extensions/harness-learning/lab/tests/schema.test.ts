import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { proposal, failure, success } from "../../tests/fixtures.ts";
import { LabConfigSchema, LabProposalSchema, LabSuiteSchema } from "../schema.ts";
import { decodeLabDocument, initialLabDocument, replayLabDocument } from "../state.ts";
import { config, startedDocument } from "./fixtures.ts";

const decodeConfig = Schema.decodeUnknownResult(LabConfigSchema, { onExcessProperty: "error" });
const decodeSuite = Schema.decodeUnknownResult(LabSuiteSchema, { onExcessProperty: "error" });
const decodeProposal = Schema.decodeUnknownResult(LabProposalSchema, { onExcessProperty: "error" });

test("run identity, format, and immutable configuration are Schema-validated", () => {
	const document = startedDocument();
	assert.deepEqual(success(decodeLabDocument(document)), document);
	failure(initialLabDocument("relative", "run1"), /absolute/);
	for (const runId of ["../other", ".", "", "/tmp/run", "a/b", "a\\b"])
		failure(initialLabDocument("/repo", runId), /runId/);
	failure(decodeLabDocument({ ...document, format: 2 }), /1/);
	failure(decodeLabDocument({ ...document, unexpected: true }), /unexpected/);
	failure(replayLabDocument({ ...document, events: [] }), /begin/);
	failure(decodeConfig({ ...config(), codePatch: "eval()" }), /codePatch/);
});

test("only a digest-pinned local-image specification and provider/model identities are accepted", () => {
	for (const image of ["node:26", "node:latest", "node@sha256:abc", `node@sha256:${"A".repeat(64)}`])
		failure(decodeConfig({ ...config(), image }), /image/);
	for (const targetModel of ["executor", "test/", "test/executor model"])
		failure(decodeConfig({ ...config(), targetModel }), /targetModel/);
});

test("request, cost, token, repeat, and nested deadline limits reject unsafe or nonfinite values", () => {
	for (const limits of [
		{ ...config().limits, maxRequests: 0 },
		{ ...config().limits, maxCandidates: 11 },
		{ ...config().limits, repeats: 2 },
		{ ...config().limits, repeats: 6 },
		{ ...config().limits, maxReportedCostUsd: 0 },
		{ ...config().limits, maxReportedCostUsd: Number.NaN },
		{ ...config().limits, maxReportedCostUsd: Number.POSITIVE_INFINITY },
		{ ...config().limits, maxTotalTokens: 128 },
		{ ...config().limits, maxRequestTimeMs: 20_000 },
		{ ...config().limits, maxTaskTimeMs: 200_000 },
		{ ...config().limits, maxTurnsPerTask: 31 },
	])
		failure(decodeConfig({ ...config(), limits }), /limits|nested/);
});

test("baseline pools use the same identity, size, behavior, rendering, and regression rules as production", () => {
	const entry = { id: "old", procedure: proposal().procedure };
	const settings = { ...config(), baseline: { productionVersion: "v0", procedures: [entry] } };
	assert.equal(success(decodeConfig(settings)).baseline.procedures.length, 1);
	failure(decodeConfig({ ...settings, baseline: { ...settings.baseline, procedures: [entry, entry] } }), /unique/);
	failure(
		decodeConfig({
			...settings,
			suite: {
				...settings.suite,
				tasks: settings.suite.tasks.map((task) =>
					task.kind === "regression" ? { ...task, behavior: "other/behavior" } : task,
				),
			},
		}),
		/regression coverage/,
	);
	const large = ["a", "b", "c", "d", "e"].map((id) => ({
		id,
		procedure: {
			behavior: id,
			title: "t".repeat(100),
			trigger: "x".repeat(300),
			action: "y".repeat(700),
			verify: "v".repeat(300),
			avoid: "n".repeat(300),
		},
	}));
	failure(decodeConfig({ ...settings, baseline: { ...settings.baseline, procedures: large } }), /6000/);
});

test("suites require distinct task IDs, recurring targets, controls, regression, and a reserved holdout partition", () => {
	const suite = config().suite;
	for (const kind of ["target", "control", "regression", "holdout"] as const) {
		failure(
			decodeSuite({
				...suite,
				tasks: suite.tasks.map((task) =>
					task.kind === kind ? { ...task, kind: kind === "target" ? "regression" : "target" } : task,
				),
			}),
			new RegExp(kind === "target" ? "target" : kind),
		);
	}
	failure(decodeSuite({ ...suite, tasks: [suite.tasks[0], suite.tasks[0], ...suite.tasks.slice(2)] }), /unique/);
	failure(decodeSuite({ ...suite, tasks: suite.tasks.slice(1) }), /6/);
});

test("fixture, solution, and verifier file paths cannot escape, alias, or collide", () => {
	const settings = config();
	const first = settings.suite.tasks[0]!;
	for (const path of ["/etc/passwd", "../outside", "src/../answer", "./answer", "src\\answer", "a//b", "a\0b"]) {
		failure(
			decodeSuite({
				...settings.suite,
				tasks: [{ ...first, files: [{ path, content: "" }] }, ...settings.suite.tasks.slice(1)],
			}),
			/path|segments/,
		);
	}
	for (const paths of [
		["src", "src/input.mjs"],
		["src/input.mjs", "src/input.mjs"],
	]) {
		failure(
			decodeSuite({ ...settings.suite, tasks: [{ ...first, solutionPaths: paths }, ...settings.suite.tasks.slice(1)] }),
			/unique/,
		);
		failure(
			decodeSuite({
				...settings.suite,
				tasks: [{ ...first, files: paths.map((path) => ({ path, content: "" })) }, ...settings.suite.tasks.slice(1)],
			}),
			/unique/,
		);
	}
	failure(
		decodeSuite({
			...settings.suite,
			tasks: [{ ...first, verify: { ...first.verify, argv: ["sh", "-c", "true"] } }, ...settings.suite.tasks.slice(1)],
		}),
		/verification/,
	);
	failure(
		decodeSuite({
			...settings.suite,
			tasks: [
				{ ...first, verify: { ...first.verify, argv: ["node", "/verify/missing.mjs"] } },
				...settings.suite.tasks.slice(1),
			],
		}),
		/verification/,
	);
});

test("inline text limits account for UTF-8 bytes, not just JavaScript characters", () => {
	const suite = config().suite;
	const first = suite.tasks[0]!;
	const files = Array.from({ length: 5 }, (_, i) => ({ path: `file-${i}`, content: "é".repeat(8192) }));
	failure(decodeSuite({ ...suite, tasks: [{ ...first, files }, ...suite.tasks.slice(1)] }), /UTF-8/);
	failure(
		decodeSuite({
			...suite,
			tasks: [{ ...first, files: [{ path: "a", content: "x".repeat(16_385) }] }, ...suite.tasks.slice(1)],
		}),
		/16384/,
	);
	const largeFiles = Array.from({ length: 4 }, (_, i) => ({ path: `file-${i}.mjs`, content: "x".repeat(16_384) }));
	failure(
		decodeSuite({
			...suite,
			tasks: suite.tasks.map((task) => ({
				...task,
				files: largeFiles,
				verify: { files: largeFiles, argv: ["node", "/verify/file-0.mjs"] },
			})),
		}),
		/suite exceeds its byte capacity/,
	);
});

test("researcher output cannot claim authoritative metadata, scores, or changes to the evaluator", () => {
	const input = {
		parentVersion: "root",
		replaces: null,
		procedure: proposal().procedure,
		hypothesis: "A hypothesis.",
		attribution: "HARNESS_DEFICIENCY",
		evidenceIds: ["task1", "task2"],
	};
	assert.deepEqual(success(decodeProposal(input)), input);
	for (const field of ["id", "at", "requestId", "authorModel", "score", "suite", "limits"])
		failure(decodeProposal({ ...input, [field]: "forged" }), new RegExp(field));
	failure(decodeProposal({ ...input, attribution: "MODEL_LIMITATION" }), /attribution/);
});
