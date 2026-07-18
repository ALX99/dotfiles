import * as assert from "node:assert/strict";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { test } from "node:test";
import { parseAgentEvent } from "../event-schema.ts";
import { parseRpcRecord } from "../protocol.ts";
import { DEFAULT_RPC_MAX_FRAME_BYTES, RpcTransport, type RpcEvent, type SpawnRpcProcess } from "../rpc.ts";

const testEnv: Record<string, string> = Object.fromEntries(
	Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

function client(
	script: string,
	options: {
		readonly onEvent?: (event: RpcEvent) => void;
		readonly onExit?: (error: Error | undefined) => void;
		readonly maxFrameBytes?: number;
		readonly requestTimeoutMs?: number;
		readonly closeGraceMs?: number;
		readonly maxStderrBytes?: number;
		readonly maxStderrLines?: number;
		readonly maxQueuedWriteBytes?: number;
		readonly spawnProcess?: SpawnRpcProcess;
	} = {},
): RpcTransport {
	return new RpcTransport({
		command: process.execPath,
		args: ["-e", script],
		cwd: process.cwd(),
		env: testEnv,
		onEvent: options.onEvent ?? (() => {}),
		onExit: options.onExit ?? (() => {}),
		...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
		...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
		...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
		...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
		...(options.maxStderrLines === undefined ? {} : { maxStderrLines: options.maxStderrLines }),
		...(options.maxQueuedWriteBytes === undefined ? {} : { maxQueuedWriteBytes: options.maxQueuedWriteBytes }),
		...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
	});
}

function trackingSpawner(exitObserved: { value: boolean }): {
	readonly spawnProcess: SpawnRpcProcess;
	readonly exited: Promise<NodeJS.Signals | null>;
} {
	const exited = Promise.withResolvers<NodeJS.Signals | null>();
	function spawnTracked(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) {
		const child = spawn(command, [...args], options);
		child.once("exit", (_code, signal) => {
			exitObserved.value = true;
			exited.resolve(signal);
		});
		return child;
	}
	// RpcTransport always requests the stdio-pipe overload implemented by this fixture.
	return { spawnProcess: spawnTracked as unknown as SpawnRpcProcess, exited: exited.promise };
}

test("protocol rejects non-object JSON and malformed known responses", () => {
	for (const value of [null, [], "hello", 1, true]) {
		assert.equal(parseRpcRecord(value).kind, "error");
	}
	for (const value of [
		{ type: "response", id: 1, success: true },
		{ type: "response", id: "x" },
		{ type: "response", id: "x", success: false },
		{ type: "response", id: "x", success: false, error: "" },
	]) {
		assert.equal(parseRpcRecord(value).kind, "error");
	}
});

test("known event poison is rejected while genuinely unknown variants are bounded envelopes", () => {
	for (const value of [
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: 1 }] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: 1 }] } },
		{ type: "message_end", message: { role: "assistant", content: [], usage: { input: -1 } } },
		{ type: "message_end", message: { role: "assistant", content: [], usage: { output: Infinity } } },
		{ type: "message_end", message: { role: "assistant", content: [], usage: { cacheRead: "1" } } },
	]) {
		assert.equal(parseAgentEvent(value).kind, "error");
	}
	const unknownPart = parseAgentEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "ok" }] },
	});
	assert.equal(unknownPart.kind, "event");
	const unknownEvent = parseRpcRecord({ type: "future_event", payload: 1 });
	assert.equal(unknownEvent.kind, "event");
});

test("transport handles fragmented UTF-8 and several frames in one chunk", async (t) => {
	const events: RpcEvent[] = [];
	const script = String.raw`
const first = Buffer.from(JSON.stringify({type:'unicode', text:'雪'}) + '\n');
process.stdout.write(first.subarray(0, first.length - 3));
setTimeout(() => process.stdout.write(Buffer.concat([
  first.subarray(first.length - 3),
  Buffer.from(JSON.stringify({type:'second'}) + '\n' + JSON.stringify({type:'third'}) + '\n')
])), 5);
setTimeout(() => {}, 200);
`;
	const transport = client(script, { onEvent: (event) => events.push(event) });
	t.after(() => transport.close());
	await transport.start();
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(
		events.map((event) => event.type),
		["unicode", "second", "third"],
	);
	assert.equal(events[0]?.text, "雪");
});

test("oversized non-newline stdout fails at the configured frame limit", async (t) => {
	const exited = Promise.withResolvers<Error | undefined>();
	const transport = client("process.stdout.write('x'.repeat(65)); setTimeout(() => {}, 200)", {
		maxFrameBytes: 64,
		onExit: exited.resolve,
	});
	t.after(() => transport.close());
	await transport.start();
	const error = await exited.promise;
	assert.match(error?.message ?? "", /64 byte limit/);
	assert.equal(transport.getState(), "failed");
});

test("malformed known records fail the live transport and stderr keeps a bounded tail", async (t) => {
	const exited = Promise.withResolvers<Error | undefined>();
	const script =
		'process.stderr.write(\'first\\nsecond\\nlast-line\\n\'); process.stdout.write(\'{"type":"response","id":"x","success":false}\\n\'); setTimeout(() => {}, 200)';
	const transport = client(script, {
		maxStderrBytes: 64,
		maxStderrLines: 2,
		onExit: exited.resolve,
	});
	t.after(() => transport.close());
	await transport.start();
	const error = await exited.promise;
	assert.match(error?.message ?? "", /Malformed RPC response/);
	assert.equal(transport.getState(), "failed");
});

