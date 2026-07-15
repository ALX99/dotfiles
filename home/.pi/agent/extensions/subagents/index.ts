/** Persistent RPC-backed subagents with stable, session-runtime IDs. */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, formatAgentList, resolveAgent } from "./agents.ts";
import { formatAgentCounts, sanitizeTerminalText, showAgentDashboard } from "./dashboard.ts";
import { AgentRegistry, ManagedAgent, type AgentSummary } from "./host.ts";
import { DEPTH_ENV, resolveEffectiveModel, type RunDetails } from "./process.ts";
import {
	manageTick,
	renderAgentSummaries,
	renderCallHeader,
	renderManagementCall,
	renderResultBlock,
	renderWaitCall,
	renderWaitResult,
	type AgentSummaryDetails,
	type WaitDetails,
} from "./render.ts";

const MAX_DEPTH = 3;
const MAX_HANDOFF_CHARS = 8_000;
const MAX_WAIT_MS = 30 * 60 * 1_000;

export default function (pi: ExtensionAPI) {
	const agents = discoverAgents().match(
		(list) => list,
		(error) => { throw new Error(discoveryErrorMessage(error)); },
	);
	const registry = new AgentRegistry();
	const ticks = new Map<string, NodeJS.Timeout>();
	const pendingCompletions = new Map<string, AgentSummary>();
	let shuttingDown = false;
	let activeContext: ExtensionContext | undefined;
	let unsubscribeRegistry: (() => void) | undefined;
	const agentList = agents.map((agent) => `- **${agent.name}** — ${agent.description}`).join("\n");
	const agentLiterals = agents.map((agent) => Type.Literal(agent.name));
	const agentTypeSchema = agentLiterals.length
		? Type.Union(agentLiterals, { description: "Name of the subagent role. Omit for default." })
		: Type.String({ description: "Name of the subagent role. Omit for default." });
	const reasoningSchema = Type.Union([
		Type.Literal("none"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
		Type.Literal("high"), Type.Literal("xhigh"),
	]);

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		unsubscribeRegistry?.();
		const syncRegistryUi = () => {
			updateAgentStatus(ctx, registry);
			discardSupersededCompletions(pendingCompletions, registry);
		};
		unsubscribeRegistry = registry.subscribe(syncRegistryUi);
		syncRegistryUi();
	});

	pi.on("agent_end", () => {
		const completions = [...pendingCompletions.values()];
		pendingCompletions.clear();
		if (completions.length) sendCompletions(pi, completions);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		pendingCompletions.clear();
		unsubscribeRegistry?.();
		unsubscribeRegistry = undefined;
		activeContext?.ui.setStatus("subagents", undefined);
		activeContext = undefined;
		for (const tick of ticks.values()) clearInterval(tick);
		ticks.clear();
		await registry.closeAll();
	});

	pi.registerCommand("agents", {
		description: "Inspect and manage subagents owned by this session",
		handler: async (_args, ctx) => showAgentDashboard(ctx, registry),
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Spawn an isolated persistent subagent. Foreground by default; background calls return an agent ID immediately. Depth capped at 3.",
		promptSnippet: "Spawn an isolated persistent subagent with its own context, model, and tools",
		promptGuidelines: [
			"Use spawn_agent to delegate a self-contained task to an isolated subagent.",
			`Available agent types:\n${agentList}\n\nOmit \`agent_type\` for the default role.`,
			"When using spawn_agent, provide a complete assignment: objective, scope, constraints, expected output, and verification.",
			"Use background=true only when independent work can continue; completion is delivered automatically.",
			"When the current response needs background results, call wait_agent once with all relevant IDs before answering; consumed results will not trigger redundant follow-up turns.",
			"For parallel reviews, give agents non-overlapping scopes and ask for the evidence and uncertainty the task requires; synthesize and deduplicate findings in the parent.",
			"Use followup_agent to reuse a completed agent's context, send_agent to steer running work, wait_agent to wait, and interrupt_agent or close_agent for lifecycle control.",
			"Subagents are non-interactive: they cannot open user dialogs and must report questions in text.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Complete self-contained assignment for the child." }),
			handoff: Type.Optional(Type.String({ maxLength: MAX_HANDOFF_CHARS, description: "Known paths, decisions, facts, or small excerpts from the parent." })),
			task_name: Type.Optional(Type.String({ description: "Short UI label; derived from message when omitted." })),
			agent_type: Type.Optional(agentTypeSchema),
			reasoning_effort: Type.Optional(reasoningSchema),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current cwd." })),
			background: Type.Optional(Type.Boolean({ description: "Return after launch and notify on completion. Default false." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parentDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
			if (parentDepth >= MAX_DEPTH) throw new Error(`spawn_agent capped at depth ${MAX_DEPTH}. Perform this work in the current session.`);
			const requestedType = params.agent_type?.trim() || "default";
			const agentConfig = resolveAgent(agents, requestedType).match(
				(value) => value,
				(error) => { throw new Error(`Unknown agent_type '${error.requested}'. Available: ${formatAgentList(error.available)}.`); },
			);
			const model = resolveEffectiveModel(agentConfig.model);
			const [provider, modelId] = (model ?? "").split("/");
			const contextWindow = provider && modelId ? ctx.modelRegistry.find(provider, modelId)?.contextWindow : undefined;
			const background = params.background === true;
			const managed = new ManagedAgent({
				defaultCwd: ctx.cwd,
				cwd: params.cwd,
				agent: agentConfig,
				model,
				contextWindow,
				reasoningEffort: params.reasoning_effort,
				parentDepth,
				onUpdate: onUpdate ? (details) => {
					details.contextWindow = contextWindow;
					onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
				} : undefined,
				onBackgroundComplete: (summary) => {
					if (shuttingDown || (summary.status !== "idle" && summary.status !== "failed")) return;
					notifyCompletion(activeContext, summary);
					if (activeContext?.isIdle()) sendCompletions(pi, [summary]);
					else pendingCompletions.set(summary.agent_id, summary);
				},
			});
			registry.add(managed);
			try {
				const details = await managed.start(
					params.message,
					params.handoff?.trim() || undefined,
					params.task_name?.trim() || clipAtWord(params.message, 60),
					background,
					background ? undefined : signal,
				);
				details.contextWindow = contextWindow;
				const summary = managed.summary();
				return {
					content: [{ type: "text" as const, text: background ? formatLaunch(summary) : formatCompletion(summary) }],
					details,
				};
			} catch (error) {
				if (!managed.isAvailable()) registry.delete(managed.id);
				throw new Error(`Agent ${managed.id} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
		},
		renderCall(args, theme, context) {
			const container = context.lastComponent instanceof Container
				? (context.lastComponent.clear(), context.lastComponent)
				: new Container();
			renderCallHeader(container, args, context.expanded, theme);
			return container;
		},
		renderResult(result, options, theme, context) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				if (!options.isPartial) manageTick(ticks, context.toolCallId, false, () => context.invalidate());
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			manageTick(ticks, context.toolCallId, options.isPartial, () => context.invalidate());
			return renderResultBlock(details, options, theme);
		},
	});

	pi.registerTool({
		name: "send_agent",
		label: "Send Agent",
		description: "Steer a currently running subagent at the next message boundary.",
		parameters: Type.Object({ agent_id: Type.String(), message: Type.String() }),
		async execute(_id, params) {
			const agent = registry.get(params.agent_id);
			await agent.steer(params.message);
			return textResult(`Steering message accepted by ${params.agent_id}.`, { summaries: [agent.summary()] } satisfies AgentSummaryDetails);
		},
		renderCall(args, theme, context) {
			return renderManagementCall("send_agent", args.agent_id, args.message, context.expanded, registry.list(), theme);
		},
		renderResult(result, options, theme) {
			const details = result.details as AgentSummaryDetails | undefined;
			return details?.summaries
				? renderAgentSummaries("send_agent · steering accepted", details.summaries, options.expanded, theme)
				: resultText(result);
		},
	});

	pi.registerTool({
		name: "followup_agent",
		label: "Follow Up Agent",
		description: "Give an existing subagent another task using its retained context. Foreground by default.",
		parameters: Type.Object({
			agent_id: Type.String(),
			message: Type.String(),
			task_name: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, onUpdate) {
			const agent = registry.get(params.agent_id);
			agent.setOnUpdate(onUpdate ? (details) => onUpdate({ content: [{ type: "text", text: "(running…)" }], details }) : undefined);
			const background = params.background === true;
			const details = await agent.followUp(params.message, params.task_name?.trim() || clipAtWord(params.message, 60), background, background ? undefined : signal);
			const summary = agent.summary();
			return { content: [{ type: "text" as const, text: background ? formatLaunch(summary) : formatCompletion(summary) }], details };
		},
		renderCall(args, theme, context) {
			return renderManagementCall("followup_agent", args.agent_id, args.message, context.expanded, registry.list(), theme);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				if (!options.isPartial) manageTick(ticks, context.toolCallId, false, () => context.invalidate());
				return resultText(result);
			}
			manageTick(ticks, context.toolCallId, options.isPartial, () => context.invalidate());
			return renderResultBlock(details, options, theme);
		},
	});

	pi.registerTool({
		name: "wait_agent",
		label: "Wait Agent",
		description: "Wait for specified subagents to settle or until the timeout expires. Settled results are consumed, preventing redundant automatic follow-up turns.",
		parameters: Type.Object({
			agent_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
			timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_MS })),
		}),
		async execute(_id, params, signal) {
			const requested = [...new Set(params.agent_ids)];
			const targets = requested.map((id) => registry.get(id));
			const startTime = Date.now();
			await Promise.allSettled(targets.map((agent) => agent.wait(params.timeout_ms, signal)));
			const summaries = targets.map((agent) => agent.summary());
			for (const summary of summaries) {
				if (summary.status !== "idle" && summary.status !== "failed") continue;
				const pending = pendingCompletions.get(summary.agent_id);
				if (pending?.generation === summary.generation) pendingCompletions.delete(summary.agent_id);
			}
			return jsonResult(summaries, {
				summaries,
				elapsedMs: Date.now() - startTime,
				...(params.timeout_ms === undefined ? {} : { timeoutMs: params.timeout_ms }),
			} satisfies WaitDetails);
		},
		renderCall(args, theme) {
			return renderWaitCall(args.agent_ids, args.timeout_ms, registry.list(), theme);
		},
		renderResult(result, options, theme) {
			const details = result.details as WaitDetails | undefined;
			return details?.summaries ? renderWaitResult(details, options.expanded, theme) : resultText(result);
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List subagents owned by this session and their current status.",
		parameters: Type.Object({}),
		async execute() {
			const summaries = registry.list();
			return jsonResult(summaries, { summaries } satisfies AgentSummaryDetails);
		},
		renderCall(_args, theme, context) {
			return renderManagementCall("list_agents", undefined, undefined, context.expanded, registry.list(), theme);
		},
		renderResult(result, options, theme) {
			const details = result.details as AgentSummaryDetails | undefined;
			return details?.summaries ? renderAgentSummaries("list_agents", details.summaries, options.expanded, theme) : resultText(result);
		},
	});

	pi.registerTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description: "Abort a subagent's current run while retaining it for follow-up work.",
		parameters: Type.Object({ agent_id: Type.String() }),
		async execute(_id, params) {
			const agent = registry.get(params.agent_id);
			await agent.interrupt();
			const summary = agent.summary();
			return jsonResult(summary, { summaries: [summary] } satisfies AgentSummaryDetails);
		},
		renderCall(args, theme, context) {
			return renderManagementCall("interrupt_agent", args.agent_id, undefined, context.expanded, registry.list(), theme);
		},
		renderResult(result, options, theme) {
			const details = result.details as AgentSummaryDetails | undefined;
			return details?.summaries ? renderAgentSummaries("interrupt_agent", details.summaries, options.expanded, theme) : resultText(result);
		},
	});

	pi.registerTool({
		name: "close_agent",
		label: "Close Agent",
		description: "Terminate a subagent process. Closed agents cannot be resumed.",
		parameters: Type.Object({ agent_id: Type.String() }),
		async execute(_id, params) {
			await registry.close(params.agent_id);
			const summary = registry.get(params.agent_id).summary();
			return jsonResult(summary, { summaries: [summary] } satisfies AgentSummaryDetails);
		},
		renderCall(args, theme, context) {
			return renderManagementCall("close_agent", args.agent_id, undefined, context.expanded, registry.list(), theme);
		},
		renderResult(result, options, theme) {
			const details = result.details as AgentSummaryDetails | undefined;
			return details?.summaries ? renderAgentSummaries("close_agent", details.summaries, options.expanded, theme) : resultText(result);
		},
	});
}

function notifyCompletion(ctx: ExtensionContext | undefined, summary: AgentSummary): void {
	const label = sanitizeTerminalText(summary.task_name || summary.agent_type);
	ctx?.ui.notify(
		summary.status === "failed" ? `Subagent failed: ${label}` : `Subagent complete: ${label}`,
		summary.status === "failed" ? "error" : "info",
	);
}

function sendCompletions(pi: ExtensionAPI, summaries: AgentSummary[]): void {
	const completions = summaries.map((summary) => {
		const output = escapeXml(summary.final_text || summary.error || "(no output)");
		return `<subagent_completion agent_id="${summary.agent_id}" generation="${summary.generation}" status="${summary.status}">\n${output}\n</subagent_completion>`;
	});
	pi.sendMessage({
		customType: "subagent-completion",
		content: completions.length === 1 ? completions[0] : `<subagent_completions>\n${completions.join("\n")}\n</subagent_completions>`,
		display: true,
		details: summaries.length === 1 ? summaries[0] : summaries,
	}, { deliverAs: "followUp", triggerTurn: true });
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function discardSupersededCompletions(pending: Map<string, AgentSummary>, registry: AgentRegistry): void {
	for (const current of registry.list()) {
		const queued = pending.get(current.agent_id);
		if (queued && isCompletionSuperseded(queued, current)) {
			pending.delete(current.agent_id);
		}
	}
}

export function isCompletionSuperseded(queued: AgentSummary, current: AgentSummary): boolean {
	return queued.agent_id === current.agent_id
		&& (current.generation > queued.generation || current.status === "closed");
}

function updateAgentStatus(ctx: ExtensionContext, registry: AgentRegistry): void {
	const views = registry.views();
	if (!views.length) {
		ctx.ui.setStatus("subagents", undefined);
		return;
	}
	const active = views.some((view) => view.summary.status === "starting" || view.summary.status === "running");
	const failed = views.some((view) => view.summary.status === "failed");
	const color = failed ? "error" : active ? "warning" : "success";
	ctx.ui.setStatus("subagents", ctx.ui.theme.fg(color, `agents ${formatAgentCounts(views)}`));
}

function formatLaunch(summary: AgentSummary): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\nCompletion will be delivered automatically. Use send_agent, followup_agent, wait_agent, interrupt_agent, or close_agent with this agent_id.`;
}

function formatCompletion(summary: AgentSummary): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\n${summary.final_text || summary.error || "(no output)"}`;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): Text {
	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text ?? "" : "(no output)", 0, 0);
}

function textResult(text: string, details: unknown = {}) {
	const bounded = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 512, maxLines: DEFAULT_MAX_LINES - 2 });
	const output = bounded.truncated ? `${bounded.content}\n\n[Management output truncated; query fewer agents.]` : bounded.content;
	return { content: [{ type: "text" as const, text: output }], details };
}

function jsonResult(value: unknown, details: unknown = {}) {
	return textResult(JSON.stringify(value, null, 2), details);
}

function discoveryErrorMessage(error: { kind: string; dir: string; cause?: NodeJS.ErrnoException }): string {
	if (error.kind === "read_dir") return `Could not read agents dir ${error.dir}: ${error.cause?.message ?? error.cause?.code ?? "unknown error"}.`;
	return `No agent files found in ${error.dir}.`;
}

function clipAtWord(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	const cut = oneLine.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${space > max * 0.5 ? oneLine.slice(0, space) : cut}…`;
}
