import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge, type BridgeSession } from "../src/bridge.ts";
import type { ServerEvent } from "../src/protocol.ts";

// All test fixtures are typed as any to dodge the complexity of
// satisfying the full BridgeSession/BridgeRuntime interfaces. The
// bridge's runtime contract is verified by these tests by behavior, not
// by static type conformance.

type AnySession = any;
type AnyRuntime = any;

interface FakeClient {
  sent: string[];
  closed: boolean;
  send(data: string): void;
  close(): void;
}

function makeClient(): FakeClient {
  return {
    sent: [],
    closed: false,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
}

function makeSession(): AnySession {
  const events: Array<{ cb: (e: unknown) => void }> = [];
  const state: { subscribed: number; unsubscribed: number } = {
    subscribed: 0,
    unsubscribed: 0,
  };
  return {
    events,
    get subscribed() {
      return state.subscribed;
    },
    get unsubscribed() {
      return state.unsubscribed;
    },
    subscribe(cb: (e: unknown) => void) {
      events.push({ cb });
      state.subscribed++;
      return () => {
        state.unsubscribed++;
      };
    },
  };
}

function makeDispatchSession(): AnySession {
  const base = makeSession();
  base.prompt = async (text: string, opts?: { images?: unknown[] }) => {
    base._calls.prompt.push({ text, images: opts?.images });
  };
  base.abort = async () => {
    base._calls.abort++;
  };
  base.setModel = async (m: { provider: string; id: string }) => {
    base._calls.setModel.push(m);
    return true;
  };
  base.setThinkingLevel = (level: string) => {
    base._calls.setThinkingLevel.push(level);
  };
  base._calls = {
    prompt: [],
    abort: 0,
    setModel: [],
    setThinkingLevel: [],
  };
  base.messages = [];
  base.agent = {
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      thinkingLevel: "medium",
      isStreaming: false,
      messageCount: 0,
    },
  };
  return base;
}

function makeRuntime(session: AnySession): AnyRuntime {
  const calls: { newSessionCalls: number; switchSessionCalls: string[] } = {
    newSessionCalls: 0,
    switchSessionCalls: [],
  };
  const runtime: any = {
    session,
    async newSession() {
      calls.newSessionCalls++;
      return { cancelled: false };
    },
    async switchSession(p: string) {
      calls.switchSessionCalls.push(p);
      return { cancelled: false };
    },
    async listSessions() {
      return [];
    },
    async getAvailableModels() {
      return [];
    },
    get newSessionCalls() {
      return calls.newSessionCalls;
    },
    get switchSessionCalls() {
      return calls.switchSessionCalls;
    },
  };
  return runtime;
}

test("Bridge: subscribes to runtime.session on construction", () => {
  const session = makeSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  assert.equal(session.subscribed, 1);
  bridge.dispose();
  assert.equal(session.unsubscribed, 1);
});

test("Bridge: forwards session events to all client senders", () => {
  const session = makeSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c1 = makeClient();
  const c2 = makeClient();
  bridge.addClient((data) => c1.send(data));
  bridge.addClient((data) => c2.send(data));

  const event: ServerEvent = { type: "agent_start" };
  session.events[0]!.cb(event);

  assert.equal(c1.sent.length, 1);
  assert.equal(c2.sent.length, 1);
  assert.deepEqual(JSON.parse(c1.sent[0]!), { type: "agent_start" });
  bridge.dispose();
});

test("Bridge: removeClient stops further sends", () => {
  const session = makeSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const remove = bridge.addClient((data) => c.send(data));

  session.events[0]!.cb({ type: "agent_start" });
  assert.equal(c.sent.length, 1);

  remove();
  session.events[0]!.cb({ type: "agent_start" });
  assert.equal(c.sent.length, 1);
  bridge.dispose();
});

test("Bridge: per-client send errors don't crash the bridge", () => {
  const session = makeSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  bridge.addClient(() => {
    throw new Error("send failed");
  });
  bridge.addClient((data) => c.send(data));
  assert.doesNotThrow(() => {
    session.events[0]!.cb({ type: "agent_start" });
  });
  assert.equal(c.sent.length, 1);
  bridge.dispose();
});

test("Bridge: dispose unsubscribes and clears clients", () => {
  const session = makeSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  bridge.addClient((data) => c.send(data));
  bridge.dispose();
  assert.equal(session.unsubscribed, 1);
  assert.doesNotThrow(() => bridge.dispose());
});

// === Command dispatch tests (Task 5) ===

test("Bridge.handleCommand: prompt -> session.prompt + ok response", async () => {
  const session = makeDispatchSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand({ type: "prompt", id: "req-1", text: "hello" }, send);

  assert.equal(session._calls.prompt.length, 1);
  assert.equal(session._calls.prompt[0]!.text, "hello");
  assert.equal(c.sent.length, 1);
  assert.deepEqual(JSON.parse(c.sent[0]!), {
    type: "response",
    id: "req-1",
    ok: true,
  });
});

