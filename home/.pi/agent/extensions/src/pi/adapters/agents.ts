import { randomUUID } from "node:crypto";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type ExtensionAPI,
	type ExtensionFactory,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";

import type { ApplicationEffects } from "../../application.ts";
import { createCapabilityPolicy, type ProfileCapabilityPolicy } from "../../agents/policy.ts";
import type { AgentChildCommunication, AgentWorkflows } from "../../agents/workflows.ts";
import { createAgentWorkflows } from "../../agents/workflows.ts";
import { registerAgentWorkflowTools } from "../../agents/register.ts";
import { createAgentSessionOwner } from "../../agents/session.ts";
import { openAgentStore, type AgentStore } from "../../agents/store.ts";
import type { MailboxEvent } from "../../agents/state.ts";
import { createToolSelection } from "../../integration/tool-selection.ts";
import { installToolExecutionAdapter } from "./tool-execution.ts";
import { installToolAdapter } from "./tools.ts";

const MAILBOX_MESSAGE_TYPE = "personal:agent-mailbox";

type AgentAdapterSession = {
	readonly store: AgentStore;
	readonly workflows: AgentWorkflows;
	readonly dispose: () => Promise<void>;
};

export interface AgentAdapterOptions {
	/** Set only in a child runtime; it scopes the registry and permits ask_parent. */
	readonly ownerAgentId?: string;
	readonly parentCommunication?: AgentChildCommunication;
	/** Captured profile policy for this agent; absent only in the unrestricted root session. */
	readonly capabilityPolicy?: ProfileCapabilityPolicy;
	/** Reused recursively so all child sessions share Pi's configured model/auth runtime. */
	readonly modelRuntime?: ModelRuntime;
	readonly agentDir?: string;
	readonly storeDirectory?: string;
	readonly sessionDirectory?: string;
	readonly profileDirectory?: string;
}

export interface AgentMailboxDelivery {
	readonly request: () => void;
	readonly close: () => void;
}

export type AgentAdapterDisposer = () => Promise<void>;

