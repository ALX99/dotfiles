import * as assert from "node:assert/strict";
import { test } from "node:test";

import { renderContextBar } from "../footer.ts";

const theme = {
  fg(_color: string, text: string): string {
    return text;
  },
};

test("renderContextBar clamps percentages above 100 to the bar width", () => {
  assert.doesNotThrow(() => {
    renderContextBar({ tokens: 210, contextWindow: 100, percent: 210 }, theme as never);
  });

  assert.equal(
    renderContextBar({ tokens: 210, contextWindow: 100, percent: 210 }, theme as never),
    "[██████████]210%",
  );
});

test("renderContextBar clamps negative percentages to the empty bar", () => {
  assert.equal(
    renderContextBar({ tokens: 0, contextWindow: 100, percent: -5 }, theme as never),
    "[░░░░░░░░░░]-5%",
  );
});
