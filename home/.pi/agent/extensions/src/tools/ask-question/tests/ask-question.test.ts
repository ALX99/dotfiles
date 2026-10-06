import assert from "node:assert/strict";
import test from "node:test";
import { Result } from "effect";
import { Check } from "typebox/value";

import {
	COMMENT_OPTION,
	getSubmittedChoices,
	makeAskQuestionResult,
	makeQuestionOptions,
	makeResult,
	normalizeAlternatives,
	resolveChoices,
	toggleOptionSelection,
} from "../choices.ts";
import { AskQuestionParamsSchema, prepareAskQuestionArguments, readAskQuestionDetails } from "../schema.ts";

const params = {
	question: "Pick a tool",
	alternatives: [
		{ label: "Fast", description: "Optimized for speed" },
		{ label: "Simple", description: "Easy to maintain" },
	],
};
function required<T>(value: T | undefined): T {
	assert.notEqual(value, undefined);
	if (value === undefined) throw new Error("expected question option");
	return value;
}

test("special actions retain their existing indices and submit selected alternatives with compare or comment", () => {
	const options = makeQuestionOptions(params.alternatives);

	assert.deepEqual(toggleOptionSelection([0], 2, options), [0]);
	assert.deepEqual(getSubmittedChoices([1, 0], 2, options), [
		required(options[0]),
		required(options[1]),
		required(options[2]),
	]);
	assert.deepEqual(getSubmittedChoices([1, 0], 4, options), [
		required(options[0]),
		required(options[1]),
		required(options[4]),
	]);
	assert.deepEqual(getSubmittedChoices([0, 1], 3, options), [required(options[3])]);
	assert.deepEqual(getSubmittedChoices([1, 0], 1, options), [required(options[0]), required(options[1])]);
});

test("alternatives normalize labels and descriptions and reject blank, reserved, or duplicate labels", () => {
	assert.throws(
		() => Result.getOrThrow(normalizeAlternatives([{ label: "  Compare options " }, { label: "Simple" }])),
		/reserved option labels/,
	);
	assert.throws(
		() => Result.getOrThrow(normalizeAlternatives([{ label: "Add comment" }, { label: "Simple" }])),
		/reserved option labels/,
	);
	assert.throws(
		() => Result.getOrThrow(normalizeAlternatives([{ label: " Fast " }, { label: "Fast" }])),
		/must be distinct/,
	);
	assert.throws(
		() => Result.getOrThrow(normalizeAlternatives([{ label: "Fast" }, { label: "   " }])),
		/must not be empty/,
	);
	assert.deepEqual(makeQuestionOptions([{ label: " Fast ", description: " Quick " }, { label: " Simple " }]), [
		{ kind: "alternative", label: "Fast", description: "Quick" },
		{ kind: "alternative", label: "Simple" },
		{ kind: "compare", label: "Compare options" },
		{ kind: "other", label: "Something else" },
		{ kind: "comment", label: COMMENT_OPTION },
	]);
});

test("public schema accepts alternative objects without recommended metadata", () => {
	assert.equal(Check(AskQuestionParamsSchema, { questions: [params] }), true);
	assert.equal(Check(AskQuestionParamsSchema, { questions: [{ ...params, alternatives: ["Fast", "Simple"] }] }), false);
	assert.equal(
		Check(AskQuestionParamsSchema, {
			questions: [{ ...params, alternatives: [{ label: " Fast" }, { label: "Simple" }] }],
		}),
		true,
	);
	assert.equal(
		Check(AskQuestionParamsSchema, {
			questions: [{ ...params, alternatives: [{ label: "Fast", recommended: true }, { label: "Simple" }] }],
		}),
		false,
	);
	assert.equal(
		Check(AskQuestionParamsSchema, {
			questions: [{ ...params, alternatives: [{ label: "Fast", description: " note " }, { label: "Simple" }] }],
		}),
		true,
	);
});

test("legacy preparation converts only string alternatives before strict validation", () => {
	const legacy = {
		questions: [{ question: "Pick", alternatives: ["Fast", { label: "Simple", description: "Clear" }] }],
	};
	const prepared = prepareAskQuestionArguments(legacy);
	assert.deepEqual(prepared, {
		questions: [{ question: "Pick", alternatives: [{ label: "Fast" }, { label: "Simple", description: "Clear" }] }],
	});
	assert.equal(Check(AskQuestionParamsSchema, prepared), true);
	assert.throws(() => prepareAskQuestionArguments({ ...legacy, extra: true }), /no extra fields/u);
	assert.throws(() => prepareAskQuestionArguments("invalid"), /requires 1-3 questions/u);
});

