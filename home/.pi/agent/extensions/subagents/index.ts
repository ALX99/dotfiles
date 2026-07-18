/** Persistent RPC-backed subagents with stable, session-runtime IDs. */

import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, formatAgentList, resolveAgent, type AgentConfig } from "./agents.ts";
import { formatAgentCounts, sanitizeTerminalText, showAgentDashboard } from "./dashboard.ts";
import { AgentRegistry, executionCanDelegate, ManagedAgent, SpawnAdmissionController, type AgentSummary, type AgentView } from "./host.ts";
import { parseChildExecutionContext, type ChildExecutionContext, type RunDetails } from "./process.ts";
import { loadProfiles, resolveRun, type ProfilesConfig } from "./profiles.ts";
import {
	formatDuration,
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

const MAX_HANDOFF_CHARS = 8_000;
export const DEFAULT_WAIT_MS = 15 * 60 * 1_000;

export default function (pi: ExtensionAPI) {
	const discovered = discoverAgents();
	let agents: AgentConfig[];
	let agentErrors: string[] = [];
	if (discovered.isOk()) {
		agents = discovered.value;
	} else if (discovered.error.kind === "configuration") {
		agents = discovered.error.agents;
		agentErrors = discovered.error.errors;
	} else {
		throw new Error(discoveryErrorMessage(discovered.error));
	}
	const profileResult = loadProfiles(agents);
	const configurationErrors = [
		...agentErrors,
		...(profileResult.isErr() ? profileResult.error.errors : []),
	];
	if (configurationErrors.length) throw new Error(configurationErrors.join("\n"));
	const profiles = profileResult._unsafeUnwrap();
	const executionContext = parseChildExecutionContext();
	const registry = new AgentRegistry();
	const admission = new SpawnAdmissionController(
		profiles,
		registry,
		executionContext?.treeId ?? randomUUID(),
		executionContext,
	);
	// Hard leaves do not register any member of the subagent tool family.
	if (!admission.canExposeSubagentTools()) return;
	const ticks = new Map<string, NodeJS.Timeout>();
	const pendingCompletions = new Map<string, AgentSummary>();
	let shuttingDown = false;
	let activeContext: ExtensionContext | undefined;
	let unsubscribeRegistry: (() => void) | undefined;
	let uiTick: NodeJS.Timeout | undefined;
	const agentList = agents.map((agent) => {
		const policy = profiles.agentPolicies[agent.name]!;
		return `- **${agent.name}** — ${agent.description} Default profile: \`${policy.defaultProfile}\`; allowed: ${policy.allowedProfiles.map((name) => `\`${name}\``).join(", ")}.`;
	}).join("\n");
	const spawnParameters = createSpawnAgentSchema(agents, profiles, executionContext);

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		unsubscribeRegistry?.();
		if (uiTick) clearInterval(uiTick);
		uiTick = undefined;
		const syncRegistryUi = () => {
			updateAgentUi(ctx, registry);
			discardSupersededCompletions(pendingCompletions, registry);
			const active = registry.views().some((view) => isActiveAgent(view));
			if (active && !uiTick) uiTick = setInterval(() => updateAgentUi(ctx, registry), 1_000).unref();
			else if (!active && uiTick) {
				clearInterval(uiTick);
				uiTick = undefined;
			}
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
		activeContext?.ui.setWidget("subagents", undefined);
		activeContext = undefined;
		if (uiTick) clearInterval(uiTick);
		uiTick = undefined;
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
		description: "Spawn an admitted persistent subagent. Root may explicitly grant a general agent up to two delegation credits; nested delegation is limited to fast scouts. Maximum depth is 2.",
		promptSnippet: "Spawn an isolated persistent subagent with its own context, model, and tools",
		promptGuidelines: [
			"The root agent must perform orchestration itself; expensive or specialized children are leaves, not replacement coordinators.",
			"Launch scouts directly for narrow, non-overlapping evidence gathering, then pass the collected evidence to a single deep reviewer for synthesis and judgment.",
			"Treat every deep reviewer as a leaf. Use followup_agent when an existing agent retains useful context, and do not replace an idle deep reviewer with a new one.",
			"Grant nested delegation only when a general coordinator genuinely needs up to two narrow fast reconnaissance tasks.",
			"Use spawn_agent to delegate a self-contained task to an isolated subagent.",
			`Available agents and execution policies:\n${agentList}`,
			"Normally choose only an agent. Use profile only as an explicit allowed override; never select an individual model.",
			"When using spawn_agent, provide a complete assignment: objective, scope, constraints, expected output, and verification.",
			"Use background=true only when independent work can continue; completion is delivered automatically.",
			"When the current response needs background results, call wait_agent once with all relevant IDs before answering; consumed results will not trigger redundant follow-up turns.",
			"For parallel reviews, give agents non-overlapping scopes and ask for the evidence and uncertainty the task requires; synthesize and deduplicate findings in the parent.",
			"Use followup_agent when continuing the same subject and the completed agent's retained context is useful, especially when a scout already has relevant repository knowledge. Spawn a new agent for an unrelated topic, independent implementation scope, or different role or execution policy.",
			"Use send_agent to steer running work, wait_agent to wait, and interrupt_agent or close_agent for lifecycle control.",
			"Subagents are non-interactive: they cannot open user dialogs and must report questions in text.",
		],
		parameters: spawnParameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawParams = params as Record<string, unknown>;
			const hasDelegationGrant = Object.hasOwn(rawParams, "delegation_credits");
			if (executionContext && hasDelegationGrant) {
				throw new Error("Only the top-level process may supply delegation_credits; remove it from this nested spawn.");
			}
			if (hasDelegationGrant && typeof rawParams.delegation_credits !== "number") {
				throw new Error(`delegation_credits must be an integer from 0 to ${profiles.rootPolicy.maxDelegationGrant}.`);
			}
			const requestedAgent = params.agent.trim();
			const agentConfig = resolveAgent(agents, requestedAgent).match(
				(value) => value,
				(error) => { throw new Error(`Unknown agent '${error.requested}'. Available: ${formatAgentList(error.available)}.`); },
			);
			const resolvedRun = resolveRun({
				config: profiles,
				modelRegistry: ctx.modelRegistry,
				agent: agentConfig,
				profile: params.profile,
				requestedThinking: params.thinking,
			});
			const childContext = admission.admit({
				agent: resolvedRun.agent,
				profile: resolvedRun.profile,
				...(hasDelegationGrant
					? { delegationCredits: rawParams.delegation_credits as number }
					: {}),
			});
			const contextWindow = resolvedRun.contextWindow;
			const background = params.background === true;
			const managed = new ManagedAgent({
				defaultCwd: ctx.cwd,
				cwd: params.cwd,
				agent: agentConfig,
				resolvedRun,
				childContext,
				subagentToolsEnabled: executionCanDelegate(profiles, childContext),
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
			return renderManagementCall(
				"followup_agent",
				args.agent_id,
				args.message,
				context.expanded,
				registry.list(),
				theme,
				args.background === true ? "async" : "blocking",
			);
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
		description: "Wait up to fifteen minutes for specified subagents to settle. Settled results are consumed, preventing redundant automatic follow-up turns.",
		parameters: createWaitAgentSchema(),
		async execute(_id, params, signal) {
			const requested = [...new Set(params.agent_ids)];
			const targets = requested.map((id) => registry.get(id));
			const startTime = Date.now();
			const timeoutMs = DEFAULT_WAIT_MS;
			await Promise.allSettled(targets.map((agent) => agent.wait(timeoutMs, signal)));
			const summaries = targets.map((agent) => agent.summary());
			for (const summary of summaries) {
				if (summary.status !== "idle" && summary.status !== "failed") continue;
				const pending = pendingCompletions.get(summary.agent_id);
				if (pending?.generation === summary.generation) pendingCompletions.delete(summary.agent_id);
			}
			return jsonResult(summaries, {
				summaries,
				elapsedMs: Date.now() - startTime,
				timeoutMs,
			} satisfies WaitDetails);
		},
		renderCall(args, theme) {
			return renderWaitCall(args.agent_ids, DEFAULT_WAIT_MS, registry.list(), theme);
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

export function createWaitAgentSchema() {
	return Type.Object({
		agent_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
	});
}

export function createSpawnAgentSchema(agents: AgentConfig[], profiles: ProfilesConfig, context?: ChildExecutionContext) {
	const parentDelegation = context ? profiles.agentPolicies[context.agent]?.delegation : undefined;
	const nestedPolicy = parentDelegation?.mode === "grant-required" ? parentDelegation : undefined;
	const allowedAgents = nestedPolicy
		? agents.filter((agent) => nestedPolicy.allowedChildAgents.includes(agent.name))
		: agents;
	const allowedProfiles = nestedPolicy ? nestedPolicy.allowedChildProfiles : Object.keys(profiles.profiles);
	const agentSchema = StringEnum(allowedAgents.map((agent) => agent.name), { description: "Name of the subagent." });
	const profileSchema = StringEnum(allowedProfiles, { description: "Allowed execution-profile override for the selected agent." });
	const thinkingLevels = context
		? ["off", "minimal", "low", "medium", "high"] as const
		: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const thinkingSchema = StringEnum(thinkingLevels, {
		description: "Optional thinking request; must not exceed the selected profile candidate's cap.",
	});
	const properties = {
		message: Type.String({ description: "Complete self-contained assignment for the child." }),
		handoff: Type.Optional(Type.String({ maxLength: MAX_HANDOFF_CHARS, description: "Known paths, decisions, facts, or small excerpts from the parent." })),
		task_name: Type.Optional(Type.String({ description: "Short UI label; derived from message when omitted." })),
		agent: agentSchema,
		profile: Type.Optional(profileSchema),
		thinking: Type.Optional(thinkingSchema),
		cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current cwd." })),
		background: Type.Optional(Type.Boolean({ description: "Return after launch and notify on completion. Default false." })),
	};
	return context
		? Type.Object(properties)
		: Type.Object({
			...properties,
			delegation_credits: Type.Optional(Type.Integer({
				minimum: 0,
				maximum: profiles.rootPolicy.maxDelegationGrant,
				description: "Delegation credits granted to an eligible general child. Root only; default 0.",
			})),
		});
}

function notifyCompletion(ctx: ExtensionContext | undefined, summary: AgentSummary): void {
	const label = sanitizeTerminalText(summary.task_name || summary.agent);
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

function updateAgentUi(ctx: ExtensionContext, registry: AgentRegistry): void {
	const views = registry.views().filter((view) => view.summary.status !== "closed");
	if (!views.length) {
		ctx.ui.setStatus("subagents", undefined);
		ctx.ui.setWidget("subagents", undefined);
		return;
	}
	const active = views.some((view) => isActiveAgent(view));
	const failed = views.some((view) => view.summary.status === "failed" || view.summary.status === "aborted");
	const color = failed ? "error" : active ? "warning" : "success";
	ctx.ui.setStatus("subagents", ctx.ui.theme.fg(color, `agents ${formatAgentCounts(views)}`));

	const visible = views.filter((view) => isActiveAgent(view) || view.summary.status === "failed" || view.summary.status === "aborted");
	if (!visible.length) {
		ctx.ui.setWidget("subagents", undefined);
		return;
	}
	ctx.ui.setWidget("subagents", (_tui, theme) => ({
		render(width: number): string[] {
			const lines = [theme.fg("muted", "SUBAGENTS")];
			for (const view of visible.slice(0, 3)) lines.push(renderAgentWidgetRow(view, width, theme));
			if (visible.length > 3) lines.push(theme.fg("dim", `  +${visible.length - 3} more`));
			return lines.map((line) => truncateToWidth(line, width, ""));
		},
		invalidate() {},
	}), { placement: "belowEditor" });
}

function isActiveAgent(view: AgentView): boolean {
	return view.summary.status === "starting" || view.summary.status === "running";
}

function renderAgentWidgetRow(view: AgentView, width: number, theme: Theme): string {
	const { summary, details } = view;
	const failed = summary.status === "failed" || summary.status === "aborted";
	const icon = failed ? theme.fg("error", "✗") : theme.fg("warning", "⟳");
	const task = sanitizeTerminalText(summary.task_name || summary.agent);
	const latest = details.recentTools.at(-1);
	const activity = latest
		? `${sanitizeTerminalText(latest.name)}${latest.argsPreview ? ` ${sanitizeTerminalText(latest.argsPreview)}` : ""}`
		: sanitizeTerminalText(details.lastMessage || (failed ? summary.status : "starting…"));
	const elapsed = formatDuration((details.endTime ?? Date.now()) - details.startTime);
	const text = `${icon} ${task} · ${summary.agent}/${summary.profile} · ${activity} · ${elapsed}`;
	return truncateToWidth(text, width, "…");
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

function discoveryErrorMessage(error: { kind: string; dir: string; cause?: NodeJS.ErrnoException; errors?: string[] }): string {
	if (error.kind === "read_dir") return `Could not read agents dir ${error.dir}: ${error.cause?.message ?? error.cause?.code ?? "unknown error"}.`;
	if (error.kind === "configuration") return error.errors?.join("\n") || `Invalid agent configuration in ${error.dir}.`;
	return `No agent files found in ${error.dir}.`;
}

function clipAtWord(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	const cut = oneLine.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${space > max * 0.5 ? oneLine.slice(0, space) : cut}…`;
}
