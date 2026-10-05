import assert from "node:assert/strict";
import test from "node:test";

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";

import type { ResponseItem } from "../response-items.ts";
import {
	buildRemoteCompactionDetails,
	extractRemoteCompactionDetails,
	replayHistoryFor as replaySessionHistory,
} from "../session-history.ts";
import { sessionBranch, type BranchEntryLike } from "./session-fixtures.ts";

function replayHistoryFor(entries: readonly BranchEntryLike[], target: Model<Api>): ResponseItem[] | undefined {
	return replaySessionHistory(sessionBranch(entries), target);
}

const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 400_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<Api>;
}

const COMPACTION_ITEM: ResponseItem = { type: "compaction", encrypted_content: "opaque" };

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-6.1-sol",
		usage: NO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function messageEntry(id: string, message: Message): BranchEntryLike {
	return { type: "message", id, message };
}

/** The compaction entry the session file holds after a successful remote compaction. */
function compactionEntry(id: string, encryptedContent = "opaque"): BranchEntryLike {
	return {
		type: "compaction",
		id,
		details: {
			remoteCompaction: buildRemoteCompactionDetails(model({}), [
				{ type: "compaction", encrypted_content: encryptedContent },
			]),
		},
	};
}

function userItem(text: string): ResponseItem {
	return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistantItem(text: string): ResponseItem {
	return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

test("a compaction stores the replacement history under the model's key", () => {
	const details = buildRemoteCompactionDetails(model({}), [COMPACTION_ITEM], {
		...NO_USAGE,
		totalTokens: 15,
	});
	assert.equal(details.modelKey, "openai:openai-responses:gpt-6.1-sol");
	assert.deepEqual(details.replacementHistory, [COMPACTION_ITEM]);
	assert.equal(details.usage?.totalTokens, 15);
});

test("stored details are read back from an entry, including one written by v1", () => {
	const read = extractRemoteCompactionDetails({
		remoteCompaction: buildRemoteCompactionDetails(model({}), [COMPACTION_ITEM]),
	});
	assert.equal(read?.version, 2);

	const legacy = extractRemoteCompactionDetails({
		version: 1,
		provider: "openai-responses-compact",
		modelKey: "openai:openai-responses:gpt-6.1-sol",
		replacementHistory: [COMPACTION_ITEM],
	});
	assert.equal(legacy?.version, 1, "sessions compacted by the extension this replaces still replay");

	assert.equal(
		extractRemoteCompactionDetails({ version: 2, provider: "something-else", replacementHistory: [COMPACTION_ITEM] }),
		undefined,
	);
	assert.equal(
		extractRemoteCompactionDetails({
			version: 2,
			provider: "openai-responses-compaction",
			replacementHistory: [],
		}),
		undefined,
		"an entry with nothing to replay is not remote state",
	);
	assert.equal(extractRemoteCompactionDetails(undefined), undefined);
});

test("replay is the stored history followed by the turns this model answered after it", () => {
	const branch = [
		compactionEntry("compaction-1"),
		messageEntry("m1", user("after compaction")),
		messageEntry("m2", assistant("same model")),
	];

	assert.partialDeepStrictEqual(replayHistoryFor(branch, model({})), [
		COMPACTION_ITEM,
		userItem("after compaction"),
		assistantItem("same model"),
	]);
});

test("a turn another model answered is not replayed to this one", () => {
	const branch = [
		compactionEntry("compaction-1"),
		messageEntry("m1", user("after compaction")),
		messageEntry("m2", assistant("same model")),
		messageEntry("m3", user("after a switch")),
		messageEntry("m4", assistant("another model", { provider: "commandcode", model: "deepseek-v4.1-flash" })),
	];

	assert.partialDeepStrictEqual(replayHistoryFor(branch, model({})), [
		COMPACTION_ITEM,
		userItem("after compaction"),
		assistantItem("same model"),
	]);
});

test("the question in flight is replayed, or the patched request would answer nothing", () => {
	const branch = [
		compactionEntry("compaction-1"),
		messageEntry("m1", user("first question")),
		messageEntry("m2", assistant("first answer")),
		messageEntry("m3", user("question asked while the request is being patched")),
	];

	assert.partialDeepStrictEqual(replayHistoryFor(branch, model({})), [
		COMPACTION_ITEM,
		userItem("first question"),
		assistantItem("first answer"),
		userItem("question asked while the request is being patched"),
	]);
});

test("replay preserves extension instructions, task guidance, and search recall after compaction", () => {
	const branch = [
		compactionEntry("compaction-1"),
		...["nested-context", "tasks:continue", "tasks:reminder", "codex-web-search-recall"].map((customType, index) => ({
			type: "custom_message",
			id: `custom-${index}`,
			customType,
			content: `required ${customType}`,
			display: false,
		})),
		messageEntry("user", user("continue")),
	];
	const history = replayHistoryFor(branch, model({}));
	assert.ok(history !== undefined);
	for (const customType of ["nested-context", "tasks:continue", "tasks:reminder", "codex-web-search-recall"]) {
		assert.match(JSON.stringify(history), new RegExp(`required ${customType}`));
	}
});

test("replay applies native context edits instead of reviving raw message content", () => {
	const branch = [
		compactionEntry("compaction-1"),
		messageEntry("user", user("obsolete instructions")),
		messageEntry("removed", user("must not reach the model")),
		{ type: "context_edit", id: "edit", targetId: "user", replacement: { content: "corrected instructions" } },
		{ type: "context_edit", id: "omit", targetId: "removed", replacement: null },
	];
	const history = replayHistoryFor(branch, model({}));
	assert.match(JSON.stringify(history), /corrected instructions/);
	assert.doesNotMatch(JSON.stringify(history), /obsolete instructions|must not reach the model/);
});

test("the newest compaction on the branch is the one replayed", () => {
	const branch = [
		compactionEntry("compaction-1"),
		messageEntry("m1", user("between two compactions")),
		compactionEntry("compaction-2", "newer"),
		messageEntry("m2", user("after the second")),
	];

	assert.deepEqual(
		replayHistoryFor(branch, model({})),
		[{ type: "compaction", encrypted_content: "newer" }, userItem("after the second")],
		"each entry carries its own history",
	);
});

test("a newer Pi-only compaction supersedes an earlier encrypted checkpoint", () => {
	const branch = [
		compactionEntry("remote"),
		messageEntry("user", user("new work")),
		{ type: "compaction", id: "local", details: {} },
		messageEntry("next", user("continue from Pi's summary")),
	];
	assert.equal(replayHistoryFor(branch, model({})), undefined);
});

test("nothing is replayed for another model, or without a compaction", () => {
	const branch = [compactionEntry("compaction-1"), messageEntry("m1", user("hi"))];
	assert.equal(replayHistoryFor(branch, model({ id: "gpt-6-astra" })), undefined, "state belongs to one model");
	assert.equal(replayHistoryFor(branch, model({ provider: "commandcode", api: "openai-completions" })), undefined);
	assert.equal(replayHistoryFor([{ type: "message", id: "m1", message: user("hi") }], model({})), undefined);
	assert.equal(replayHistoryFor([{ type: "compaction", id: "c1", details: {} }], model({})), undefined);
});

test("a model that cannot read images gets a replay it can accept", () => {
	const imageTurn: Message = {
		role: "user",
		content: [
			{ type: "text", text: "look" },
			{ type: "image", mimeType: "image/png", data: "AAAA" },
		],
		timestamp: 0,
	};
	const textOnly = model({ input: ["text"] });
	const replay = replayHistoryFor([compactionEntry("compaction-1"), messageEntry("m1", imageTurn)], textOnly);
	assert.ok(replay !== undefined);
	const content = (replay[1] as { content: { type: string }[] }).content;
	assert.deepEqual(
		content.map((part) => part.type),
		["input_text", "input_text"],
	);
});
