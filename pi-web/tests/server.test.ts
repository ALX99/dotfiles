import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer, type ServerDeps } from "../src/server.ts";

// Fakes typed as any to dodge the complexity of the full runtime
// surface; the server's contract is verified by behavior.

type AnySession = any;
type AnyRuntime = any;

function makeFakeSession(): AnySession {
  const events: Array<{ cb: (e: unknown) => void }> = [];
  return {
    events,
    subscribe(cb: (e: unknown) => void) {
      events.push({ cb });
      return () => {};
    },
  };
}

function makeFakeRuntime(extra: Record<string, unknown> = {}): AnyRuntime {
  const session = makeFakeSession();
  return {
    session,
    async newSession() {
      return { cancelled: false };
    },
    async switchSession() {
      return { cancelled: false };
    },
    async listSessions() {
      return [];
    },
    async getAvailableModels() {
      return [];
    },
    ...extra,
  };
}

async function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withTempWebRoot(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-test-"));
  await mkdir(join(dir, "src/web"), { recursive: true });
  await writeFile(join(dir, "src/web/index.html"), "<h1>hi</h1>");
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("startServer: serves index.html on /", async () => {
  await withTempWebRoot(async (dir) => {
    const runtime = makeFakeRuntime();
    const ctx: ServerDeps = { runtime, webRoot: join(dir, "src/web") };
    const handle = startServer({ port: 0, host: "127.0.0.1", ctx });
    await once(handle.server, "listening");
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    const port = addr.port;

    const res = await get(port, "/");
    assert.equal(res.status, 200);
    assert.match(res.body, /<h1>hi<\/h1>/);

    await handle.stop();
  });
});

test("startServer: refuses to bind to non-loopback", () => {
  const runtime = makeFakeRuntime();
  const ctx: ServerDeps = { runtime, webRoot: "/tmp" };
  assert.throws(() =>
    startServer({ port: 0, host: "0.0.0.0" as "127.0.0.1", ctx }),
  );
});

test("startServer: WebSocket at /ws handles a prompt command", async () => {
  await withTempWebRoot(async (dir) => {
    const session = makeFakeSession() as AnySession & {
      promptCalls: Array<{ text: string }>;
    };
    session.promptCalls = [];
    session.prompt = async (t: string) => {
      session.promptCalls.push({ text: t });
    };
    const runtime = makeFakeRuntime({ session });

    const ctx: ServerDeps = { runtime, webRoot: join(dir, "src/web") };
    const handle = startServer({ port: 0, host: "127.0.0.1", ctx });
    await once(handle.server, "listening");
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    const port = addr.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify({ type: "prompt", id: "1", text: "hello" }));

    const got = await new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });
    const resp = JSON.parse(got);
    assert.equal(resp.type, "response");
    assert.equal(resp.id, "1");
    assert.ok(resp.ok);
    assert.equal(session.promptCalls[0]!.text, "hello");

    ws.close();
    await handle.stop();
  });
});

test("startServer: events on session are pushed to WebSocket", async () => {
  await withTempWebRoot(async (dir) => {
    const session = makeFakeSession();
    const runtime = makeFakeRuntime({ session });
    const ctx: ServerDeps = { runtime, webRoot: join(dir, "src/web") };
    const handle = startServer({ port: 0, host: "127.0.0.1", ctx });
    await once(handle.server, "listening");
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    const port = addr.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    session.events[0]!.cb({ type: "agent_start" });

    const got = await new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });
    assert.deepEqual(JSON.parse(got), { type: "agent_start" });

    ws.close();
    await handle.stop();
  });
});

test("startServer: serves vendor routes from node_modules", async () => {
  await withTempWebRoot(async (dir) => {
    const runtime = makeFakeRuntime();
    const ctx: ServerDeps = { runtime, webRoot: join(dir, "src/web") };
    const handle = startServer({ port: 0, host: "127.0.0.1", ctx });
    await once(handle.server, "listening");
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    const port = addr.port;

    const res = await get(port, "/vendor/preact.js");
    assert.equal(res.status, 200);
    assert.match(res.body, /createElement|render|h=/);

    const htm = await get(port, "/vendor/htm.js");
    assert.equal(htm.status, 200);
    assert.ok(htm.body.length > 100, "htm vendor file should have content");

    await handle.stop();
  });
});
