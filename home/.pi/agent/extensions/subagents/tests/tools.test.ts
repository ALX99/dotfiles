import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { AgentWaitDeferredReason, AgentWaitInterruptedError, type AgentSummary } from "../agent-types.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import {
	AgentsStatusParamsSchema,
	CloseAgentParamsSchema,
	createSpawnAgentSchema,
	SteerAgentParamsSchema,
	AnswerAgentParamsSchema,
	WaitAgentsParamsSchema,
} from "../schemas.ts";
import { textResult } from "../tool-results.ts";
import { createAgentsStatusTool } from "../tools/agents-status.ts";
import { createAnswerAgentTool } from "../tools/answer-agent.ts";
import { createCloseAgentTool } from "../tools/close-agent.ts";
import { createFollowupAgentTool } from "../tools/followup-agent.ts";
import { createReadAgentResultTool } from "../tools/read-agent-result.ts";
import { createSteerAgentTool } from "../tools/steer-agent.ts";
import { spawnGuidelines, thinkingLevelsForProfiles } from "../tools/spawn-agent.ts";
import type { ProfilesConfig } from "../profiles.ts";
import { SpawnAdmissionController } from "../spawn-admission.ts";
import { executeWaitAgents, createWaitAgentsTool } from "../tools/wait-agents.ts";
import { RESULT_READ_DEFAULT_BYTES } from "../result-store.ts";

const summary: AgentSummary = {
	agent_id: "scout-1",
	agent: "scout",
	task_name: "inspect",
	profile: "fast",
	model: "provider/model",
	effective_thinking: "low",
	generation: 1,
	retained: false,
	status: "idle",
	started_at: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};

function nameRegistry(entries: AgentSummary[], lives: Record<string, unknown> = {}) {
	const byId = new Map(entries.map((entry) => [entry.agent_id, entry]));
	const resolveTarget = (target: string) => {
		const trimmed = target.trim();
		const byAddress = byId.get(trimmed) ?? entries.find((entry) => entry.task_name === trimmed);
		if (!byAddress) throw new Error(`Unknown agent '${trimmed}'.`);
		return { agent_id: byAddress.agent_id, summary: byAddress };
	};
	return {
		resolveTarget,
		resolveGeneration: (target: string, generation?: number) => {
			const resolved = resolveTarget(target);
			return { ...resolved, generation: generation ?? resolved.summary.generation };
		},
		liveTarget: (target: string, generation?: number) => {
			const resolved = resolveTarget(target);
			if (generation !== undefined && resolved.summary.generation !== generation)
				throw new Error(
					`Agent '${resolved.summary.task_name}' is at generation ${resolved.summary.generation}; target generation ${generation} is stale and was not affected.`,
				);
			const agent = lives[resolved.agent_id];
			if (!agent) throw new Error(`No live session for agent '${resolved.agent_id}'.`);
			return { ...resolved, generation: generation ?? resolved.summary.generation, agent };
		},
		getLive: (id: string) => {
			const agent = lives[id];
			if (!agent) throw new Error(`No live session for agent '${id}'.`);
			return agent;
		},
		summary: (id: string) => {
			const found = byId.get(id);
			if (!found) throw new Error(`Unknown agent_id '${id}'.`);
			return found;
		},
		list: () => entries,
	};
}

test("semantic message, handoff, and answer fields have no arbitrary character cap", () => {
	const spawn = createSpawnAgentSchema({
		agents: ["scout"],
		profiles: ["fast"],
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
	});
	const large = "界".repeat(200_000);
	assert.equal(Check(spawn, { message: large, handoff: large }), true);
	assert.equal(Check(spawn, { message: large, handoff: large, agent: "scout" }), true);
	assert.equal(Check(SteerAgentParamsSchema, { target: "scout-1", generation: 1, message: large }), true);
	assert.equal(
		Check(AnswerAgentParamsSchema, {
			target: "scout-1",
			generation: 1,
			question_id: "question-1",
			answer: large,
		}),
		true,
	);
});

test("spawn schema rejects removed nested budgets and exposes explicit retention", () => {
	const schema = createSpawnAgentSchema({
		agents: ["scout"],
		profiles: ["fast"],
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
	});
	assert.equal(Object.hasOwn(schema.properties, "child_spawn_budget"), false);
	assert.equal(Object.hasOwn(schema.properties, "retain"), true);
	assert.equal(Check(schema, { message: "work", agent: "scout", child_spawn_budget: 0 }), false);
});

