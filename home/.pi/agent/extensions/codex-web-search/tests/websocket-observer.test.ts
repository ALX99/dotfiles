import * as assert from "node:assert/strict";
import { test } from "node:test";

import { installCodexFrameObserver } from "../websocket-observer.ts";

/**
 * Stand-in for the runtime's WebSocket. The observer replaces `globalThis.WebSocket`,
 * so this class is what its subclass wraps.
 */
class FakeWebSocket {
	readonly url: string;
	private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

	constructor(url: string | URL, _options?: unknown) {
		this.url = String(url);
	}

	addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
		const entries = this.listeners.get(type) ?? [];
		entries.push(listener);
		this.listeners.set(type, entries);
	}

	send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

	close(): void {}

	emitMessage(data: unknown): void {
		for (const listener of this.listeners.get("message") ?? []) listener({ data });
	}
}

const NATIVE_WEBSOCKET = globalThis.WebSocket;
const CODEX_URL = "wss://chatgpt.com/backend-api/codex/responses";

/** Install the fake runtime for one test and open sockets through it. */
function fakeRuntime(): { readonly socket: (url: string) => FakeWebSocket; readonly restore: () => void } {
	globalThis.piCodexWebSearchObservers = undefined;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	return {
		socket: (url: string) => new globalThis.WebSocket(url) as unknown as FakeWebSocket,
		restore: () => {
			globalThis.WebSocket = NATIVE_WEBSOCKET;
			globalThis.piCodexWebSearchObservers = undefined;
		},
	};
}

function requestFrame(sessionKey: string): string {
	return JSON.stringify({ type: "response.create", prompt_cache_key: sessionKey });
}

test("frames are delivered to the session whose request opened the socket", () => {
	const runtime = fakeRuntime();
	const frames: unknown[] = [];
	const dispose = installCodexFrameObserver("session-a", (frame) => frames.push(frame));
	try {
		const socket = runtime.socket(CODEX_URL);
		socket.send(requestFrame("session-a"));
		socket.emitMessage(JSON.stringify({ type: "response.created" }));
		assert.deepEqual(frames, [{ type: "response.created" }]);
	} finally {
		dispose();
		runtime.restore();
	}
});

test("the response payload never attributes a socket", () => {
	// The Codex backend replaces prompt_cache_key in responses, so only the request counts.
	const runtime = fakeRuntime();
	const frames: unknown[] = [];
	const dispose = installCodexFrameObserver("session-a", (frame) => frames.push(frame));
	try {
		const socket = runtime.socket(CODEX_URL);
		socket.emitMessage(JSON.stringify({ type: "response.created", response: { prompt_cache_key: "session-a" } }));
		assert.deepEqual(frames, []);
	} finally {
		dispose();
		runtime.restore();
	}
});

test("sibling sessions on separate sockets never see each other's frames", () => {
	const runtime = fakeRuntime();
	const parentFrames: unknown[] = [];
	const childFrames: unknown[] = [];
	const disposeParent = installCodexFrameObserver("parent", (frame) => parentFrames.push(frame));
	const disposeChild = installCodexFrameObserver("child", (frame) => childFrames.push(frame));
	try {
		const parentSocket = runtime.socket(CODEX_URL);
		const childSocket = runtime.socket(CODEX_URL);
		parentSocket.send(requestFrame("parent"));
		childSocket.send(requestFrame("child"));

		childSocket.emitMessage(JSON.stringify({ type: "response.completed" }));
		parentSocket.emitMessage(JSON.stringify({ type: "response.completed" }));

		assert.deepEqual(parentFrames, [{ type: "response.completed" }]);
		assert.deepEqual(childFrames, [{ type: "response.completed" }]);
	} finally {
		disposeParent();
		disposeChild();
		runtime.restore();
	}
});

test("non-Codex sockets, undecodable payloads, and unattributed frames are ignored", () => {
	const runtime = fakeRuntime();
	const frames: unknown[] = [];
	const dispose = installCodexFrameObserver("session-a", (frame) => frames.push(frame));
	try {
		const other = runtime.socket("wss://api.openai.com/v1/responses");
		other.send(requestFrame("session-a"));
		other.emitMessage(JSON.stringify({ type: "response.completed" }));

		const socket = runtime.socket(CODEX_URL);
		socket.emitMessage(JSON.stringify({ type: "response.completed" }));
		socket.emitMessage("not json");
		socket.emitMessage(new Uint8Array([1, 2, 3]));

		socket.send(requestFrame("session-a"));
		socket.emitMessage(new TextEncoder().encode(JSON.stringify({ type: "response.completed" })));

		assert.deepEqual(frames, [{ type: "response.completed" }]);
	} finally {
		dispose();
		runtime.restore();
	}
});

test("a disposed observer receives no further frames", () => {
	const runtime = fakeRuntime();
	const frames: unknown[] = [];
	const dispose = installCodexFrameObserver("session-a", (frame) => frames.push(frame));
	try {
		const socket = runtime.socket(CODEX_URL);
		socket.send(requestFrame("session-a"));
		socket.emitMessage(JSON.stringify({ type: "response.created" }));
		assert.equal(frames.length, 1);

		dispose();
		socket.emitMessage(JSON.stringify({ type: "response.completed" }));
		assert.equal(frames.length, 1);
	} finally {
		runtime.restore();
	}
});