test("comparison records the selected targets but not an answer", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[1]), required(options[2])], undefined);

	assert.match(required(result.content[0]).text, /comparison of: Simple/u);
	assert.match(required(result.content[0]).text, /only these target options/u);
	assert.match(required(result.content[0]).text, /do not treat the comparison as approval/u);
	assert.equal(result.details.answer, null);
	assert.deepEqual(result.details.answers, []);
	assert.equal(result.details.action, "compare");
	assert.deepEqual(result.details.comparisonAlternatives, ["Simple"]);
});

test("comparison with no selected alternatives targets all alternatives", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[2])], undefined);

	assert.deepEqual(result.details.comparisonAlternatives, ["Fast", "Simple"]);
});

test("comments remain separate from selected answers", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(
		params,
		[required(options[0]), required(options[4])],
		undefined,
		"  Prefer a quick path  ",
	);

	assert.equal(
		required(result.content[0]).text,
		"Responder selected: Fast\nResponder comment (qualifies these selections): Prefer a quick path",
	);
	assert.deepEqual(result.details.answers, ["Fast"]);
	assert.equal(result.details.answer, "Fast");
	assert.equal(result.details.comment, "Prefer a quick path");
	assert.equal(result.details.action, null);
});

test("resolveChoices handles a custom answer and trims it", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[3])], "  Something more flexible  ");

	assert.equal(required(result.content[0]).text, "Responder answered (custom): Something more flexible");
	assert.deepEqual(result.details.answers, ["Something more flexible"]);
	assert.equal(result.details.wasCustom, true);
});

test("resolveChoices rejects blank custom answers and cancellation", () => {
	const options = makeQuestionOptions(params.alternatives);
	const blank = resolveChoices(params, [required(options[3])], "   ");
	const cancelled = resolveChoices(params, null, undefined);

	assert.equal(required(blank.content[0]).text, "Responder declined to answer, await further instructions.");
	assert.equal(cancelled.details.answer, null);
	assert.deepEqual(cancelled.details.answers, []);
	assert.equal(cancelled.details.action, null);
});

test("makeResult preserves rich option details while retaining label alternatives for old consumers", () => {
	const result = makeResult(params, "Responder selected: Fast", "Fast", false);

	assert.equal(required(result.content[0]).type, "text");
	assert.deepEqual(result.details.alternatives, ["Fast", "Simple"]);
	assert.deepEqual(result.details.optionDetails, params.alternatives);
	assert.deepEqual(result.details.answers, ["Fast"]);
	assert.equal(result.details.answer, "Fast");
});

test("batch results preserve each answer and format every question for the agent", () => {
	const fast = makeResult(params, "Responder selected: Fast", "Fast", false);
	const simple = makeResult(
		{ question: "Pick a style", alternatives: [{ label: "Minimal" }, { label: "Detailed" }] },
		"Responder selected: Detailed",
		"Detailed",
		false,
	);
	const result = Result.getOrThrow(makeAskQuestionResult([fast, simple]));

	assert.match(required(result.content[0]).text, /Question 1: Pick a tool/u);
	assert.match(required(result.content[0]).text, /Question 2: Pick a style/u);
	assert.deepEqual(
		result.details.questions.map((question) => question.answer),
		["Fast", "Detailed"],
	);
});

test("result details accept old result records and reject invalid additions", () => {
	const response = makeResult(params, "Responder selected: Fast", "Fast", false);
	const result = Result.getOrThrow(makeAskQuestionResult([response]));

	assert.deepEqual(readAskQuestionDetails(result.details), result.details);
	const { status: _status, optionDetails: _optionDetails, ...legacyResponse } = response.details;
	assert.deepEqual(readAskQuestionDetails({ questions: [legacyResponse] }), { questions: [legacyResponse] });
	assert.equal(readAskQuestionDetails({ ...result.details, unexpected: true }), undefined);
	assert.equal(readAskQuestionDetails({ questions: [{ ...response.details, action: "other" }] }), undefined);
});

test("question batches require one to three questions", () => {
	assert.equal(Check(AskQuestionParamsSchema, { questions: [] }), false);
	assert.equal(Check(AskQuestionParamsSchema, { questions: [params, params, params, params] }), false);
});