test("thinking overrides are safe across every configured model fallback", () => {
	const config: Pick<ProfilesConfig, "profiles"> = {
		profiles: {
			fast: {
				description: "Fast",
				modelPriority: [
					{ id: "provider/first", defaultThinking: "medium", maxThinking: "high" },
					{ id: "provider/fallback", defaultThinking: "high", maxThinking: "high" },
				],
			},
		},
	};
	assert.deepEqual(thinkingLevelsForProfiles(config, ["fast"]), ["high"]);
});

test("spawn guidance reserves fast for bounded mechanical work", () => {
	const guidelines = spawnGuidelines(
		[
			{ name: "worker", description: "Implementation" },
			{ name: "general", description: "Analysis" },
		],
		[
			{ name: "fast", description: "Mechanical work" },
			{ name: "balanced", description: "Judgment work" },
		],
	);
	assert.ok(
		guidelines.some((guideline) => guideline.includes("Do not select it for debugging or root-cause analysis")),
	);
	assert.ok(guidelines.some((guideline) => guideline.includes("well-scoped implementation")));
	assert.ok(guidelines.some((guideline) => guideline.includes("Balanced is the default for work requiring judgment")));
});

test("spawn guidance nests roles and profiles under the sentence that introduces them", () => {
	const guidelines = spawnGuidelines(
		[{ name: "worker", description: "Implementation" }],
		[{ name: "fast", description: "Mechanical work" }],
	);
	const roleMap = guidelines.find((guideline) => guideline.startsWith("Choose the narrowest matching role"));
	const profileMap = guidelines.find((guideline) => guideline.startsWith("Choose the least expensive"));
	assert.match(roleMap ?? "", /\n {2}- worker: Implementation$/);
	assert.match(profileMap ?? "", /\n {2}- fast: Mechanical work$/);
	// The resolution caveat belongs to the whole profile list, not to each profile.
	assert.equal(guidelines.join("\n").match(/enabled scoped models/g)?.length, 1);
});

test("spawn guidance names flat verbs and name addressing", () => {
	const guidelines = spawnGuidelines(
		[{ name: "worker", description: "Implementation" }],
		[{ name: "fast", description: "Mechanical work" }],
	);
	const joined = guidelines.join("\n");
	assert.match(joined, /wait_agents/);
	assert.match(joined, /followup_agent/);
	assert.match(joined, /steer_agent/);
	assert.match(joined, /answer_agent/);
	assert.match(joined, /close_agent/);
	assert.match(joined, /agents_status/);
	assert.match(joined, /task_name/);
	assert.doesNotMatch(joined, /send_agent/);
	assert.doesNotMatch(joined, /agent_input/);
	assert.doesNotMatch(joined, /agent_control/);
});

test("wait schema accepts targets with defaulted generations", () => {
	assert.equal(Check(WaitAgentsParamsSchema, { targets: [{ target: "scout-1", generation: 1 }] }), true);
	assert.equal(Check(WaitAgentsParamsSchema, { targets: [{ target: "inspect" }] }), true);
	assert.equal(Check(WaitAgentsParamsSchema, { agent_ids: ["scout-1"] }), false);
	assert.equal(Check(WaitAgentsParamsSchema, { targets: [] }), false);
});

test("status accepts a bounded archived-agent limit", () => {
	assert.equal(Check(AgentsStatusParamsSchema, {}), true);
	assert.equal(Check(AgentsStatusParamsSchema, { closed_limit: 0 }), true);
	assert.equal(Check(AgentsStatusParamsSchema, { closed_limit: 32 }), true);
	assert.equal(Check(AgentsStatusParamsSchema, { closed_limit: 33 }), false);
});

test("close accepts an optional generation", () => {
	assert.equal(Check(CloseAgentParamsSchema, { target: "inspect" }), true);
	assert.equal(Check(CloseAgentParamsSchema, { target: "inspect", generation: 2 }), true);
	assert.equal(Check(CloseAgentParamsSchema, { target: "inspect", generation: 0 }), false);
});

