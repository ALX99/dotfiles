import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import nestedContext, {
	collectNestedContextFiles,
	formatNestedContext,
	injectedContextPaths,
	NESTED_CONTEXT_MESSAGE_TYPE,
	patchTargetPaths,
	toolCallTargetPaths,
} from "../nested-context.ts";

function makeRepo(): string {
	return mkdtempSync(join(tmpdir(), "nested-context-"));
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [relative, content] of Object.entries(files)) {
		const absolute = join(root, relative);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, content);
	}
}

interface SentMessage {
	content: string;
	details?: unknown;
	options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
}

interface ToolCallEvent {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

interface ExtensionHarness {
	handlers: Map<string, (event: never, ctx: never) => unknown>;
	sent: SentMessage[];
	entries: unknown[];
	fireToolCall(event: ToolCallEvent, cwd: string): Promise<void>;
	fireSessionStart(reason: string): Promise<void>;
}

function loadExtension(): ExtensionHarness {
	const harness: ExtensionHarness = {
		handlers: new Map(),
		sent: [],
		entries: [],
		async fireToolCall(event, cwd) {
			const handler = this.handlers.get("tool_call");
			await handler?.(event as never, { cwd } as never);
		},
		async fireSessionStart(reason) {
			const handler = this.handlers.get("session_start");
			await handler?.({ reason } as never, { sessionManager: { getBranch: () => this.entries } } as never);
		},
	};
	nestedContext({
		on(name: string, handler: never) {
			harness.handlers.set(name, handler);
		},
		sendMessage(message: SentMessage, options?: SentMessage["options"]) {
			harness.sent.push({ ...message, ...(options === undefined ? {} : { options }) });
		},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI);
	return harness;
}

test("collects context files from directories strictly below cwd, shallowest first", () => {
	const root = makeRepo();
	writeTree(root, {
		"A/AGENTS.md": "rules for A",
		"A/B/AGENTS.md": "rules for B",
		"A/B/file.txt": "",
	});

	const loaded = new Set<string>();
	const found = collectNestedContextFiles(join(root, "A/B/file.txt"), root, loaded);

	assert.deepEqual(
		found.map((file) => [file.path, file.content]),
		[
			[join(root, "A/AGENTS.md"), "rules for A"],
			[join(root, "A/B/AGENTS.md"), "rules for B"],
		],
	);
});

test("prefers the override file within a directory and falls back to CLAUDE.md", () => {
	const overrideRoot = makeRepo();
	writeTree(overrideRoot, {
		"sub/AGENTS.override.md": "override",
		"sub/AGENTS.md": "base",
	});
	assert.deepEqual(
		collectNestedContextFiles(join(overrideRoot, "sub/x.ts"), overrideRoot, new Set())[0]?.content,
		"override",
	);

	const claudeRoot = makeRepo();
	writeTree(claudeRoot, { "sub/CLAUDE.md": "claude rules" });
	assert.deepEqual(
		collectNestedContextFiles(join(claudeRoot, "sub/x.ts"), claudeRoot, new Set())[0]?.content,
		"claude rules",
	);
});

test("skips already-loaded paths and files outside or at cwd", () => {
	const root = makeRepo();
	writeTree(root, { "A/AGENTS.md": "rules", "file.txt": "" });

	const loaded = new Set<string>();
	assert.equal(collectNestedContextFiles(join(root, "A/file.txt"), root, loaded).length, 1);
	assert.deepEqual(collectNestedContextFiles(join(root, "A/file.txt"), root, loaded), []);

	assert.deepEqual(collectNestedContextFiles(join(root, "file.txt"), root, new Set()), []);
	const outside = makeRepo();
	assert.deepEqual(collectNestedContextFiles(join(outside, "x.ts"), root, new Set()), []);
});

test("extracts target paths from read/edit/write inputs resolved against cwd", () => {
	const root = makeRepo();
	assert.deepEqual(toolCallTargetPaths("read", { path: "a.txt" }, root), [join(root, "a.txt")]);
	assert.deepEqual(toolCallTargetPaths("edit", { path: "/abs/a.txt" }, root), ["/abs/a.txt"]);
	assert.deepEqual(toolCallTargetPaths("read", { path: "~/notes.md" }, root), [join(homedir(), "notes.md")]);
	assert.deepEqual(toolCallTargetPaths("write", { path: "~/notes.md" }, root), [join(homedir(), "notes.md")]);
	assert.deepEqual(toolCallTargetPaths("read", { path: "~" }, root), [homedir()]);
	assert.deepEqual(toolCallTargetPaths("edit", { path: "@a.txt" }, root), [join(root, "a.txt")]);
	assert.deepEqual(toolCallTargetPaths("bash", { command: "echo hi > a.txt" }, root), []);
});

test("parses apply_patch file lines into deduplicated absolute paths", () => {
	const root = makeRepo();
	const patch = [
		"*** Begin Patch",
		"*** Add File: src/new.ts",
		"+export {}",
		"*** Update File: src/new.ts",
		"@@",
		"-old",
		"+new",
		"*** Move to: src/renamed.ts",
		"*** Delete File: docs/old.md",
		"*** End Patch",
	].join("\n");

	assert.deepEqual(patchTargetPaths(patch), ["src/new.ts", "src/renamed.ts", "docs/old.md"]);
	assert.deepEqual(toolCallTargetPaths("apply_patch", { patch }, root), [
		join(root, "src/new.ts"),
		join(root, "src/renamed.ts"),
		join(root, "docs/old.md"),
	]);
});

test("injects discovered context once per path and steers it into the conversation", async () => {
	const root = makeRepo();
	writeTree(root, { "A/B/AGENTS.md": "rules for B" });
	const harness = loadExtension();

	await harness.fireToolCall({ toolName: "edit", toolCallId: "t1", input: { path: "A/B/file.ts" } }, root);
	assert.equal(harness.sent.length, 1);

	const message = harness.sent[0]!;
	assert.equal(message.details && (message.details as { paths: string[] }).paths[0], join(root, "A/B/AGENTS.md"));
	assert.match(message.content, /rules for B/);
	assert.deepEqual(message.options, { deliverAs: "steer", triggerTurn: false });

	// Same subtree again: cached, no duplicate injection.
	await harness.fireToolCall({ toolName: "read", toolCallId: "t2", input: { path: join(root, "A/other.ts") } }, root);
	assert.equal(harness.sent.length, 1);

	// A different subtree still injects.
	writeTree(root, { "C/AGENTS.md": "rules for C" });
	await harness.fireToolCall(
		{
			toolName: "apply_patch",
			toolCallId: "t3",
			input: { patch: "*** Begin Patch\n*** Update File: C/x.ts\n@@\n-a\n+b\n*** End Patch" },
		},
		root,
	);
	assert.equal(harness.sent.length, 2);
	assert.match(harness.sent[1]!.content, /rules for C/);
});

test("a new session clears the cache while resume keeps it", async () => {
	const root = makeRepo();
	writeTree(root, { "A/AGENTS.md": "rules" });
	const harness = loadExtension();

	await harness.fireToolCall({ toolName: "read", toolCallId: "t1", input: { path: "A/f.ts" } }, root);
	assert.equal(harness.sent.length, 1);

	// A fresh conversation has an empty branch, so nothing is cached.
	await harness.fireSessionStart("new");
	await harness.fireToolCall({ toolName: "read", toolCallId: "t2", input: { path: "A/f.ts" } }, root);
	assert.equal(harness.sent.length, 2);
});

function injectedEntry(paths: string[]): Record<string, unknown> {
	return { type: "custom_message", customType: NESTED_CONTEXT_MESSAGE_TYPE, details: { paths } };
}

test("a restored branch seeds the cache from its own injections", async () => {
	const root = makeRepo();
	writeTree(root, { "A/AGENTS.md": "rules" });
	const harness = loadExtension();

	harness.entries.push(injectedEntry([join(root, "A/AGENTS.md")]), injectedEntry(["/other/B.md"]));
	await harness.fireSessionStart("resume");
	await harness.fireToolCall({ toolName: "read", toolCallId: "t1", input: { path: "A/f.ts" } }, root);
	assert.equal(harness.sent.length, 0);
});

test("injectedContextPaths reads only matching custom messages with string paths", () => {
	const entries = [
		injectedEntry(["/repo/A/AGENTS.md", "/repo/B/CLAUDE.md"]),
		{ type: "custom_message", customType: "subagent-completion", details: { paths: ["/ignored"] } },
		{ type: "custom_message", customType: NESTED_CONTEXT_MESSAGE_TYPE },
		injectedEntry(["/kept.md", 42 as unknown as string, null as unknown as string]),
		{ type: "custom", customType: NESTED_CONTEXT_MESSAGE_TYPE, data: { paths: ["/also-ignored"] } },
	];
	assert.deepEqual(injectedContextPaths(entries as never), ["/repo/A/AGENTS.md", "/repo/B/CLAUDE.md", "/kept.md"]);
});

test("formats injected content with per-path instruction blocks", () => {
	const formatted = formatNestedContext([{ path: "/repo/A/AGENTS.md", content: "be terse" }]);
	assert.match(formatted, /<context-file path="\/repo\/A\/AGENTS\.md">\nbe terse\n<\/context-file>/);
	assert.match(formatted, /NESTED|instructions when working/i);
	assert.equal(formatted.includes(NESTED_CONTEXT_MESSAGE_TYPE), false);
});
