import assert from "node:assert/strict";
import test from "node:test";

import { extractAssistantText, findLastAssistantText, getClipboardCandidates } from "../copy.ts";

test("extractAssistantText returns visible text blocks only", () => {
  const text = extractAssistantText({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "First visible paragraph." },
      { type: "toolCall", name: "bash", id: "call_1", arguments: { command: "echo hi" } },
      { type: "text", text: "Second visible paragraph." },
    ],
  });

  assert.equal(text, "First visible paragraph.\n\nSecond visible paragraph.");
});

test("findLastAssistantText returns newest assistant text from the active branch", () => {
  const text = findLastAssistantText([
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Older assistant" }] },
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Please continue" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Newest assistant" },
        ],
      },
    },
  ]);

  assert.equal(text, "Newest assistant");
});

test("findLastAssistantText skips assistant messages without visible text", () => {
  const text = findLastAssistantText([
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Copy me" }] },
    },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden only" }] },
    },
  ]);

  assert.equal(text, "Copy me");
});

test("getClipboardCandidates prefers platform clipboard commands", () => {
  assert.deepEqual(getClipboardCandidates("darwin", {}), [{ command: "pbcopy", args: [] }]);
  assert.deepEqual(getClipboardCandidates("linux", { WAYLAND_DISPLAY: "wayland-1" }), [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ]);
  assert.deepEqual(getClipboardCandidates("linux", {}), [
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ]);
});
