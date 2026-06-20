import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClientCommand,
  isServerEvent,
  type ClientCommand,
} from "../src/protocol.ts";

test("parseClientCommand: prompt", () => {
  const cmd = parseClientCommand({
    type: "prompt",
    id: "req-1",
    text: "hello",
  });
  assert.deepEqual(cmd, { type: "prompt", id: "req-1", text: "hello" });
});

test("parseClientCommand: prompt with images", () => {
  const cmd = parseClientCommand({
    type: "prompt",
    id: "req-2",
    text: "look",
    images: [{ type: "image", data: "abc", mediaType: "image/png" }],
  });
  assert.equal(cmd?.type, "prompt");
  if (cmd?.type === "prompt") {
    assert.equal(cmd.images?.length, 1);
  }
});

test("parseClientCommand: abort", () => {
  const cmd = parseClientCommand({ type: "abort", id: "req-3" });
  assert.deepEqual(cmd, { type: "abort", id: "req-3" });
});

test("parseClientCommand: new_session", () => {
  const cmd = parseClientCommand({ type: "new_session", id: "req-4" });
  assert.deepEqual(cmd, { type: "new_session", id: "req-4" });
});

test("parseClientCommand: switch_session", () => {
  const cmd = parseClientCommand({
    type: "switch_session",
    id: "req-5",
    path: "/tmp/foo.jsonl",
  });
  assert.deepEqual(cmd, {
    type: "switch_session",
    id: "req-5",
    path: "/tmp/foo.jsonl",
  });
});

test("parseClientCommand: set_model", () => {
  const cmd = parseClientCommand({
    type: "set_model",
    id: "req-6",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
  });
  assert.deepEqual(cmd, {
    type: "set_model",
    id: "req-6",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
  });
});

test("parseClientCommand: set_thinking_level", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    const cmd = parseClientCommand({
      type: "set_thinking_level",
      id: "req-7",
      level,
    });
    assert.deepEqual(cmd, {
      type: "set_thinking_level",
      id: "req-7",
      level,
    });
  }
});

test("parseClientCommand: list_sessions", () => {
  const cmd = parseClientCommand({ type: "list_sessions", id: "req-8" });
  assert.deepEqual(cmd, { type: "list_sessions", id: "req-8" });
});

test("parseClientCommand: list_models", () => {
  const cmd = parseClientCommand({ type: "list_models", id: "req-9" });
  assert.deepEqual(cmd, { type: "list_models", id: "req-9" });
});

test("parseClientCommand: get_state", () => {
  const cmd = parseClientCommand({ type: "get_state", id: "req-10" });
  assert.deepEqual(cmd, { type: "get_state", id: "req-10" });
});

test("parseClientCommand: rejects unknown type", () => {
  assert.equal(parseClientCommand({ type: "nope", id: "x" }), null);
  assert.equal(parseClientCommand({ type: "prompt" }), null); // missing id
  assert.equal(
    parseClientCommand({ type: "prompt", id: "x", text: 123 }),
    null,
  ); // wrong type
  assert.equal(
    parseClientCommand({ type: "set_thinking_level", id: "x", level: "bogus" }),
    null,
  );
  assert.equal(parseClientCommand("not an object"), null);
  assert.equal(parseClientCommand(null), null);
});

test("isServerEvent: passes SDK-shaped events", () => {
  assert.ok(isServerEvent({ type: "agent_start" }));
  assert.ok(isServerEvent({ type: "message_update" }));
  assert.ok(isServerEvent({ type: "tool_execution_end" }));
  assert.ok(isServerEvent({ type: "session_start" }));
});

test("isServerEvent: rejects commands and unknowns", () => {
  assert.equal(isServerEvent({ type: "prompt" }), false);
  assert.equal(isServerEvent({ type: "response" }), false);
  assert.equal(isServerEvent({}), false);
  assert.equal(isServerEvent(null), false);
});