test("generic tool truncation does not offer unrelated result reconstruction", () => {
	const result = textResult("x".repeat(100 * 1024), { summaries: [] });
	const text = result.content[0];
	assert.equal(text?.type, "text");
	if (text?.type === "text") assert.doesNotMatch(text.text, /read_agent_result/);
});

test("admission reports running lifecycle separately from occupied retained-session capacity", () => {
	const config = {
		rootPolicy: { maxConcurrentRootAgents: 2 },
		profiles: {
			fast: {
				description: "Fast",
				modelPriority: [{ id: "provider/model", defaultThinking: "low", maxThinking: "low" }],
			},
		},
		agentPolicies: { scout: { defaultProfile: "fast", allowedProfiles: ["fast"] } },
	} as ProfilesConfig;
	const admission = new SpawnAdmissionController(config, {
		capacity: () => [
			{ ...summary, status: "running" },
			{ ...summary, agent_id: "scout-2", retained: true },
		],
	} as never);
	assert.deepEqual(admission.capacity(), { root: { live: 1, occupied: 2, limit: 2 } });
	assert.throws(
		() => admission.admit({ agent: "scout", profile: "fast" }),
		/2 admission slots are occupied \(1 currently running\)/,
	);
});

const waitingRunDetails: ReadonlyRunDetails = {
	agent: "scout",
	taskName: "inspect",
	profile: "fast",
	model: "provider/model",
	effectiveThinking: "low",
	finalText: "done",
	startTime: 0,
	toolCount: 0,
	recentTools: [],
	lastMessage: "",
	lastActivityTime: 0,
	contextUsage: { tokens: null, contextWindow: 100_000, percent: null },
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	resultId: "a".repeat(64),
	aborted: false,
};

test("wait_agents trims a wave and observes completion repeatably", async () => {
	const waits: string[] = [];
	const running = { ...summary, status: "running" as const };
	const runtime = {
		registry: {
			...nameRegistry([running]),
			wait: async (id: string) => {
				waits.push(id);
				return waitingRunDetails;
			},
		},
	};
	const first = await executeWaitAgents(
		{
			targets: [{ target: " scout-1 " }, { target: "inspect", generation: 1 }],
		},
		runtime,
		undefined,
		() => 0,
	);
	assert.deepEqual(waits, ["scout-1"]);
	assert.deepEqual(
		first.details.outcomes.map((outcome) => outcome.status),
		["settled"],
	);
	const second = await executeWaitAgents({ targets: [{ target: "inspect" }] }, runtime, undefined, () => 0);
	assert.deepEqual(
		second.details.outcomes.map((outcome) => outcome.status),
		["settled"],
	);
});

test("wait_agents defaults missing generations to latest and settles stale ones", async () => {
	const runtime = {
		registry: {
			...nameRegistry([{ ...summary, generation: 2, status: "idle" as const }]),
			wait: async () => {
				throw new Error("settled generations must not wait");
			},
		},
	};
	const result = await executeWaitAgents(
		{
			targets: [{ target: "inspect", generation: 1 }, { target: "scout-1" }],
		},
		runtime,
		undefined,
		() => 0,
	);
	assert.deepEqual(
		result.details.outcomes.map((outcome) => outcome.status),
		["settled", "settled"],
	);
	assert.deepEqual(
		result.details.outcomes.map((outcome) => outcome.generation),
		[1, 2],
	);
});

test("wait_agents fails future generations and unknown targets explicitly", async () => {
	const runtime = {
		registry: {
			...nameRegistry([summary]),
			wait: async () => {
				throw new Error("future generations must not wait");
			},
		},
	};
	const result = await executeWaitAgents(
		{ targets: [{ target: "scout-1", generation: 2 }, { target: "nobody" }] },
		runtime,
		undefined,
	);
	assert.deepEqual(
		result.details.outcomes.map((outcome) => outcome.status),
		["failed", "failed"],
	);
	assert.match(result.details.outcomes[0]?.error ?? "", /does not exist yet/);
	assert.match(result.details.outcomes[1]?.error ?? "", /Unknown agent/);
});

