import { Predicate, Result } from "effect";
import { parseJson } from "../_shared/json.ts";

/** One decoded Codex stream frame for the session that requested it. */
export type CodexFrameHandler = (frame: unknown) => void;

/**
 * Codex WebSocket frames carry the same JSON objects as the SSE stream, so the request
 * URL is what identifies them. Pi's Codex transport is the only path that opens this one.
 */
const CODEX_SOCKET_MARKER = "/codex/responses";

interface ObserverRegistry {
	/** Frame handlers by Pi session, keyed with the session's `prompt_cache_key`. */
	readonly handlers: Map<string, Set<CodexFrameHandler>>;
	/** Session that owns each observed socket, learned from its request frame. */
	readonly socketSessions: WeakMap<object, string>;
	installed: boolean;
}

declare global {
	/** Listeners live on the global object so a hot-reloaded extension adopts the subclass. */
	var piCodexWebSearchObservers: ObserverRegistry | undefined;
}

function registry(): ObserverRegistry {
	globalThis.piCodexWebSearchObservers ??= {
		handlers: new Map(),
		socketSessions: new WeakMap(),
		installed: false,
	};
	return globalThis.piCodexWebSearchObservers;
}

/**
 * Observe Codex stream frames for one Pi session and return a disposer. Sockets are
 * attributed by the request's `prompt_cache_key`, so sibling sessions in one process (a
 * parent and its in-process subagents) never see each other's frames. Observers are
 * diagnostics: no failure here can affect the response stream.
 */
export function installCodexFrameObserver(sessionId: string, onFrame: CodexFrameHandler): () => void {
	const observers = registry();
	let handlers = observers.handlers.get(sessionId);
	if (handlers === undefined) {
		handlers = new Set();
		observers.handlers.set(sessionId, handlers);
	}
	handlers.add(onFrame);
	if (!observers.installed) installObserver(observers);

	return () => {
		const current = observers.handlers.get(sessionId);
		current?.delete(onFrame);
		if (current?.size === 0) observers.handlers.delete(sessionId);
	};
}

function installObserver(observers: ObserverRegistry): void {
	const NativeWebSocket = globalThis.WebSocket;
	if (typeof NativeWebSocket !== "function") return;

	class ObservedWebSocket extends NativeWebSocket {
		// pi-ai passes Node's `{ headers }` options object here even though the DOM
		// signature only declares protocols; the rest tuple forwards it untouched.
		constructor(...args: [url: string | URL, protocols?: string | string[] | WebSocketInit]) {
			super(...args);
			if (!String(args[0]).includes(CODEX_SOCKET_MARKER)) return;
			this.addEventListener("message", (event) => observe(this, event.data, observers));
		}

		// The first frame is the request body; its `prompt_cache_key` is the Pi session
		// id, which attributes the frames the server sends back on this socket. The
		// response does not echo it, so the request is the only reliable attribution.
		override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
			super.send(data);
			if (typeof data !== "string") return;
			const sessionId = readPromptCacheKey(data);
			if (sessionId !== undefined) observers.socketSessions.set(this, sessionId);
		}
	}

	globalThis.WebSocket = ObservedWebSocket;
	observers.installed = true;
}

function observe(socket: object, data: unknown, observers: ObserverRegistry): void {
	const text = decodeFrameData(data);
	if (text === undefined) return;
	const parsed = parseJson(text, "codex-frame");
	if (Result.isFailure(parsed)) return;
	const frame = parsed.success;
	const sessionId = observers.socketSessions.get(socket);
	if (sessionId === undefined) return;
	for (const handler of observers.handlers.get(sessionId) ?? []) {
		try {
			handler(frame);
		} catch {
			// Observers are diagnostics; a broken one must not break the response stream.
		}
	}
}

/** Read the `prompt_cache_key` of a Codex request frame. */
function readPromptCacheKey(text: string): string | undefined {
	const parsed = parseJson(text, "codex-request");
	if (Result.isFailure(parsed) || !Predicate.isObject(parsed.success)) return undefined;
	const key = parsed.success.prompt_cache_key;
	return typeof key === "string" && key.length > 0 ? key : undefined;
}

function decodeFrameData(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}
	return undefined;
}
