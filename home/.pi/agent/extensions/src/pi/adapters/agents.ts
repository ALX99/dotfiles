import { randomUUID } from "node:crypto";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionFactory,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";

import type { ApplicationEffects } from "../../application.ts";
import type { ActiveProfileState } from "../../agents/active-profile.ts";
import type { AgentFooterRow } from "../../agents/inspection.ts";
import {
	createCapabilityPolicy,
	installToolExecutionPolicy,
	type ProfileCapabilityPolicy,
} from "../../agents/policy.ts";
import { discoverProfiles, profilesDirectory, type ProfileSnapshot } from "../../agents/profile.ts";
import type { AgentChildCommunication, AgentWorkflows } from "../../agents/workflows.ts";
import { createAgentWorkflows } from "../../agents/workflows.ts";
import { registerAgentWorkflowTools } from "../../agents/register.ts";
import { createAgentSessionOwner, type AgentSessionOwner } from "../../agents/session.ts";
import { openAgentStore, type AgentStore } from "../../agents/store.ts";
import type { MailboxEvent } from "../../agents/state.ts";
import { createToolSelection } from "../../integration/tool-selection.ts";
import { installToolExecutionAdapter } from "./tool-execution.ts";
import { installToolAdapter } from "./tools.ts";

const MAILBOX_MESSAGE_TYPE = "personal:agent-mailbox";

type AgentAdapterSession = {
	readonly store: AgentStore;
	readonly sessions: AgentSessionOwner;
	readonly workflows: AgentWorkflows;
	readonly dispose: () => Promise<void>;
};

export interface AgentAdapterOptions {
	/** Set only in a child runtime; it scopes the registry and permits ask_parent. */
	readonly ownerAgentId?: string;
	readonly parentCommunication?: AgentChildCommunication;
	/** Captured profile policy for this agent; absent only in the unrestricted root session. */
	readonly capabilityPolicy?: ProfileCapabilityPolicy;
	/** Present only for a root session that supports switching its active profile. */
	readonly activeProfile?: ActiveProfileState;
	/** Present only when a root UI observes direct-child footer rows. */
	readonly onFooterRows?: (rows: readonly AgentFooterRow[]) => void;
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
	let stopFooterUpdates: (() => void) | undefined;
	let footerGeneration = 0;
	let availableProfiles = new Map<string, ProfileSnapshot>();
	const registeredProfileCommands = new Set<string>();
	let profileCommandEpoch = 0;

