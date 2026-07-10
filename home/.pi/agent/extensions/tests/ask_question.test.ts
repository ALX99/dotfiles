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
} from "../ask_question.ts";

const params = { question: "Pick a tool", alternatives: ["Fast", "Simple"] };

test("makeOptionLabel returns plain text without embedded ANSI", () => {
  const options = makeQuestionOptions(["Fast", "Simple"]);

  assert.equal(makeOptionLabel(true, options[0]), "[x] Fast");
  assert.equal(makeOptionLabel(false, options[0]), "[ ] Fast");
  assert.equal(makeOptionLabel(false, options[2]), "Compare options");
  assert.equal(makeOptionLabel(false, options[3]), "Something else");
});

test("special options use the same colors as normal options", () => {
  assert.equal(getOptionColor(false), "text");
  assert.equal(getOptionColor(true), "accent");
});

test("special options are submitted alone and cannot be multi-selected", () => {
  const options = makeQuestionOptions(["Fast", "Simple"]);

  assert.deepEqual(toggleOptionSelection([0], 2, options), [0]);
  assert.deepEqual(getSubmittedChoices([0, 1], 2, options), [options[2]]);
  assert.deepEqual(getSubmittedChoices([0, 1], 3, options), [options[3]]);
  assert.deepEqual(getSubmittedChoices([0, 1], 0, options), [options[0], options[1]]);
});

test("reserved and duplicate alternatives are rejected", () => {
  assert.throws(
    () => validateAlternatives(["Compare options", "Simple"]),
    /reserved option labels/,
  );
  assert.throws(
    () => validateAlternatives(["Fast", "Fast"]),
    /must be distinct/,
  );
});

test("resolveChoices returns a comparison action instead of an answer", async () => {
  const options = makeQuestionOptions(params.alternatives);
  const result = await resolveChoices(
    params,
    [options[2]],
    async () => {
      throw new Error("custom input should not be requested");
    },
  );

  assert.match(result.content[0]?.text ?? "", /requested a comparison/);
  assert.equal(result.details.answer, null);
  assert.deepEqual(result.details.answers, []);
  assert.equal(result.details.action, "compare");
});

test("resolveChoices handles a normal selection", async () => {
  const options = makeQuestionOptions(params.alternatives);
  const result = await resolveChoices(params, [options[0]], async () => null);

  assert.equal(result.content[0]?.text, "User selected: Fast");
  assert.deepEqual(result.details.answers, ["Fast"]);
  assert.equal(result.details.answer, "Fast");
  assert.equal(result.details.action, null);
  assert.equal(result.details.wasCustom, false);
});

test("resolveChoices handles a custom answer alongside alternatives", async () => {
  const options = makeQuestionOptions(params.alternatives);
  const result = await resolveChoices(
    params,
    [options[0], options[3]],
    async () => "Something more flexible",
  );

  assert.equal(result.content[0]?.text, "User selected: Fast, Something more flexible");
  assert.deepEqual(result.details.answers, ["Fast", "Something more flexible"]);
  assert.equal(result.details.wasCustom, true);
});

test("resolveChoices handles cancellation", async () => {
  const result = await resolveChoices(params, null, async () => null);

  assert.equal(result.content[0]?.text, "User declined to answer, await further instructions.");
  assert.equal(result.details.answer, null);
  assert.deepEqual(result.details.answers, []);
  assert.equal(result.details.action, null);
});

test("makeResult records multiple selected answers", () => {
  const result = makeResult(
    { question: "Pick tools", alternatives: ["read", "write", "bash"] },
    "User selected: read, bash",
    ["read", "bash"],
    false,
  );

  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "User selected: read, bash");
  assert.deepEqual(result.details.answers, ["read", "bash"]);
  assert.equal(result.details.answer, "read");
  assert.equal(result.details.wasCustom, false);
  assert.equal(result.details.action, null);
});
