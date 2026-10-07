import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { applicationWorkflow, createApplicationRuntime } from "../runtime.ts";
import type { ApplicationEffects } from "../application.ts";
import type { ActivitySignal } from "../application/activity.ts";
import { createEditorComposition } from "../integration/editor.ts";
import { createToolSelection } from "../integration/tool-selection.ts";
import { installHostAdapter } from "./adapters/host.ts";
import { installModelContextAdapter } from "./adapters/model-context.ts";
import { installPresentationAdapter } from "./adapters/presentation.ts";
import { installToolExecutionAdapter } from "./adapters/tool-execution.ts";
import { installToolAdapter } from "./adapters/tools.ts";
import { installAgentAdapter } from "./adapters/agents.ts";
import { installWorkAdapter } from "./adapters/work.ts";

const noopActivity = (_active: boolean): void => {};
const noopRunCount = (_count: number): void => {};

/** Native Pi integration owns registrations and turns them into application workflows. */
export async function installPersonalExtension(pi: ExtensionAPI): Promise<void> {
	let runtime = createApplicationRuntime();
	let disposed = false;

	let updateStatusbarActivity = noopActivity;
	let updateKeepAwakeActivity = noopActivity;
	let updateEmptyEnterRuns = noopRunCount;

	const updateActivity = async (signal: ActivitySignal): Promise<void> => {
		if (disposed) return;
		const snapshot = await runtime.runPromise(applicationWorkflow((application) => application.activity(signal)));
		updateStatusbarActivity(snapshot.indicatorActive);
		updateKeepAwakeActivity(snapshot.keepAwakeActive);
		updateEmptyEnterRuns(snapshot.activeRuns);
	};

	const applicationEffects: ApplicationEffects = {
		initiate(effect) {
			if (disposed) return Promise.reject(new Error("Personal application is shut down."));
			return runtime.runPromise(applicationWorkflow((application) => application.initiate(effect)));
		},
		run(effect, options) {
			if (disposed) return Promise.reject(new Error("Personal application is shut down."));
			return runtime.runPromise(effect, options);
		},
	};

	pi.on("session_start", async () => {
		if (disposed) {
			runtime = createApplicationRuntime();
			disposed = false;
		}
		await runtime.runPromise(applicationWorkflow((application) => application.startSession));
		await updateActivity("session_start");
	});

	const toolSelection = createToolSelection(pi);
	const editor = createEditorComposition();
	const toolStatus = installToolExecutionAdapter(pi, applicationEffects);
	installToolAdapter(pi, toolSelection, toolStatus);
	installAgentAdapter(pi, applicationEffects);
	const work = installWorkAdapter(pi, { applicationEffects, editor, toolSelection });
	await installModelContextAdapter(pi, {
		applicationEffects,
		isClosed: () => disposed,
		providerRequest: (payload, context, transforms) =>
			runtime.runPromise(
				applicationWorkflow((application) => application.providerRequest(payload, context, transforms)),
			),
		toolSelection,
	});
	const keepAwake = installHostAdapter(pi);
	updateKeepAwakeActivity = (active) => keepAwake.setActive(active);
	updateEmptyEnterRuns = (count) => work.rescuedInputWork.setActiveRuns(count);
	const statusbarActivity = installPresentationAdapter(pi, editor, toolStatus);
	updateStatusbarActivity = (active) => statusbarActivity.setActive(active);

	pi.on("session_shutdown", async (event, ctx) => {
		if (disposed) return;
		try {
			await updateActivity("session_shutdown");
			await runtime.runPromise(applicationWorkflow((application) => application.shutdown));
		} finally {
			disposed = true;
			try {
				await runtime.dispose();
			} finally {
				statusbarActivity.events.sessionShutdown(event, ctx);
			}
		}
	});

	pi.on("agent_start", () => updateActivity("agent_start"));
	pi.on("agent_end", () => updateActivity("agent_end"));
	pi.on("ui_prompt_start", () => updateActivity("ui_prompt_start"));
	pi.on("ui_prompt_end", () => updateActivity("ui_prompt_end"));

	// This single workflow replaces cross-feature settlement callbacks. Evaluate every
	// feature's current state first, then let WorkCoordinator claim and run one action.
	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		if (disposed) return;
		await updateActivity("agent_settled");
		const plan = {
			taskCheckpoint: Effect.sync(() => work.taskWork.taskCheckpoint(ctx)),
			rescuedInput: Effect.sync(() => work.rescuedInputWork.rescuedInput()),
			scheduledMessage: work.scheduleWork.scheduledMessage(ctx),
			taskInput: Effect.sync(() => work.taskWork.taskInput(ctx)),
			taskReminder: Effect.sync(() => work.taskWork.taskReminder(ctx)),
		};
		await runtime.runPromise(applicationWorkflow((application) => application.settle(plan)));
	});
}