	const refreshFooter = (modelRegistry: Parameters<AgentSessionOwner["getFooterRows"]>[0]): void => {
		const current = active;
		if (options.onFooterRows === undefined || current === undefined) return;
		const generation = ++footerGeneration;
		void applicationEffects
			.run(current.sessions.getFooterRows(modelRegistry))
			.then((rows) => {
				if (disposed || active !== current || generation !== footerGeneration) return;
				options.onFooterRows?.(rows);
			})
			.catch((cause: unknown) => {
				if (disposed || active !== current || generation !== footerGeneration) return;
				console.error(
					`Could not refresh child-agent footer: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			});
	};

	const requestDelivery = (): void => {
		if (active === undefined) return;
		delivery?.request();
	};

	const close = async (): Promise<void> => {
		const previous = active;
		stopFooterUpdates?.();
		stopFooterUpdates = undefined;
		footerGeneration++;
		delivery?.close();
		delivery = undefined;
		active = undefined;
		options.onFooterRows?.([]);
		if (previous !== undefined) await previous.dispose();
	};

	registerAgentWorkflowTools(
		pi,
		() => active?.workflows,
		applicationEffects,
		options.parentCommunication,
		options.capabilityPolicy,
	);
	if (options.activeProfile !== undefined) {
		installToolExecutionPolicy(pi, () => options.activeProfile?.getPolicy());
	}

	pi.on("session_start", async (_event, ctx) => {
		if (disposed) return;
		profileCommandEpoch++;
		availableProfiles = new Map();
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
				...(options.onFooterRows === undefined ? {} : { onSessionChanged: () => refreshFooter(ctx.modelRegistry) }),
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
						...(options.activeProfile === undefined
							? {}
							: { getCapabilityPolicy: () => options.activeProfile?.getPolicy() }),
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
			sessions,
			workflows,
			dispose: async () => {
				try {
					await applicationEffects.run(workflows.dispose());
				} finally {
					await applicationEffects.run(Scope.close(workflowsScope, Exit.void));
				}
			},
		};
		if (options.onFooterRows !== undefined) {
			stopFooterUpdates = store.subscribeAgentChanges(() => refreshFooter(ctx.modelRegistry));
			refreshFooter(ctx.modelRegistry);
		}
		if (options.activeProfile !== undefined) {
			try {
				const discovery = await applicationEffects.run(
					discoverProfiles(ctx.modelRegistry, options.profileDirectory ?? profilesDirectory(options.agentDir)),
				);
				availableProfiles = new Map(discovery.profiles.map((profile) => [profile.name, profile]));
				for (const diagnostic of discovery.diagnostics) {
					const message = `Could not load profile: ${diagnostic.message}`;
					if (ctx.hasUI) ctx.ui.notify(message, "warning");
					else console.error(message);
				}
				registerProfileCommands(
					pi,
					() => availableProfiles,
					registeredProfileCommands,
					options.activeProfile,
					() => profileCommandEpoch,
				);
			} catch (cause) {
				const message = `Could not discover profiles: ${cause instanceof Error ? cause.message : String(cause)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else console.error(message);
			}
		}
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
		profileCommandEpoch++;
		availableProfiles = new Map();
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

function registerProfileCommands(
	pi: ExtensionAPI,
	getProfiles: () => ReadonlyMap<string, ProfileSnapshot>,
	registered: Set<string>,
	activeProfile: ActiveProfileState,
	getEpoch: () => number,
): void {
	for (const name of getProfiles().keys()) {
		if (registered.has(name)) continue;
		if (pi.getCommands().some((command) => command.name === name)) {
			console.warn(`Profile command "/${name}" was not registered because that command name is already in use.`);
			continue;
		}

		pi.registerCommand(name, {
			description: `Switch this session to the ${name} profile`,
			handler: async (args, ctx: ExtensionCommandContext) => {
				const commandEpoch = getEpoch();
				const currentProfile = getProfiles().get(name);
				if (currentProfile === undefined) {
					ctx.ui.notify(`Profile "${name}" is not available in this session.`, "warning");
					return;
				}
				if (args.trim().length > 0) {
					ctx.ui.notify(`/${name} only switches profiles. Send your message after the switch.`, "warning");
					return;
				}
				if (!ctx.isIdle()) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Queued profile switch to "${name}"; it will apply when the current turn settles.`, "info");
					}
					await ctx.waitForIdle();
					if (commandEpoch !== getEpoch()) return;
				}

				const model = ctx.modelRegistry.find(currentProfile.model.provider, currentProfile.model.id);
				if (model === undefined) {
					ctx.ui.notify(
						`Model not found for profile "${name}": ${currentProfile.model.provider}/${currentProfile.model.id}`,
						"warning",
					);
					return;
				}
				try {
					const switched = await pi.setModel(model);
					if (commandEpoch !== getEpoch()) return;
					if (!switched) {
						ctx.ui.notify(
							`No API key for ${currentProfile.model.provider}/${currentProfile.model.id}; profile was not changed.`,
							"warning",
						);
						return;
					}
					if (currentProfile.thinkingLevel !== undefined) pi.setThinkingLevel(currentProfile.thinkingLevel);
					activeProfile.setProfile(currentProfile);
					ctx.ui.notify(
						`Switched to profile "${name}" (${currentProfile.model.provider}/${currentProfile.model.id}${
							currentProfile.thinkingLevel === undefined ? "" : `, ${currentProfile.thinkingLevel} thinking`
						}).`,
						"info",
					);
				} catch (cause) {
					if (commandEpoch === getEpoch()) {
						ctx.ui.notify(
							`Could not switch to profile "${name}": ${cause instanceof Error ? cause.message : String(cause)}`,
							"warning",
						);
					}
				}
			},
		});
		registered.add(name);
	}
}

const childApplicationEffects: ApplicationEffects = {
	run: (effect, options) => Effect.runPromise(effect, options),
	initiate: (effect) => Effect.runPromise(effect).then(() => undefined),
};