/** Claim durable child events, surface them to Pi only at a safe point, then acknowledge them. */
export function createAgentMailboxDelivery(options: {
	readonly store: AgentStore;
	readonly applicationEffects: ApplicationEffects;
	readonly isBusy: () => boolean;
	readonly isCurrent: () => boolean;
	readonly send: (events: readonly MailboxEvent[]) => void;
}): AgentMailboxDelivery {
	let closed = false;
	let running = false;
	let requested = false;

	const request = (): void => {
		if (closed) return;
		requested = true;
		if (running || options.isBusy() || !options.isCurrent()) return;
		running = true;
		void (async () => {
			try {
				while (requested && options.isCurrent() && !options.isBusy()) {
					if (closed) break;
					requested = false;
					const claimId = randomUUID();
					const events = await options.applicationEffects.run(options.store.claimEvents(claimId));
					if (events.length === 0) break;
					if (closed || !options.isCurrent() || options.isBusy()) {
						await options.applicationEffects.run(options.store.releaseClaim(claimId));
						requested = !closed;
						break;
					}
					try {
						options.send(events);
						await options.applicationEffects.run(
							options.store.acknowledgeEvents(
								claimId,
								events.map((event) => event.id),
								Date.now(),
							),
						);
					} catch (cause) {
						await options.applicationEffects.run(options.store.releaseClaim(claimId));
						requested = false;
						console.error(
							`Could not deliver child-agent events: ${cause instanceof Error ? cause.message : String(cause)}`,
						);
					}
				}
			} catch (cause) {
				console.error(
					`Could not process child-agent events: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			} finally {
				running = false;
				if (requested && !closed && options.isCurrent() && !options.isBusy()) request();
			}
		})();
	};

	return {
		request,
		close: () => {
			closed = true;
			requested = false;
		},
	};
}

/** Bind one parent-scoped orchestration service; return explicit teardown because AgentSession.dispose() skips session_shutdown. */
export function installAgentAdapter(
	pi: ExtensionAPI,
	applicationEffects: ApplicationEffects,
	options: AgentAdapterOptions = {},
): AgentAdapterDisposer {
	let active: AgentAdapterSession | undefined;
	let busy = false;
	let disposed = false;
	let delivery: AgentMailboxDelivery | undefined;

	const requestDelivery = (): void => {
		if (active === undefined) return;
		delivery?.request();
	};

	const close = async (): Promise<void> => {
		const previous = active;
		delivery?.close();
		delivery = undefined;
		active = undefined;
		if (previous !== undefined) await previous.dispose();
	};

	registerAgentWorkflowTools(
		pi,
		() => active?.workflows,
		applicationEffects,
		options.parentCommunication,
		options.capabilityPolicy,
	);

	pi.on("session_start", async (_event, ctx) => {
		if (disposed) return;
		await close();
		busy = !ctx.isIdle();
		const store = await applicationEffects.run(
			openAgentStore({
				ownerSessionId: ctx.sessionManager.getSessionId(),
				...(options.ownerAgentId === undefined ? {} : { ownerAgentId: options.ownerAgentId }),
				...(options.storeDirectory === undefined ? {} : { directory: options.storeDirectory }),
			}),
		);
		const sessions = await applicationEffects.run(
			createAgentSessionOwner({
				store,
				parentCwd: ctx.cwd,
				...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
				...(options.sessionDirectory === undefined ? {} : { sessionDirectory: options.sessionDirectory }),
				...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
				providerRegistry: ctx.modelRegistry,
				noConfiguredExtensions: true,
				extensionFactories: (agent, _observation, modelRuntime, registerDisposer) => {
					const parent = active?.workflows;
					if (parent === undefined) throw new Error("Parent agent workflows are not ready.");
					const childAdapter: ExtensionFactory = (childPi) => {
						const policy = createCapabilityPolicy(agent.profile);
						const toolSelection = createToolSelection(childPi, policy);
						const toolStatus = installToolExecutionAdapter(childPi, childApplicationEffects);
						installToolAdapter(childPi, toolSelection, toolStatus);
						const dispose = installAgentAdapter(childPi, childApplicationEffects, {
							ownerAgentId: agent.id,
							parentCommunication: parent.childCommunication(agent.id),
							capabilityPolicy: policy,
							modelRuntime,
							...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
							...(options.storeDirectory === undefined ? {} : { storeDirectory: options.storeDirectory }),
							...(options.sessionDirectory === undefined ? {} : { sessionDirectory: options.sessionDirectory }),
							...(options.profileDirectory === undefined ? {} : { profileDirectory: options.profileDirectory }),
						});
						registerDisposer(dispose);
					};
					return [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension(), childAdapter];
				},
			}),
		);
		const workflowsScope = await applicationEffects.run(Scope.make());
		let workflows: AgentWorkflows;
		try {
			workflows = await applicationEffects.run(
				Scope.provide(workflowsScope)(
					createAgentWorkflows({
						store,
						sessions,
						models: ctx.modelRegistry,
						...(options.profileDirectory === undefined ? {} : { profileDirectory: options.profileDirectory }),
						...(options.capabilityPolicy === undefined ? {} : { capabilityPolicy: options.capabilityPolicy }),
						onEvent: () => requestDelivery(),
					}),
				),
			);
		} catch (cause) {
			await applicationEffects.run(Scope.close(workflowsScope, Exit.void));
			throw cause;
		}
		active = {
			store,
			workflows,
			dispose: async () => {
				try {
					await applicationEffects.run(workflows.dispose());
				} finally {
					await applicationEffects.run(Scope.close(workflowsScope, Exit.void));
				}
			},
		};
		delivery = createAgentMailboxDelivery({
			store,
			applicationEffects,
			isBusy: () => busy,
			isCurrent: () => active?.store === store,
			send: (events) =>
				pi.sendMessage(
					{
						customType: MAILBOX_MESSAGE_TYPE,
						content: `Child-agent events (runtime events only; no task completion is implied):\n${JSON.stringify(
							events.map(mailboxMessage),
							null,
							2,
						)}`,
						display: false,
						details: { eventIds: events.map((event) => event.id) },
					},
					{ triggerTurn: true, deliverAs: "steer" },
				),
		});
		if ((await applicationEffects.run(store.pendingEvents())).length > 0) requestDelivery();
	});

	pi.on("agent_start", () => {
		busy = true;
	});
	pi.on("agent_settled", () => {
		busy = false;
		requestDelivery();
	});
	const dispose = async (): Promise<void> => {
		disposed = true;
		busy = false;
		await close();
	};

	pi.on("session_shutdown", dispose);

	return dispose;
}

function mailboxMessage(event: MailboxEvent) {
	return {
		eventId: event.id,
		agent: event.agentId,
		event: event.type,
		...(event.message === undefined ? {} : { message: event.message }),
		...(event.options === undefined ? {} : { options: event.options }),
		...(event.error === undefined ? {} : { error: event.error }),
	};
}

const childApplicationEffects: ApplicationEffects = {
	run: (effect, options) => Effect.runPromise(effect, options),
	initiate: (effect) => Effect.runPromise(effect).then(() => undefined),
};