test("Bridge.handleCommand: abort -> session.abort", async () => {
  const session = makeDispatchSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand({ type: "abort", id: "req-2" }, send);
  assert.equal(session._calls.abort, 1);
  assert.deepEqual(JSON.parse(c.sent[0]!), {
    type: "response",
    id: "req-2",
    ok: true,
  });
});

test("Bridge.handleCommand: set_model", async () => {
  const session = makeDispatchSession();
  const runtime = makeRuntime(session);
  runtime.getAvailableModels = async () => [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
  ];
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand(
    {
      type: "set_model",
      id: "req-3",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    },
    send,
  );
  assert.equal(session._calls.setModel.length, 1);
  assert.deepEqual(session._calls.setModel[0]!, {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
  });
});

test("Bridge.handleCommand: set_thinking_level", async () => {
  const session = makeDispatchSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand(
    { type: "set_thinking_level", id: "req-4", level: "high" },
    send,
  );
  assert.deepEqual(session._calls.setThinkingLevel, ["high"]);
});

test("Bridge.handleCommand: get_state returns snapshot", async () => {
  const session = makeDispatchSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand({ type: "get_state", id: "req-5" }, send);
  const resp = JSON.parse(c.sent[0]!);
  assert.equal(resp.type, "response");
  assert.equal(resp.id, "req-5");
  assert.ok(resp.ok);
  assert.ok(resp.data);
  assert.equal(resp.data.thinkingLevel, "medium");
  assert.equal(resp.data.isStreaming, false);
});

test("Bridge.handleCommand: invalid command -> ok:false response", async () => {
  const session = makeDispatchSession();
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand({ type: "nope", id: "req-6" }, send);
  const resp = JSON.parse(c.sent[0]!);
  assert.equal(resp.type, "response");
  assert.equal(resp.id, "req-6");
  assert.equal(resp.ok, false);
  assert.match(resp.error, /invalid command/i);
});

test("Bridge.handleCommand: session.prompt throws -> ok:false", async () => {
  const session = makeDispatchSession();
  session.prompt = async () => {
    throw new Error("agent busy");
  };
  const runtime = makeRuntime(session);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand({ type: "prompt", id: "req-7", text: "hi" }, send);
  const resp = JSON.parse(c.sent[0]!);
  assert.equal(resp.ok, false);
  assert.match(resp.error, /agent busy/);
});

// === Session replacement tests (Task 6) ===

/**
 * Replace the session the runtime points at. The bridge subscribes via
 * the runtime.session getter, so we mutate the runtime's session field
 * and patch the getter.
 */
function replaceSession(runtime: AnyRuntime, newSession: AnySession) {
  Object.defineProperty(runtime, "session", {
    get() {
      return newSession;
    },
    configurable: true,
  });
}

test("Bridge.handleCommand: new_session rebinds to new session", async () => {
  const sessionA = makeSession();
  const runtime = makeRuntime(sessionA);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  const sessionB = makeSession();
  replaceSession(runtime, sessionB);

  await bridge.handleCommand({ type: "new_session", id: "req-1" }, send);
  assert.equal(sessionA.unsubscribed, 1);
  assert.equal(sessionB.subscribed, 1);
});

test("Bridge.handleCommand: switch_session rebinds", async () => {
  const sessionA = makeSession();
  const runtime = makeRuntime(sessionA);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  const sessionB = makeSession();
  replaceSession(runtime, sessionB);

  await bridge.handleCommand(
    { type: "switch_session", id: "req-2", path: "/tmp/foo.jsonl" },
    send,
  );
  assert.equal(sessionA.unsubscribed, 1);
  assert.equal(sessionB.subscribed, 1);
  assert.deepEqual(runtime.switchSessionCalls, ["/tmp/foo.jsonl"]);
});

test("Bridge.handleCommand: cancelled new_session does NOT rebind", async () => {
  const sessionA = makeSession();
  const runtime = makeRuntime(sessionA);
  runtime.newSession = async () => ({ cancelled: true });
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  await bridge.handleCommand({ type: "new_session", id: "req-3" }, send);
  assert.equal(sessionA.unsubscribed, 0);
  assert.equal(sessionA.subscribed, 1);
  const resp = JSON.parse(c.sent[0]!);
  assert.equal(resp.ok, false);
  assert.match(resp.error, /cancelled/);
});

test("Bridge: events from new session are forwarded after rebind", async () => {
  const sessionA = makeSession();
  const runtime = makeRuntime(sessionA);
  const bridge = new Bridge({ runtime });
  const c = makeClient();
  const send = (data: string) => c.send(data);
  bridge.addClient(send);

  const sessionB = makeSession();
  replaceSession(runtime, sessionB);
  await bridge.handleCommand({ type: "new_session", id: "req-4" }, send);

  sessionB.events[0]!.cb({ type: "agent_start" });
  assert.equal(c.sent.length, 2);
  const last = JSON.parse(c.sent[c.sent.length - 1]!);
  assert.deepEqual(last, { type: "agent_start" });
});