test("wait_agents shares one composed signal across its wave", async () => {
	const controller = new AbortController();
	const signals: AbortSignal[] = [];
	const execution = executeWaitAgents(
		{
			targets: [{ target: "scout-1" }, { target: "scout-2" }],
		},
		{
			registry: {
				...nameRegistry([
					{ ...summary, status: "running" },
					{ ...summary, agent_id: "scout-2", task_name: "second", status: "running" },
				]),
				wait: async (id: string, signal: AbortSignal | undefined) => {
					assert.ok(signal);
					signals.push(signal);
					return new Promise<ReadonlyRunDetails>((_, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			},
		},
		controller.signal,
	);
	controller.abort(new Error("parent moved on"));
	await assert.rejects(execution, /parent moved on/);
	assert.equal(signals.length, 2);
	assert.equal(signals[0], signals[1]);
});

test("wait_agents releases its wave when one child asks for input", async () => {
	const waitingDetails: ReadonlyRunDetails = {
		...waitingRunDetails,
		pendingQuestion: { question_id: "question-1", question: "Proceed?", options: ["Yes", "No"] },
	};
	const released: unknown[] = [];
	const result = await executeWaitAgents(
		{
			targets: [{ target: "scout-1" }, { target: "scout-2" }],
		},
		{
			registry: {
				...nameRegistry([
					{ ...summary, status: "running" as const },
					{ ...summary, agent_id: "scout-2", task_name: "second", status: "running" as const },
				]),
				wait: async (id: string, signal: AbortSignal | undefined) => {
					if (id === "scout-1") return waitingDetails;
					return new Promise<ReadonlyRunDetails>((_, reject) => {
						signal?.addEventListener(
							"abort",
							() => {
								released.push(signal.reason);
								reject(new AgentWaitInterruptedError(id, signal.reason));
							},
							{ once: true },
						);
					});
				},
			},
		},
		undefined,
	);
	assert.equal(released.length, 1);
	assert.ok(released[0] instanceof AgentWaitDeferredReason);
	assert.deepEqual(
		result.details.outcomes.map((outcome) => outcome.status),
		["waiting_input", "cancelled"],
	);
	assert.deepEqual(
		result.details.outcomes.map((outcome) => outcome.generation),
		[1, 1],
	);
});

test("answer_agent preserves the exact nonblank answer for direct UI delivery", async () => {
	let delivered = "";
	const tool = createAnswerAgentTool({
		registry: nameRegistry([summary], {
			"scout-1": {
				answerQuestion: async (_questionId: string, answer: string) => {
					delivered = answer;
				},
				summary: () => summary,
			},
		}),
	} as never);
	await tool.execute(
		"call-1",
		{ target: "inspect", generation: 1, question_id: "question-1", answer: "  exact answer  " },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(delivered, "  exact answer  ");
});

test("steer_agent rejects stale generations without affecting the child", async () => {
	let steered = false;
	const tool = createSteerAgentTool({
		registry: nameRegistry([{ ...summary, generation: 2, status: "running" }], {
			"scout-1": {
				steer: async () => {
					steered = true;
				},
				summary: () => ({ ...summary, generation: 2, status: "running" }),
			},
		}),
	} as never);
	await assert.rejects(
		tool.execute("call-1", { target: "inspect", generation: 1, message: "focus" }, undefined, undefined, {} as never),
		/stale/,
	);
	assert.equal(steered, false);
});

test("agents_status includes a bounded recent closed history", async () => {
	const closed = Array.from({ length: 11 }, (_, index) => ({
		...summary,
		agent_id: `closed-${index + 1}`,
		task_name: `closed task ${index + 1}`,
		status: "closed" as const,
		outcome: "succeeded" as const,
	}));
	const tool = createAgentsStatusTool({
		registry: {
			getLive: (id: string) => {
				throw new Error(`unexpected getLive ${id}`);
			},
			summary: (id: string) => [summary, ...closed].find((candidate) => candidate.agent_id === id)!,
			list: () => [summary, ...closed],
			close: async () => {},
		},
		admission: {
			capacity: () => ({
				root: { live: 2, occupied: 2, limit: 4 },
			}),
		},
	} as never);
	const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /"root"[\s\S]*"live": 2/);
	assert.deepEqual(
		result.details?.summaries.map((agent) => agent.agent_id),
		["scout-1", ...closed.slice(1).map((agent) => agent.agent_id)],
	);
	assert.deepEqual(result.details?.capacity, {
		root: { live: 2, occupied: 2, limit: 4 },
	});

	const completeHistory = await tool.execute("call-2", { closed_limit: 32 }, undefined, undefined, {} as never);
	assert.deepEqual(
		completeHistory.details?.summaries.map((agent) => agent.agent_id),
		["scout-1", ...closed.map((agent) => agent.agent_id)],
	);

	const noHistory = await tool.execute("call-3", { closed_limit: 0 }, undefined, undefined, {} as never);
	assert.deepEqual(
		noHistory.details?.summaries.map((agent) => agent.agent_id),
		["scout-1"],
	);
});

test("close_agent aborts a running child and disposes it in one step", async () => {
	const events: string[] = [];
	const tool = createCloseAgentTool({
		registry: {
			...nameRegistry([{ ...summary, status: "running" as const }]),
			close: async () => {
				events.push("close");
			},
		},
	} as never);
	const result = await tool.execute("call-1", { target: "inspect" }, undefined, undefined, {} as never);
	assert.deepEqual(events, ["close"]);
	assert.equal(result.details?.summaries[0]?.agent_id, "scout-1");
});

test("close_agent disposes a settled child without interrupting", async () => {
	const events: string[] = [];
	const tool = createCloseAgentTool({
		registry: {
			...nameRegistry([summary]),
			close: async () => {
				events.push("close");
			},
		},
	} as never);
	await tool.execute("call-1", { target: "scout-1", generation: 1 }, undefined, undefined, {} as never);
	assert.deepEqual(events, ["close"]);
});

test("close_agent rejects stale generations without affecting the child", async () => {
	const events: string[] = [];
	const tool = createCloseAgentTool({
		registry: {
			...nameRegistry([{ ...summary, generation: 2, status: "running" as const }]),
			close: async () => {
				events.push("close");
			},
		},
	} as never);
	await assert.rejects(
		tool.execute("call-1", { target: "inspect", generation: 1 }, undefined, undefined, {} as never),
		/stale/,
	);
	assert.deepEqual(events, []);
});

test("wait_agents returns immediately when a target already needs input", async () => {
	const result = await executeWaitAgents(
		{ targets: [{ target: "inspect" }, { target: "second" }] },
		{
			registry: {
				...nameRegistry([
					{
						...summary,
						status: "running",
						pending_question: { question_id: "question-1", question: "Proceed?", options: ["Yes", "No"] },
					},
					{ ...summary, agent_id: "scout-2", task_name: "second", status: "running" },
				]),
				wait: async () => {
					throw new Error("a barrier must not wait after input is already required");
				},
			},
		},
		undefined,
	);
	assert.deepEqual(
		result.details.outcomes.map((outcome) => outcome.status),
		["waiting_input", "cancelled"],
	);
});

test("wait_agents claims nested usage once while repeat observations stay free", async () => {
	const settled = { ...summary, status: "idle" as const };
	const activated: AgentSummary[] = [];
	let claims = 0;
	const tool = createWaitAgentsTool(
		{ activate: () => [], activateForState: (next: AgentSummary) => activated.push(next) } as never,
		{
			registry: {
				...nameRegistry([{ ...summary, status: "running" as const }]),
				wait: async () => waitingRunDetails,
				summary: () => settled,
				list: () => [settled],
			},
			claimUsage: () => {
				claims += 1;
				return claims === 1 ? settled.usage : undefined;
			},
		} as never,
	);

	const first = await tool.execute("call-1", { targets: [{ target: "inspect" }] }, undefined, undefined, {} as never);
	assert.deepEqual(first.details?.accountedGenerations, [{ agentId: "scout-1", generation: 1 }]);
	assert.ok(first.usage);
	assert.deepEqual(activated, [settled]);

	const second = await tool.execute("call-2", { targets: [{ target: "scout-1" }] }, undefined, undefined, {} as never);
	assert.equal(second.details?.accountedGenerations, undefined);
	assert.equal(second.usage, undefined);
	assert.equal(claims, 2);
});

test("followup_agent reuses the stable address and forwards foreground cancellation", async () => {
	const calls: Array<{ message: string; background: boolean; signal: unknown }> = [];
	let unsubscribed = 0;
	const live = {
		summary: () => summary,
		subscribe: () => () => {
			unsubscribed += 1;
		},
		followUp: async (message: string, background: boolean, signal: unknown) => {
			calls.push({ message, background, signal });
			return waitingRunDetails;
		},
	};
	const activated: AgentSummary[] = [];
	const controller = new AbortController();
	const updates: unknown[] = [];
	const tool = createFollowupAgentTool(
		{ activate: () => [], activateForState: (next: AgentSummary) => activated.push(next) } as never,
		{
			registry: { ...nameRegistry([summary], { "scout-1": live }), list: () => [summary] },
			ticks: new Map(),
			claimUsage: () => summary.usage,
		} as never,
	);

	const result = await tool.execute(
		"call-1",
		{ target: "inspect", message: "continue" },
		controller.signal,
		(update) => updates.push(update),
		{} as never,
	);
	assert.deepEqual(calls, [{ message: "continue", background: false, signal: controller.signal }]);
	assert.equal(unsubscribed, 1);
	assert.equal(result.details, waitingRunDetails);
	assert.ok(result.usage);
	assert.deepEqual(activated, [summary]);
	assert.ok(updates.length >= 0);
});

test("followup_agent runs detached follow-ups without claiming their usage yet", async () => {
	const calls: Array<{ background: boolean; signal: unknown }> = [];
	const live = {
		summary: () => summary,
		followUp: async (_message: string, background: boolean, signal: unknown) => {
			calls.push({ background, signal });
			return waitingRunDetails;
		},
	};
	const tool = createFollowupAgentTool(
		{ activate: () => [], activateForState: () => [] } as never,
		{
			registry: { ...nameRegistry([summary], { "scout-1": live }), list: () => [summary] },
			ticks: new Map(),
			claimUsage: () => {
				throw new Error("background usage must be claimed on delivery, not at launch");
			},
		} as never,
	);

	const result = await tool.execute(
		"call-1",
		{ target: "scout-1", message: "continue", background: true },
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [{ background: true, signal: undefined }]);
	assert.equal(result.usage, undefined);
});

test("read_agent_result forwards one target read with its paging mode", async () => {
	const page = { generation: 3, text: "exact", next_cursor: undefined };
	const requests: Array<{ target: string; options: unknown }> = [];
	const tool = createReadAgentResultTool({
		readResultByAddress: (async (target: string, options: unknown) => {
			requests.push({ target, options });
			return page;
		}) as never,
		list: () => [],
	} as never);

	const result = await tool.execute("call-1", { target: "work", cursor: "v1.a.0" }, undefined, undefined, {} as never);
	assert.deepEqual(requests, [
		{
			target: "work",
			options: { cursor: "v1.a.0", maxBytes: RESULT_READ_DEFAULT_BYTES },
		},
	]);
	assert.equal(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}").text, "exact");
	assert.equal(result.details, page);
});

test("read_agent_result forwards explicit generations unchanged", async () => {
	const page = { generation: 2, text: "evicted", next_cursor: undefined };
	const requests: Array<{ target: string; options: unknown }> = [];
	const tool = createReadAgentResultTool({
		readResultByAddress: (async (target: string, options: unknown) => {
			requests.push({ target, options });
			return page;
		}) as never,
		list: () => [],
	} as never);

	await tool.execute("call-1", { target: "evicted-1", generation: 2 }, undefined, undefined, {} as never);
	assert.deepEqual(requests, [
		{ target: "evicted-1", options: { generation: 2, maxBytes: RESULT_READ_DEFAULT_BYTES } },
	]);
});

test("spawn guidance carries the resolved profile mapping as its own guideline", () => {
	const hint =
		"Live subagent models: fast → provider/cheap; you are running provider/strong. Children run models at least as capable as yours.";
	const guidelines = spawnGuidelines(
		[{ name: "worker", description: "Implementation" }],
		[{ name: "fast", description: "Mechanical work" }],
		10,
		hint,
	);

	assert.ok(guidelines.includes(hint), "the hint must travel as a guideline so a prompt replacement keeps it");
	const hintIndex = guidelines.indexOf(hint);
	const profileIndex = guidelines.findIndex((guideline) => guideline.startsWith("Choose the least expensive"));
	assert.equal(hintIndex, profileIndex + 1, "the hint follows the profile choices it explains");
});

test("spawn guidance omits the hint when no profile resolves", () => {
	const guidelines = spawnGuidelines([{ name: "worker", description: "Implementation" }], [], 10);

	assert.equal(
		guidelines.some((guideline) => guideline.startsWith("Live subagent models")),
		false,
	);
});
