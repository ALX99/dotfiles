import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
	getSubmittedChoices,
	makeAskQuestionResult,
	makeQuestionOptions,
	makeResult,
	resolveChoices,
	toggleOptionSelection,
	validateAlternatives,
} from "../choices.ts";
import { AskQuestionParamsSchema, readAskQuestionDetails } from "../schema.ts";

const params = { question: "Pick a tool", alternatives: ["Fast", "Simple"] };
function required<T>(value: T | undefined): T {
	assert.notEqual(value, undefined);
	if (value === undefined) throw new Error("expected question option");
	return value;
}

test("special options are submitted alone and alternatives retain selection order", () => {
	const options = makeQuestionOptions(["Fast", "Simple"]);

	assert.deepEqual(toggleOptionSelection([0], 2, options), [0]);
	assert.deepEqual(getSubmittedChoices([1, 0], 2, options), [required(options[2])]);
	assert.deepEqual(getSubmittedChoices([0, 1], 3, options), [required(options[3])]);
	assert.deepEqual(getSubmittedChoices([1, 0], 1, options), [required(options[0]), required(options[1])]);
});

test("alternatives are trimmed and reject blank, reserved, or duplicate labels", () => {
	assert.throws(() => validateAlternatives(["  Compare options ", "Simple"]), /reserved option labels/);
	assert.throws(() => validateAlternatives([" Fast ", "Fast"]), /must be distinct/);
	assert.throws(() => validateAlternatives(["Fast", "   "]), /must not be empty/);
	assert.deepEqual(
		makeQuestionOptions([" Fast ", " Simple "]).map((option) => option.label),
		["Fast", "Simple", "Compare options", "Something else"],
	);
});

test("resolveChoices returns a comparison action instead of an answer", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[2])], undefined);

	assert.match(required(result.content[0]).text, /requested a comparison/);
	assert.equal(result.details.answer, null);
	assert.deepEqual(result.details.answers, []);
	assert.equal(result.details.action, "compare");
});

test("resolveChoices handles a custom answer and trims it", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[3])], "  Something more flexible  ");

	assert.equal(required(result.content[0]).text, "Responder answered (custom): Something more flexible");
	assert.deepEqual(result.details.answers, ["Something more flexible"]);
	assert.equal(result.details.wasCustom, true);
});

test("resolveChoices rejects blank custom answers", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[3])], "   ");

	assert.equal(required(result.content[0]).text, "Responder declined to answer, await further instructions.");
	assert.equal(result.details.answer, null);
});

test("resolveChoices handles a custom answer alongside alternatives", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[0]), required(options[3])], "Something more flexible");

	assert.equal(required(result.content[0]).text, "Responder selected: Fast, Something more flexible");
	assert.deepEqual(result.details.answers, ["Fast", "Something more flexible"]);
	assert.equal(result.details.wasCustom, true);
});

test("resolveChoices handles cancellation", () => {
	const result = resolveChoices(params, null, undefined);

	assert.equal(required(result.content[0]).text, "Responder declined to answer, await further instructions.");
	assert.equal(result.details.answer, null);
	assert.deepEqual(result.details.answers, []);
	assert.equal(result.details.action, null);
});

test("makeResult records trimmed alternatives and multiple selected answers", () => {
	const result = makeResult(
		{ question: "Pick tools", alternatives: [" read ", "write", "bash"] },
		"Responder selected: read, bash",
		["read", "bash"],
		false,
	);

	assert.equal(required(result.content[0]).type, "text");
	assert.equal(required(result.content[0]).text, "Responder selected: read, bash");
	assert.deepEqual(result.details.alternatives, ["read", "write", "bash"]);
	assert.deepEqual(result.details.answers, ["read", "bash"]);
	assert.equal(result.details.answer, "read");
	assert.equal(result.details.wasCustom, false);
	assert.equal(result.details.action, null);
});

test("batch results preserve each answer and format every question for the agent", () => {
	const fast = makeResult(params, "Responder selected: Fast", "Fast", false);
	const simple = makeResult(
		{ question: "Pick a style", alternatives: ["Minimal", "Detailed"] },
		"Responder selected: Detailed",
		"Detailed",
		false,
	);
	const result = makeAskQuestionResult([fast, simple]);

	assert.match(required(result.content[0]).text, /Question 1: Pick a tool/u);
	assert.match(required(result.content[0]).text, /Question 2: Pick a style/u);
	assert.deepEqual(
		result.details.questions.map((question) => question.answer),
		["Fast", "Detailed"],
	);
});

test("result details are narrowed through the strict schema", () => {
	const response = makeResult(params, "Responder selected: Fast", "Fast", false);
	const result = makeAskQuestionResult([response]);

	assert.deepEqual(readAskQuestionDetails(result.details), result.details);
	assert.equal(readAskQuestionDetails({ ...result.details, unexpected: true }), undefined);
	assert.equal(
		readAskQuestionDetails({
			questions: [{ ...response.details, action: "other" }],
		}),
		undefined,
	);
});

test("question batches require one to three questions", () => {
	assert.equal(Check(AskQuestionParamsSchema, { questions: [params] }), true);
	assert.equal(Check(AskQuestionParamsSchema, { questions: [] }), false);
	assert.equal(Check(AskQuestionParamsSchema, { questions: [params, params, params, params] }), false);
});
