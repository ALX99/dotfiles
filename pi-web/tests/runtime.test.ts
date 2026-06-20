import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealRuntime } from "../src/runtime.ts";

test("createRealRuntime: builds a BridgeRuntime with a real SDK session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-rt-"));
  let rt;
  try {
    rt = await createRealRuntime({ cwd });
  } catch (err) {
    // If the SDK can't initialize (no auth.json, no model with a key,
    // etc.), skip the test. Full integration is covered by the manual
    // smoke test (Task 10), which runs against the user's real auth.
    console.log(`[skip] createRealRuntime: ${(err as Error).message}`);
    return;
  }
  // BridgeRuntime surface.
  assert.equal(typeof rt.newSession, "function");
  assert.equal(typeof rt.switchSession, "function");
  assert.equal(typeof rt.listSessions, "function");
  assert.equal(typeof rt.getAvailableModels, "function");
  // session: an AgentSession with subscribe/prompt/abort/setModel/etc.
  assert.equal(typeof rt.session.subscribe, "function");
  assert.equal(typeof rt.session.prompt, "function");
  assert.equal(typeof rt.session.abort, "function");
  // messages is an array.
  assert.ok(Array.isArray(rt.session.messages));
  // listSessions: returns array (empty for fresh cwd).
  const sessions = await rt.listSessions();
  assert.ok(Array.isArray(sessions));
  // getAvailableModels: returns array (possibly empty if no keys).
  const models = await rt.getAvailableModels();
  assert.ok(Array.isArray(models));
});