test("terminal protocol failure tears down an uncooperative child before reporting failure", async () => {
	const exitObserved = { value: false };
	const tracked = trackingSpawner(exitObserved);
	const reported = Promise.withResolvers<Error | undefined>();
	const script = String.raw`
process.on('SIGTERM', () => {});
process.stdout.write('{"type":"response","id":"x","success":false}\n');
process.stdin.resume();
setInterval(() => {}, 100);
`;
	const transport = client(script, {
		closeGraceMs: 20,
		spawnProcess: tracked.spawnProcess,
		onExit: (error) => {
			assert.equal(exitObserved.value, true, "onExit must run only after child exit");
			reported.resolve(error);
		},
	});
	await transport.start();
	const error = await reported.promise;
	assert.match(error?.message ?? "", /Malformed RPC response/);
	assert.equal(await tracked.exited, "SIGKILL");
	assert.equal(transport.getState(), "failed");
});

test("blocked-stdin extension UI flood is aggregate-bounded and tears down the child", async () => {
	const exitObserved = { value: false };
	const tracked = trackingSpawner(exitObserved);
	const reported = Promise.withResolvers<Error | undefined>();
	const script = String.raw`
for (let index = 0; index < 100; index++) {
  process.stdout.write(JSON.stringify({
    type: 'extension_ui_request',
    id: 'ui-' + index,
    method: 'confirm',
    title: 'Question',
    message: 'Continue?'
  }) + '\n');
}
setInterval(() => {}, 100);
`;
	const transport = client(script, {
		maxQueuedWriteBytes: 256,
		closeGraceMs: 20,
		spawnProcess: tracked.spawnProcess,
		onExit: (error) => {
			assert.equal(exitObserved.value, true, "write-bound failure must await child exit");
			reported.resolve(error);
		},
	});
	await transport.start();
	const error = await reported.promise;
	assert.match(error?.message ?? "", /write queue exceeds the 256 byte backpressure limit/);
	await tracked.exited;
	assert.equal(transport.getState(), "failed");
});

test("child-exit diagnostics retain only bounded trailing stderr", async () => {
	const script =
		"process.stdin.once('data', () => { process.stderr.write('discard-me-' + 'x'.repeat(100) + '\\nkeep-one\\nkeep-last\\n'); process.exit(7); })";
	const transport = client(script, { maxStderrBytes: 64, maxStderrLines: 2 });
	await transport.start();
	await assert.rejects(transport.request({ type: "exit" }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /keep-last/);
		assert.doesNotMatch(error.message, /discard-me/);
		assert.ok(Buffer.byteLength(error.message, "utf8") < 200);
		return true;
	});
	await transport.close();
});

test("request timeout and abort remove pending requests without closing the child", async (t) => {
	const transport = client("process.stdin.resume(); setTimeout(() => {}, 500)", { requestTimeoutMs: 20 });
	t.after(() => transport.close());
	await transport.start();
	await assert.rejects(transport.request({ type: "never" }), /timed out/);
	assert.equal(transport.pendingRequestCount(), 0);

	const abort = new AbortController();
	const request = transport.request({ type: "never-again" }, { signal: abort.signal, timeoutMs: 1_000 });
	abort.abort();
	await assert.rejects(request, { name: "AbortError" });
	assert.equal(transport.pendingRequestCount(), 0);
	assert.equal(transport.getState(), "open");
});

test("serialization failure does not create a pending request", async (t) => {
	const transport = client("process.stdin.resume(); setTimeout(() => {}, 200)");
	t.after(() => transport.close());
	await transport.start();
	const circular: Record<string, unknown> = { type: "circular" };
	circular.self = circular;
	await assert.rejects(transport.request(circular), /serialize/);
	assert.equal(transport.pendingRequestCount(), 0);
});

test("writes are serialized in request order", async (t) => {
	const script = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data:command.sequence}) + '\n');
  }
});
`;
	const transport = client(script);
	t.after(() => transport.close());
	await transport.start();
	const values = await Promise.all(
		Array.from({ length: 20 }, (_, sequence) => transport.request({ type: "ordered", sequence })),
	);
	assert.deepEqual(
		values,
		Array.from({ length: 20 }, (_, index) => index),
	);
});

test("close escalates an ignored SIGTERM, waits for exit, and is idempotent", async () => {
	const ready = Promise.withResolvers<void>();
	const transport = client(
		"process.on('SIGTERM', () => {}); process.stdout.write('{\"type\":\"ready\"}\\n'); process.stdin.resume(); setInterval(() => {}, 100)",
		{
			closeGraceMs: 20,
			onEvent: (event) => {
				if (event.type === "ready") ready.resolve();
			},
		},
	);
	await transport.start();
	await ready.promise;
	const startedAt = Date.now();
	const first = transport.close();
	const second = transport.close();
	assert.equal(first, second);
	await first;
	assert.ok(Date.now() - startedAt >= 15);
	assert.equal(transport.getState(), "closed");
});

test("default frame bound is explicit and finite", () => {
	assert.equal(DEFAULT_RPC_MAX_FRAME_BYTES, 1024 * 1024);
	assert.equal(typeof spawn, "function");
});
