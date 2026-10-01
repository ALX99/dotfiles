import assert from "node:assert/strict";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { proposal } from "../../tests/fixtures.ts";
import type { LabSandbox } from "../docker.ts";
import { config } from "./fixtures.ts";
import { fakeModels, response } from "./runtime-fixtures.ts";

export const CORRECT_SOLUTION = "export const value = 42;\n";
export const REPAIR_ACTION = "Edit the authoritative source and regenerate all generated output before verifying.";
const BAD_ACTION = "Inspect the generator source carefully before deciding what to edit.";

export function controllerConfig() {
	const settings = config();
	settings.limits.maxCandidates = 2;
	settings.limits.maxRequests = 400;
	settings.limits.maxTotalTokens = 1_000_000;
	for (const task of settings.suite.tasks) {
		task.files[0]!.content =
			task.kind === "target" || task.kind === "holdout" ? "export const value = 0;\n" : CORRECT_SOLUTION;
		task.verify.files[0]!.content =
			"import assert from 'node:assert/strict';\n" +
			"import { readFileSync } from 'node:fs';\n" +
			`assert.equal(readFileSync('/workspace/src/input.mjs', 'utf8'), ${JSON.stringify(CORRECT_SOLUTION)});\n`;
		if (task.kind === "holdout") task.prompt += " PRIVATE_HOLDOUT_PROMPT";
	}
	return settings;
}

export function proposalResponse(context: Context, action = REPAIR_ACTION): AssistantMessage {
	const prompt = context.messages[0]!;
	assert.equal(prompt.role, "user");
	assert.equal(typeof prompt.content, "string");
	const data = JSON.parse(prompt.content as string) as {
		parentVersion: string;
		activeProcedures: { id: string }[];
		eligibleEvidence: { id: string }[];
	};
	return response(
		JSON.stringify({
			parentVersion: data.parentVersion,
			replaces: data.activeProcedures[0]?.id ?? null,
			procedure: { ...proposal().procedure, action },
			hypothesis: "Source-first regeneration repairs repeated generated-file mistakes without changing ordinary files.",
			attribution: "HARNESS_DEFICIENCY",
			evidenceIds: data.eligibleEvidence.slice(0, 2).map(({ id }) => id),
		}),
		"researcher",
	);
}

/** Deterministic fake provider and independent artifact checker; no real model or Docker calls. */
export function controllerBoundaries(rejectFirst = false) {
	let proposals = 0;
	let cleanup = 0;
	let verification = 0;
	const models = fakeModels(([model, context]) => {
		if (model.id === "researcher")
			return proposalResponse(context, rejectFirst && proposals++ === 0 ? BAD_ACTION : REPAIR_ACTION);
		const first = context.messages[0]!;
		assert.equal(first.role, "user");
		assert.equal(typeof first.content, "string");
		const repair =
			context.systemPrompt?.includes(REPAIR_ACTION) && /Synthetic (?:target|holdout)/.test(first.content as string);
		const message = response();
		if (repair && context.messages.at(-1)!.role === "user") {
			message.stopReason = "toolUse";
			message.content = [
				{
					type: "toolCall",
					id: "write-solution",
					name: "write",
					arguments: { path: "src/input.mjs", content: CORRECT_SOLUTION },
				},
			];
		}
		return message;
	});
	const sandbox: LabSandbox = {
		withWorkspace: (files, use) =>
			Effect.gen(function* () {
				const working = new Map(files.map(({ path, content }) => [path, content]));
				return yield* use({
					call: (tool) =>
						Effect.sync(() => {
							assert.equal(tool.name, "write");
							assert.equal(tool.arguments.path, "src/input.mjs");
							assert.equal(typeof tool.arguments.content, "string");
							working.set(tool.arguments.path, tool.arguments.content as string);
							return { text: "ok", isError: false };
						}),
					export: (paths) => Effect.succeed(paths.map((path) => ({ path, content: working.get(path)! }))),
				});
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						cleanup++;
					}),
				),
			),
		verify: (_task, artifacts) =>
			Effect.sync(() => {
				verification++;
				const passed = artifacts.find(({ path }) => path === "src/input.mjs")?.content === CORRECT_SOLUTION;
				return { verificationExitCode: passed ? 0 : 1, verificationOutput: passed ? "ok" : "expected value 42" };
			}),
	};
	return { models, sandbox, counts: () => ({ cleanup, verification }) };
}
