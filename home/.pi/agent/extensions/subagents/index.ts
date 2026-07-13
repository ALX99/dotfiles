/**
 * spawn_agent — delegate a self-contained task to an isolated subagent.
 *
 * Runs the spawned agent as a `pi --mode json --print --no-session` child
 * process with its own context, model, and tools, and returns the child's
 * final text. Codex-compatible arg shape. Depth capped at 3 (tracked across
 * the process tree via PI_SUBAGENT_DEPTH).
 *
 * Architecture: this is the only module that crosses into pi's tool world.
 * It composes agent/process helpers and converts failed child runs into throws
 * at the boundary (pi's runtime marks `isError: true` only on thrown errors;
 * a returned `isError` field is silently dropped — see agent-loop.js).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, formatAgentList, resolveAgent } from "./agents.ts";
import { DEPTH_ENV, resolveEffectiveModel, runSubprocess, type RunDetails, type SpawnError } from "./process.ts";
import { manageTick, renderCallHeader, renderResultBlock } from "./render.ts";

const MAX_DEPTH = 3;
const MAX_HANDOFF_CHARS = 8_000;

export default function (_pi: ExtensionAPI) {
	// Discover agents at registration time so the model sees the current
	// name+description list, not a hand-written hint that drifts the moment
	// someone adds a new agents/*.md. A broken agents dir fails loud at load
	// — a silently registered tool that always errors is worse than no tool.
	const agents = discoverAgents().match(
		(list) => list,
		(e) => {
			throw new Error(discoveryErrorMessage(e));
		},
	);
	const agentList = agents
		.map((a) => `- **${a.name}** — ${a.description}`)
		.join("\n");

	// Build agent_type as an enum of the discovered names so the model gets a
	// hard constraint instead of free text that round-trips as an error.
	const agentLiterals = agents.map((a) => Type.Literal(a.name));
	const agentTypeSchema = agentLiterals.length
		? Type.Union(agentLiterals, { description: "Name of the subagent role to use. Omit for the default role." })
		: Type.String({ description: "Name of the subagent role to use. Omit for the default role." });

	const SpawnParams = Type.Object({
		message: Type.String({ description: "The specific task for this spawn. The agent's role (its system prompt) defines how it works; this is the instance of work to do. Self-contained — the child has no parent history." }),
		handoff: Type.Optional(Type.String({ maxLength: MAX_HANDOFF_CHARS, description: "Known paths, decisions, facts, or small excerpts from the parent that the child should not rediscover. Omit only when the task is genuinely self-contained." })),
		task_name: Type.Optional(Type.String({ description: "Short label for UI and logs. Omit to derive from the message." })),
		agent_type: Type.Optional(agentTypeSchema),
		reasoning_effort: Type.Optional(Type.Union([
			Type.Literal("none"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		], { description: "Override reasoning effort for the child." })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the child agent. Defaults to current cwd." })),
	});

	// Per-row tick intervals, keyed by toolCallId. A single shared slot would
	// let two concurrent spawns clobber each other's interval.
	const ticks = new Map<string, NodeJS.Timeout>();

	_pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Spawn an isolated subagent with its own context, model, and tools. Returns the child's final text. Depth capped at 3.",
		promptSnippet: "Delegate a self-contained task to an isolated subagent with its own context, model, and tool surface",
		promptGuidelines: [
			"Use spawn_agent to delegate a self-contained task to an isolated subagent with its own context, model, and tools.",
			`Available agent types:\n${agentList}\n\nOmit \`agent_type\` for the default role (no overrides).`,
			"When using spawn_agent, put the child's complete assignment in message: objective, scope, constraints or decisions, expected deliverable or output format, and required verification or evidence.",
			"When using spawn_agent, reference exact paths, symbols, or line ranges when useful. Do not rely on parent conversation history; make the message self-contained.",
			"When using spawn_agent after gathering context, put child-facing instructions in message and known facts, decisions, or small excerpts in handoff. The child receives no parent conversation history; omit handoff only when the task is genuinely self-contained.",
			"Prefer a single spawn_agent over multi-step orchestration. Depth is capped at 3.",
		],
		parameters: SpawnParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// ── validate the request (pre-spawn) ──
			// Each check throws a targeted message; pi catches and marks isError.
			const parentDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
			if (parentDepth >= MAX_DEPTH) {
				throw new Error(`spawn_agent capped at depth ${MAX_DEPTH}. Do not spawn a further child — perform this work in your current session instead.`);
			}

			const requestedType = params.agent_type?.trim() || "default";
			const agent = resolveAgent(agents, requestedType).match(
				(a) => a,
				(e) => {
					throw new Error(`Unknown agent_type '${e.requested}'. Available: ${formatAgentList(e.available)}.`);
				},
			);

			const effectiveModel = resolveEffectiveModel(agent.model);
			const [provider, modelId] = (effectiveModel ?? "").split("/");
			const contextWindow = provider && modelId
				? ctx.modelRegistry.find(provider, modelId)?.contextWindow
				: undefined;

			// ── run ──
			const result = await runSubprocess({
				defaultCwd: ctx.cwd,
				agent,
				model: effectiveModel,
				message: params.message,
				handoff: params.handoff?.trim() || undefined,
				taskName: params.task_name?.trim() || clipAtWord(params.message, 60),
				reasoningEffortOverride: params.reasoning_effort,
				cwd: params.cwd,
				parentDepth,
				signal,
				onUpdate: onUpdate
					? (d) => {
						d.contextWindow = contextWindow;
						onUpdate({ content: [{ type: "text", text: "(running…)" }], details: d });
					}
					: undefined,
			});

			// ── resolve (failed child run → throw, so pi marks isError) ──
			if (!result.ok) {
				throw new Error(spawnErrorMessage(result.error));
			}

			const details = result.details;
			return { content: [{ type: "text" as const, text: details.finalText || "(no output)" }], details };
		},

		renderCall(args, theme, context) {
			const c = context.lastComponent instanceof Container
				? (context.lastComponent.clear(), context.lastComponent)
				: new Container();
			renderCallHeader(c, args, context.expanded, theme);
			return c;
		},

		renderResult(result, options, theme, context) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				// A failed execution throws, so Pi's final error result does not carry
				// our details. Clear any interval created by an earlier partial update.
				if (!options.isPartial) manageTick(ticks, context.toolCallId, false, () => context.invalidate());
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}

			// Live tick: while partial, kick a 1Hz interval so the elapsed
			// counter advances even with no new tool events.
			manageTick(ticks, context.toolCallId, options.isPartial, () => context.invalidate());

			return renderResultBlock(details, options, theme);
		},
	});
}

function discoveryErrorMessage(e: { kind: string; dir: string; cause?: NodeJS.ErrnoException }): string {
	if (e.kind === "read_dir") {
		return `Could not read agents dir ${e.dir}: ${e.cause?.message ?? e.cause?.code ?? "unknown error"}.`;
	}
	return `No agent files found in ${e.dir}. Create one as <name>.md with frontmatter name + description.`;
}

function spawnErrorMessage(e: SpawnError): string {
	const details = e.details;
	if (e.kind === "aborted") return "spawn_agent aborted.";
	if (e.kind === "assistant") return e.message;
	const code = `Subagent exited with code ${details.exitCode}.`;
	const stderr = details.stderr.trim();
	const finalText = details.finalText;
	const body = stderr ? (finalText ? `${stderr}\n${finalText}` : stderr) : finalText;
	return body ? `${code} ${body}` : code;
}

function clipAtWord(s: string, max: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	if (one.length <= max) return one;
	const cut = one.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > max * 0.5 ? one.slice(0, lastSpace) : cut) + "…";
}
