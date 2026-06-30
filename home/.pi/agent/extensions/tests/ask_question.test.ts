import assert from "node:assert/strict";
import test from "node:test";

import { getOptionColor, getSubmittedChoices, makeOptionLabel, makeResult, toggleOptionSelection } from "../ask_question.ts";

test("makeOptionLabel returns plain text without embedded ANSI", () => {
  assert.equal(makeOptionLabel(true, "Fast"), "[x] Fast");
  assert.equal(makeOptionLabel(false, "Fast"), "[ ] Fast");
  assert.equal(makeOptionLabel(false, "Ask AI for pros and cons"), "Ask AI for pros and cons");
  assert.equal(makeOptionLabel(false, "Something else"), "Something else");
});

test("special options use the same colors as normal options", () => {
  assert.equal(getOptionColor(false), "text");
  assert.equal(getOptionColor(true), "accent");
});

test("special options are submitted alone and cannot be multi-selected", () => {
  const options = ["Fast", "Simple", "Ask AI for pros and cons", "Something else"];

  assert.deepEqual(toggleOptionSelection([0], 2, options), [0]);
  assert.deepEqual(getSubmittedChoices([0, 1], 2, options), ["Ask AI for pros and cons"]);
  assert.deepEqual(getSubmittedChoices([0, 1], 3, options), ["Something else"]);
  assert.deepEqual(getSubmittedChoices([0, 1], 0, options), ["Fast", "Simple"]);
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
});
