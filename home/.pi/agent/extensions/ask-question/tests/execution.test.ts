import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import askQuestionExtension, { executeAskQuestion } from "../index.ts";
import { AskQuestionParamsSchema, type AskQuestionDetails } from "../schema.ts";

const first = { question: "Pick a tool", alternatives: [{ label: "Fast" }, { label: "Simple" }] };
const second = { question: "Pick a style", alternatives: [{ label: "Minimal" }, { label: "Detailed" }] };

function context(ui: Partial<ExtensionContext["ui"]>): ExtensionContext {
	return { mode: "rpc", hasUI: true, ui } as ExtensionContext;
}

test("validates every question before prompting", async () => {
	let prompts = 0;
	await assert.rejects(
		executeAskQuestion(
			{ questions: [first, { ...second, alternatives: [{ label: " Same " }, { label: "Same" }] }] },
			undefined,
			context({
				select: async () => {
					prompts++;
					return "Fast";
				},
			}),
		),
		/must be distinct/u,
	);
	assert.equal(prompts, 0);
});

test("cancellation preserves earlier answers and leaves later questions unasked", async () => {
	const titles: string[] = [];
	const result = await executeAskQuestion(
		{ questions: [first, second, first] },
		undefined,
		context({
			select: async (title) => {
				titles.push(title);
				return titles.length === 1 ? "1. Fast" : undefined;
			},
		}),
	);
	assert.deepEqual(titles, ["Question 1 of 3: Pick a tool", "Question 2 of 3: Pick a style"]);
	assert.deepEqual(
		result.details.questions.map((question) => question.status),
		["answered", "cancelled", "not_asked"],
	);
	assert.equal(result.details.questions[0]?.answer, "Fast");
	assert.match(result.content[0]!.text, /Question was not asked/u);
});

test("cancelled or blank custom input returns to the same question", async () => {
	for (const customAnswer of [undefined, "   "]) {
		const titles: string[] = [];
		const result = await executeAskQuestion(
			{ questions: [first] },
			undefined,
			context({
				select: async (title) => {
					titles.push(title);
					return titles.length === 1 ? "4. Something else" : "2. Simple";
				},
				input: async () => customAnswer,
			}),
		);
		assert.deepEqual(titles, [first.question, first.question]);
		assert.equal(result.details.questions[0]?.answer, "Simple");
	}
});

test("custom answers and comparisons retain their outcomes", async () => {
	const result = await executeAskQuestion(
		{ questions: [first, second] },
		undefined,
		context({
			select: async (title) => (title.includes("1 of 2") ? "4. Something else" : "3. Compare options"),
			input: async () => "  Custom tool  ",
		}),
	);
	assert.equal(result.details.questions[0]?.answer, "Custom tool");
	assert.equal(result.details.questions[1]?.status, "compare");
});

test("abort during custom input does not reopen options or mark later questions declined", async () => {
	const controller = new AbortController();
	let prompts = 0;
	const result = await executeAskQuestion(
		{ questions: [first, second] },
		controller.signal,
		context({
			select: async () => {
				prompts++;
				return "4. Something else";
			},
			input: async () => {
				controller.abort();
				return undefined;
			},
		}),
	);
	assert.equal(prompts, 1);
	assert.deepEqual(
		result.details.questions.map((question) => question.status),
		["aborted", "not_asked"],
	);
});

test("an already aborted batch never opens a dialog", async () => {
	const result = await executeAskQuestion(
		{ questions: [first, second] },
		AbortSignal.abort(),
		context({
			select: async () => {
				assert.fail("unexpected dialog");
			},
		}),
	);
	assert.deepEqual(
		result.details.questions.map((question) => question.status),
		["not_asked", "not_asked"],
	);
});

test("RPC presents descriptions and returns labels without display decoration", async () => {
	const result = await executeAskQuestion(
		{
			questions: [
				{
					question: "Choose",
					alternatives: [
						{ label: "Fast", description: "Recommended: lowest latency" },
						{ label: "Simple", description: "Fewer dependencies" },
					],
				},
			],
		},
		undefined,
		context({
			select: async (_title, options) => {
				assert.equal(options[0], "1. Fast — Recommended: lowest latency");
				assert.equal(options[1], "2. Simple — Fewer dependencies");
				return options[0];
			},
			input: async () => assert.fail("ordinary answers must not open a comment prompt"),
		}),
	);
	assert.deepEqual(result.details.questions[0]?.answers, ["Fast"]);
});

