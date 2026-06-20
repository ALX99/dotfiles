/**
 * spawn_agent — delegate a self-contained task to an isolated subagent.
 *
 * Runs the spawned agent as a `pi --mode json --print --no-session` child
 * process with its own context, model, and tools, and returns the child's
 * final text. Codex-compatible arg shape. Depth capped at 3 (tracked across
 * the process tree via CODEX_SUBAGENT_DEPTH).
 *
 * Architecture: this is the only module that crosses into pi's tool world.
 * It composes Results from agents.ts / process.ts and converts Err → throw
 * at the boundary (pi's runtime marks `isError: true` only on thrown errors;
 * a returned `isError` field is silently dropped — see agent-loop.js).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, formatAgentList, resolveAgent } from "./agents.ts";
import { getFinalText, runSubprocess, type RunDetails, type SpawnError } from "./process.ts";
import { manageTick, renderCallHeader, renderResultBlock } from "./render.ts";

const MAX_DEPTH = 3;
const DEPTH_ENV = "CODEX_SUBAGENT_DEPTH";

const SpawnParams = Type.Object({
	message: Type.String({ description: "The specific task for this spawn. The agent's role (its system prompt) defines how it works; this is the instance of work to do. Self-contained — the child has no parent history." }),
	task_name: Type.Optional(Type.String({ description: "Short label for UI and logs. Omit to derive from the message." })),
	agent_type: Type.Optional(Type.String({ description: "Name of the subagent role to use. Omit for the default role." })),
	reasoning_effort: Type.Optional(Type.Union([
		Type.Literal("none"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
	], { description: "Override reasoning effort for the child." })),
	fork_turns: Type.Optional(Type.String({ description: "Context inheritance mode. Currently only 'none' (default, fresh context) is supported." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child agent. Defaults to current cwd." })),
});

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
			"Pass a self-contained message: the child has no parent history. Reference exact paths, file:line ranges, and the output shape you want.",
			"Prefer a single spawn_agent over multi-step orchestration. Depth is capped at 3.",
		],
		parameters: SpawnParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// ── validate the request (pre-spawn) ──
			// Each check throws a targeted message; pi catches and marks isError.
			const parentDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
			if (parentDepth >= MAX_DEPTH) {
				throw new Error(`spawn_agent depth ${parentDepth} >= max ${MAX_DEPTH}.`);
			}
			if (params.fork_turns && params.fork_turns !== "none") {
				throw new Error(`fork_turns='${params.fork_turns}' is not yet implemented. Use 'none' (default) for a fresh-context child.`);
			}

			const agents = discoverAgents().match(
				(list) => list,
				(e) => {
					throw new Error(discoveryErrorMessage(e));
				},
			);

			const requestedType = params.agent_type?.trim() || "default";
			const agent = resolveAgent(agents, requestedType).match(
				(a) => a,
				(e) => {
					throw new Error(`Unknown agent_type '${e.requested}'. Available: ${formatAgentList(e.available)}.`);
				},
			);

			const [provider, modelId] = (agent.model ?? "").split("/");
			const contextWindow = provider && modelId
				? ctx.modelRegistry.find(provider, modelId)?.contextWindow
				: undefined;

			// ── run ──
			const result = await runSubprocess({
				defaultCwd: ctx.cwd,
				agent,
				message: params.message,
				taskName: params.task_name?.trim() || params.message.slice(0, 60),
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

			// ── resolve (Err → throw, so pi marks isError) ──
			const details = result.match(
				(d) => d,
				(e) => {
					throw new Error(spawnErrorMessage(e));
				},
			);

			const finalText = getFinalText(details.messages);
			return { content: [{ type: "text" as const, text: finalText || "(no output)" }], details };
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
	const finalText = getFinalText(details.messages);
	if (e.kind === "aborted") return "spawn_agent aborted.";
	return details.stderr.trim() || finalText || `Subagent exited with code ${details.exitCode}.`;
}
