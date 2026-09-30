import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Effect, Result } from "effect";

import { runPromise } from "../_shared/effect-runtime.ts";
import { DEFAULT_CONFIG, loadConfig, type OpenAIServerCompactionConfig } from "./config.ts";
import {
	isResponsesRequest,
	supportsServerCompaction,
	thinkingLevelToResponsesReasoning,
	withReplayedHistory,
} from "./models.ts";
import {
	buildCompactionSummaryText,
	callRemoteCompaction,
	generatePortableSummary,
	stringHeaders,
} from "./remote-compaction.ts";
import { buildToolsPayload, isReplayableMessage, messagesToResponseItems } from "./response-items.ts";
import { buildRemoteCompactionDetails, replayHistoryFor, type BranchEntryLike } from "./session-history.ts";

/**
 * OpenAI's own compaction, alongside Pi's.
 *
 * When Pi is about to compact a conversation, this asks OpenAI to compact it instead:
 * the API answers with an encrypted item that replaces the history, which is stored in
 * Pi's compaction entry next to Pi's own text summary. Later turns for that model
 * replay the stored history as their input, so the conversation continues from the
 * provider's state while the summary stays available to every other reader of the
 * session.
 *
 * Everything it needs comes from the session file: the stored history decides what a
 * request sends, so a fork, a navigation, and a restart in a new process all behave the
 * same without keeping state that could disagree with the branch.
 *
 * A session whose credential cannot use OpenAI's state, and any model other than an
 * OpenAI Responses one, is left exactly as Pi would have left it. Config lives in
 * `~/.pi/agent/openai-server-compaction.json`, overridden by
 * `.pi/openai-server-compaction.json` in the project and by
 * `PI_OPENAI_SERVER_COMPACTION_ENABLED` in the environment.
 */

export default async function openAIServerCompactionExtension(pi: ExtensionAPI): Promise<void> {
	let config: OpenAIServerCompactionConfig = DEFAULT_CONFIG;
	let loadedCwd: string | undefined;
	let reportedDiagnostics = false;

	/** Load the config once per working directory; `/reload` re-imports and re-reads it. */
	async function resolveConfig(ctx: ExtensionContext): Promise<OpenAIServerCompactionConfig> {
		if (loadedCwd === ctx.cwd) return config;
		const loaded = await runPromise(loadConfig(ctx.cwd));
		config = loaded.config;
		loadedCwd = ctx.cwd;
		if (!reportedDiagnostics && loaded.diagnostics.length > 0) {
			reportedDiagnostics = true;
			if (ctx.hasUI) ctx.ui.notify(loaded.diagnostics.join("\n"), "warning");
		}
		return config;
	}

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (
			model === undefined ||
			!supportsServerCompaction(model, (candidate) => ctx.modelRegistry.isUsingOAuth(candidate))
		) {
			return undefined;
		}
		if (!(await resolveConfig(ctx)).enabled) return undefined;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || auth.apiKey === undefined) return undefined;

		// A previous compaction of this model holds the state OpenAI would compact
		// again; otherwise the whole branch is the conversation to compact.
		const input =
			replayHistoryFor(event.branchEntries, model) ?? messagesToResponseItems(branchMessages(event.branchEntries));
		const thinkingLevel = pi.getThinkingLevel();
		const reasoning = model.reasoning ? thinkingLevelToResponsesReasoning(thinkingLevel) : undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const [localSummary, remoteCompaction] = await runPromise(
			Effect.all(
				[
					Effect.result(
						generatePortableSummary({
							modelRegistry: ctx.modelRegistry,
							preparation: event.preparation,
							model,
							apiKey: auth.apiKey,
							headers: stringHeaders(auth.headers),
							...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
							signal: event.signal,
							thinkingLevel,
						}),
					),
					Effect.result(
						callRemoteCompaction({
							model,
							apiKey: auth.apiKey,
							...(auth.headers === undefined ? {} : { headers: auth.headers }),
							...(sessionId === undefined ? {} : { sessionId }),
							input,
							instructions: ctx.getSystemPrompt(),
							tools: buildToolsPayload(pi.getAllTools(), pi.getActiveTools()),
							...(reasoning === undefined ? {} : { reasoning }),
							signal: event.signal,
						}),
					),
				],
				{ concurrency: 2 },
			),
		);

		if (Result.isFailure(remoteCompaction)) {
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(
					`OpenAI remote compaction failed; Pi's own compaction is used instead. ${remoteCompaction.failure.message}`,
					"warning",
				);
			}
			// Pi would summarize the same messages, so hand it what this call already produced.
			if (Result.isSuccess(localSummary)) return { compaction: localSummary.success };
			return undefined;
		}

		const summary = Result.isSuccess(localSummary)
			? localSummary.success
			: {
					summary: buildCompactionSummaryText(model),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				};

		return {
			compaction: {
				...summary,
				details: {
					...(summary.details === undefined ? {} : { localSummaryDetails: summary.details }),
					remoteCompaction: buildRemoteCompactionDetails(
						model,
						remoteCompaction.success.output,
						remoteCompaction.success.usage,
					),
				},
			},
		};
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		// The same model also makes chat, image, and classifier calls, which must not be patched.
		if (model === undefined || !isResponsesRequest(event.payload)) return undefined;
		if (!supportsServerCompaction(model, (candidate) => ctx.modelRegistry.isUsingOAuth(candidate))) return undefined;
		if (!(await resolveConfig(ctx)).enabled) return undefined;

		const history = replayHistoryFor(ctx.sessionManager.getBranch(), model);
		return history === undefined ? undefined : withReplayedHistory(event.payload, history);
	});
}

/** The branch's Pi messages, in order; custom messages have no Responses items. */
function branchMessages(entries: readonly BranchEntryLike[]): Message[] {
	return entries.flatMap((entry) =>
		entry.type === "message" && isReplayableMessage(entry.message) ? [entry.message] : [],
	);
}
