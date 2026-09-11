import * as assert from "node:assert/strict";
import { test } from "node:test";

import { type CodexWebSearchConfig, DEFAULT_CONFIG, type WebSearchMode } from "../config.ts";
import { applyHostedWebSearch, usesHostedWebSearch } from "../hosted-search.ts";

const CODEX_MODEL = { provider: "openai-codex", api: "openai-codex-responses" };
const OPENAI_MODEL = { provider: "openai", api: "openai-responses" };

function config(overrides: Partial<CodexWebSearchConfig> = {}): CodexWebSearchConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function functionTool(name: string): Record<string, unknown> {
	return { type: "function", name, parameters: { type: "object", properties: {} } };
}

function firstTool(applied: Record<string, unknown> | undefined): unknown {
	return Array.isArray(applied?.tools) ? applied.tools[0] : undefined;
}

test("the hosted tool is added for OpenAI Responses providers only", () => {
	for (const model of [CODEX_MODEL, OPENAI_MODEL]) {
		const applied = applyHostedWebSearch({ tools: [functionTool("bash")] }, model, config());
		assert.deepEqual(applied?.tools, [functionTool("bash"), { type: "web_search", external_web_access: true }]);
	}

	assert.equal(
		applyHostedWebSearch({ tools: [] }, { provider: "anthropic", api: "anthropic-messages" }, config()),
		undefined,
	);
	assert.equal(
		applyHostedWebSearch({ tools: [] }, { provider: "openrouter", api: "openai-responses" }, config()),
		undefined,
	);
	assert.equal(
		applyHostedWebSearch({ tools: [] }, { provider: "openai-codex", api: "openai-completions" }, config()),
		undefined,
	);
	assert.equal(applyHostedWebSearch({ tools: [] }, undefined, config()), undefined);

	assert.equal(usesHostedWebSearch(CODEX_MODEL, config()), true);
	assert.equal(usesHostedWebSearch(CODEX_MODEL, config({ enabled: false })), false);
	assert.equal(usesHostedWebSearch({ provider: "openrouter", api: "openai-responses" }, config()), false);
});

test("the configured mode maps to the Codex access flags", () => {
	const tool = (mode: WebSearchMode): unknown =>
		firstTool(applyHostedWebSearch({ tools: [] }, CODEX_MODEL, config({ mode })));

	assert.deepEqual(tool("cached"), { type: "web_search", external_web_access: false });
	assert.deepEqual(tool("live"), { type: "web_search", external_web_access: true });
	assert.deepEqual(tool("indexed"), { type: "web_search", external_web_access: true, indexed_web_access: true });
});

test("a request keeps its other tools and drops the suppressed ones", () => {
	const applied = applyHostedWebSearch(
		{ tools: [functionTool("bash"), functionTool("web_search"), functionTool("read")] },
		CODEX_MODEL,
		config(),
	);
	assert.deepEqual(applied?.tools, [
		functionTool("bash"),
		functionTool("read"),
		{ type: "web_search", external_web_access: true },
	]);
});

test("suppression follows the configured client tool names", () => {
	const payload = { tools: [functionTool("web_search"), functionTool("source_check")] };

	const configured = applyHostedWebSearch(payload, CODEX_MODEL, config({ suppressClientTools: ["source_check"] }));
	assert.deepEqual(configured?.tools, [functionTool("web_search"), { type: "web_search", external_web_access: true }]);

	const nothingSuppressed = applyHostedWebSearch(payload, CODEX_MODEL, config({ suppressClientTools: [] }));
	assert.deepEqual(nothingSuppressed?.tools, [
		functionTool("web_search"),
		functionTool("source_check"),
		{ type: "web_search", external_web_access: true },
	]);
});

test("search sources are requested alongside the existing include entries", () => {
	const applied = applyHostedWebSearch({ include: ["reasoning.encrypted_content"], tools: [] }, CODEX_MODEL, config());
	assert.deepEqual(applied?.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);

	const alreadyRequested = applyHostedWebSearch(
		{ include: ["web_search_call.action.sources"], tools: [] },
		CODEX_MODEL,
		config(),
	);
	assert.deepEqual(alreadyRequested?.include, ["web_search_call.action.sources"]);
});

test("payloads that already carry a hosted search tool, or no tools array, are handled", () => {
	const existing = { tools: [{ type: "web_search", external_web_access: false }, functionTool("bash")] };
	assert.equal(applyHostedWebSearch(existing, CODEX_MODEL, config()), undefined);

	const noTools = applyHostedWebSearch({ model: "gpt-5.6-luna" }, CODEX_MODEL, config());
	assert.deepEqual(noTools?.tools, [{ type: "web_search", external_web_access: true }]);
});

test("a disabled extension leaves the payload alone", () => {
	const payload = { tools: [functionTool("web_search")] };
	assert.equal(applyHostedWebSearch(payload, CODEX_MODEL, config({ enabled: false })), undefined);
});