test("RPC comment action asks for a choice and preserves the qualification separately", async () => {
	let prompts = 0;
	const result = await executeAskQuestion(
		{ questions: [first] },
		undefined,
		context({
			select: async (_title, options) => {
				prompts++;
				if (prompts === 1) return options.find((option) => option.endsWith("Add comment"));
				assert.deepEqual(options, ["1. Fast", "2. Simple"]);
				return options[0];
			},
			input: async (title) => {
				assert.match(title, /Comment on: Fast/u);
				return "  but without migration  ";
			},
		}),
	);
	const answer = result.details.questions[0]!;
	assert.deepEqual(answer.answers, ["Fast"]);
	assert.equal(answer.comment, "but without migration");
	assert.equal(answer.wasCustom, false);
	assert.match(result.content[0]!.text, /but without migration/u);
});

test("cancelling a comment returns to choices, while an empty comment submits the choice", async () => {
	for (const comment of [undefined, "   "]) {
		let prompts = 0;
		const result = await executeAskQuestion(
			{ questions: [first] },
			undefined,
			context({
				select: async (_title, options) => {
					prompts++;
					return prompts === 1 ? options.find((option) => option.endsWith("Add comment")) : options[0];
				},
				input: async () => comment,
			}),
		);
		assert.equal(prompts, comment === undefined ? 3 : 2);
		assert.equal(result.details.questions[0]?.answer, "Fast");
		assert.equal(result.details.questions[0]?.comment, undefined);
	}
});

test("aborting a comment stops the batch without retaining an unsubmitted selection", async () => {
	const controller = new AbortController();
	let prompts = 0;
	const result = await executeAskQuestion(
		{ questions: [first, second] },
		controller.signal,
		context({
			select: async (_title, options) => {
				prompts++;
				return prompts === 1 ? options.find((option) => option.endsWith("Add comment")) : options[0];
			},
			input: async () => {
				controller.abort();
				return "not submitted";
			},
		}),
	);
	assert.equal(prompts, 2);
	assert.deepEqual(
		result.details.questions.map((question) => question.status),
		["aborted", "not_asked"],
	);
	assert.deepEqual(result.details.questions[0]?.answers, []);
	assert.equal(result.details.questions[0]?.comment, undefined);
});

test("result renderer preserves errors and call renderer accepts partial arguments", () => {
	let tool: ToolDefinition<typeof AskQuestionParamsSchema, AskQuestionDetails> | undefined;
	const pi = {
		on: (_event: string, handler: (_event: unknown, ctx: ExtensionContext) => void) => handler({}, context({})),
		registerTool: (definition: typeof tool) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	askQuestionExtension(pi);
	assert.ok(tool?.renderResult);
	assert.ok(tool.renderCall);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const renderContext = { isError: true } as Parameters<NonNullable<typeof tool.renderResult>>[3];
	const rendered = tool.renderResult(
		{ content: [{ type: "text", text: "alternatives must be distinct" }], details: undefined } as unknown as Parameters<
			typeof tool.renderResult
		>[0],
		{ expanded: false, isPartial: false },
		theme,
		renderContext,
	);
	assert.match(rendered.render(80).join("\n"), /alternatives must be distinct/u);
	assert.doesNotMatch(rendered.render(80).join("\n"), /Cancelled/u);
	for (const [status, label] of [
		["not_asked", "Not asked"],
		["aborted", "Interrupted"],
	] as const) {
		const output: Component = tool.renderResult(
			{
				content: [],
				details: {
					questions: [
						{
							question: first.question,
							alternatives: ["Fast", "Simple"],
							answer: null,
							answers: [],
							wasCustom: false,
							action: null,
							status,
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext,
		);
		assert.ok(output.render(80).join("\n").includes(label));
	}
	const renderCall = tool.renderCall;
	assert.doesNotThrow(() => renderCall({} as Parameters<typeof renderCall>[0], theme, renderContext));
	const call = renderCall(
		{
			questions: [
				{ question: "Choose", alternatives: [{ label: "Fast", description: "Lowest latency" }, { label: "Simple" }] },
			],
		},
		theme,
		renderContext,
	);
	assert.match(call.render(80).join("\n"), /Fast — Lowest latency/u);
	assert.ok(tool.prepareArguments);
	assert.deepEqual(tool.prepareArguments({ questions: [{ question: "Old call", alternatives: ["A", "B"] }] }), {
		questions: [{ question: "Old call", alternatives: [{ label: "A" }, { label: "B" }] }],
	});
	assert.match(tool.promptGuidelines!.join("\n"), /recommended alternatives first/u);
	assert.match(tool.promptGuidelines!.join("\n"), /Never treat cancellation/u);
});
