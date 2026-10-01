import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DateTime, Effect, Result } from "effect";
import { toError } from "../_shared/errors.ts";
import { realPath } from "../_shared/fs.ts";
import { HarnessError, type EvidenceEvent } from "./schema.ts";
import { openStore } from "./store.ts";

export const eventEnvelope = Effect.fnUntraced(function* () {
	const now = yield* DateTime.now;
	return { id: randomUUID(), at: DateTime.toEpochMillis(now) };
});

/** Resolve repository identity through Git; ordinary non-repository sessions use their cwd. */
export const contextStore = Effect.fn("harnessLearning.contextStore")(function* (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	root?: string,
) {
	const cwd = ctx.cwd;
	const sessionId = ctx.sessionManager.getSessionId();
	const result = yield* Effect.tryPromise({
		try: (signal) => pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { signal, timeout: 5000 }),
		catch: (cause) => new HarnessError({ message: `Cannot resolve repository scope: ${toError(cause).message}` }),
	});
	if (result.killed || (result.code !== 0 && !/not a git repository/i.test(result.stderr)))
		return yield* new HarnessError({ message: `Cannot resolve repository scope: ${result.stderr.trim()}` });
	const scope = result.code === 0 ? result.stdout.trim() : cwd;
	if (scope.length === 0) return yield* new HarnessError({ message: "Git returned an empty repository scope" });
	const store = yield* openStore(scope, root);
	if (ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId)
		return yield* new HarnessError({
			message: "Session changed while resolving the learning scope; retry in the current session",
		});
	return store;
});

export function selectedModel(ctx: ExtensionContext): Result.Result<string, HarnessError> {
	return ctx.model === undefined
		? Result.fail(new HarnessError({ message: "Select a model before using harness learning" }))
		: Result.succeed(`${ctx.model.provider}/${ctx.model.id}`);
}

/** Raw visible message text, never thinking, tool arguments, details, or synthesized summaries. */
export function anchorText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "bashExecution") return message.output;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
	if (message.role === "toolResult" && ["harness_evidence", "harness_propose"].includes(message.toolName))
		return undefined;
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
}

export const anchoredEvidence = Effect.fn("harnessLearning.anchoredEvidence")(function* (
	ctx: ExtensionContext,
	input: { entryId: string; quote: string; behavior: string; attribution: EvidenceEvent["evidence"]["attribution"] },
) {
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	const entry = ctx.sessionManager.getBranch().find((item) => item.id === input.entryId);
	const text = entry === undefined ? undefined : anchorText(entry);
	if (text === undefined || !text.includes(input.quote))
		return yield* new HarnessError({ message: "Evidence must quote exact visible text from a current-branch message" });
	if (sessionFile === undefined)
		return yield* new HarnessError({ message: "Evidence requires a persistent session file" });
	const canonicalFile = yield* realPath(resolve(sessionFile)).pipe(
		Effect.mapError(
			(error) => new HarnessError({ message: `Cannot anchor session evidence: ${toError(error.cause).message}` }),
		),
	);
	if (
		ctx.sessionManager.getSessionId() !== sessionId ||
		ctx.sessionManager.getSessionFile() !== sessionFile ||
		!ctx.sessionManager.getBranch().some((item) => item.id === input.entryId && anchorText(item)?.includes(input.quote))
	)
		return yield* new HarnessError({
			message: "Session branch changed while anchoring evidence; retry on the current branch",
		});
	return { ...input, sessionId, sessionFile: canonicalFile };
});
