import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reducer } from "../src/web/state.ts";

test("reducer: show_toast creates a dismissible toast", () => {
  const shown = reducer(initialState, {
    type: "show_toast",
    text: "Not connected",
    kind: "info",
  });

  assert.equal(shown.toast?.text, "Not connected");
  assert.equal(shown.toast?.kind, "info");
  assert.equal(typeof shown.toast?.id, "number");

  const dismissed = reducer(shown, {
    type: "dismiss_toast",
    id: shown.toast!.id,
  });
  assert.equal(dismissed.toast, null);
});

test("reducer: failed responses use the same toast path", () => {
  const failed = reducer(initialState, {
    type: "response",
    msg: { type: "response", id: "req-1", ok: false, error: "agent busy" },
  });

  assert.equal(failed.toast?.text, "agent busy");
  assert.equal(failed.toast?.kind, "error");
  assert.equal(typeof failed.toast?.id, "number");
});
