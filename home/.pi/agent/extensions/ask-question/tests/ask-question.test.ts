import assert from "node:assert/strict";
import test from "node:test";

import {
	getOptionColor,
	getSubmittedChoices,
	makeOptionLabel,
	makeQuestionOptions,
	makeResult,
	resolveChoices,
	toggleOptionSelection,
	validateAlternatives,
} from "../choices.ts";
import { once, selectMultiple, type MultiSelectUi } from "../multi-select.ts";
import { readAskQuestionDetails } from "../schema.ts";

const params = { question: "Pick a tool", alternatives: ["Fast", "Simple"] };
type MultiSelectFactory = Parameters<MultiSelectUi["custom"]>[0];

function required<T>(value: T | undefined): T {
	assert.notEqual(value, undefined);
	if (value === undefined) throw new Error("expected question option");
	return value;
}

test("makeOptionLabel returns plain text without embedded ANSI", () => {
	const options = makeQuestionOptions(["Fast", "Simple"]);

	assert.equal(makeOptionLabel(true, required(options[0])), "[x] Fast");
	assert.equal(makeOptionLabel(false, required(options[0])), "[ ] Fast");
	assert.equal(makeOptionLabel(false, required(options[2])), "Compare options");
	assert.equal(makeOptionLabel(false, required(options[3])), "Something else");
});

test("special options use the same colors as normal options", () => {
	assert.equal(getOptionColor(false), "text");
	assert.equal(getOptionColor(true), "accent");
});

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

	assert.equal(required(result.content[0]).text, "User answered (custom): Something more flexible");
	assert.deepEqual(result.details.answers, ["Something more flexible"]);
	assert.equal(result.details.wasCustom, true);
});

test("resolveChoices rejects blank custom answers", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[3])], "   ");

	assert.equal(required(result.content[0]).text, "User declined to answer, await further instructions.");
	assert.equal(result.details.answer, null);
});

test("resolveChoices handles a custom answer alongside alternatives", () => {
	const options = makeQuestionOptions(params.alternatives);
	const result = resolveChoices(params, [required(options[0]), required(options[3])], "Something more flexible");

	assert.equal(required(result.content[0]).text, "User selected: Fast, Something more flexible");
	assert.deepEqual(result.details.answers, ["Fast", "Something more flexible"]);
	assert.equal(result.details.wasCustom, true);
});

test("resolveChoices handles cancellation", () => {
	const result = resolveChoices(params, null, undefined);

	assert.equal(required(result.content[0]).text, "User declined to answer, await further instructions.");
	assert.equal(result.details.answer, null);
	assert.deepEqual(result.details.answers, []);
	assert.equal(result.details.action, null);
});

test("makeResult records trimmed alternatives and multiple selected answers", () => {
	const result = makeResult(
		{ question: "Pick tools", alternatives: [" read ", "write", "bash"] },
		"User selected: read, bash",
		["read", "bash"],
		false,
	);

	assert.equal(required(result.content[0]).type, "text");
	assert.equal(required(result.content[0]).text, "User selected: read, bash");
	assert.deepEqual(result.details.alternatives, ["read", "write", "bash"]);
	assert.deepEqual(result.details.answers, ["read", "bash"]);
	assert.equal(result.details.answer, "read");
	assert.equal(result.details.wasCustom, false);
	assert.equal(result.details.action, null);
});

test("result details are narrowed through the strict schema", () => {
	const result = makeResult(params, "User selected: Fast", "Fast", false);

	assert.deepEqual(readAskQuestionDetails(result.details), result.details);
	assert.equal(readAskQuestionDetails({ ...result.details, unexpected: true }), undefined);
	assert.equal(readAskQuestionDetails({ ...result.details, action: "other" }), undefined);
});

test("selectMultiple does not open UI for an already-aborted signal", async () => {
	const controller = new AbortController();
	controller.abort();
	let opened = false;
	const ui: MultiSelectUi = {
		custom<T>() {
			opened = true;
			return new Promise<T>(() => {});
		},
	};
	const choices = await selectMultiple("Pick", makeQuestionOptions(params.alternatives), controller.signal, ui);

	assert.equal(opened, false);
	assert.equal(choices, null);
});

test("selectMultiple completes once when aborted while open", async () => {
	const controller = new AbortController();
	const ui: MultiSelectUi = {
		custom<T>(factory: MultiSelectFactory) {
			return new Promise<T>((resolve) => {
				factory({} as never, {} as never, {} as never, (value: unknown) => resolve(value as T));
			});
		},
	};
	const pending = selectMultiple("Pick", makeQuestionOptions(params.alternatives), controller.signal, ui);

	controller.abort();
	assert.deepEqual(await pending, null);
});

test("once ignores repeated completion", () => {
	const values: string[] = [];
	const complete = once((value: string) => values.push(value));

	complete("first");
	complete("second");

	assert.deepEqual(values, ["first"]);
});
