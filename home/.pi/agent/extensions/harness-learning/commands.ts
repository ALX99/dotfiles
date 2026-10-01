import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Result } from "effect";
import { runFork, runPromise } from "../_shared/effect-runtime.ts";
import { toError } from "../_shared/errors.ts";
import {
	evaluateCandidate,
	loadProbeSuite,
	EVALUATION_TIMEOUT_MS,
	PROBE_MAX_TOKENS,
	PROBE_TIMEOUT_MS,
} from "./evaluation.ts";
import { labReleaseGate, labProcedures } from "./lab/state.ts";
import { loadLabStore, openLabStore } from "./lab/store.ts";
import { renderGuidance } from "./procedures.ts";
import { contextStore, eventEnvelope, selectedModel, selectedPhysicalModel } from "./runtime.ts";
import { EVALUATION_REPEATS, HarnessError, MAX_EVENTS } from "./schema.ts";
import { evaluationPlan, labReleasePlan, promotionGate, type HarnessState } from "./state.ts";
import { appendStoreEvent, loadStore, loadStoreSnapshot } from "./store.ts";

const HELP = [
	"/harness status",
	"/harness review <candidate-id>",
	"/harness suite <independent-suite.json>",
	"/harness evaluate <candidate-id>",
	"/harness approve <candidate-id> <reason>",
	"/harness reject <candidate-id> <reason>",
	"/harness rollback <version-id|root> <reason>",
	"/harness lab-review <run-id>",
	"/harness lab-release <run-id> <reason>",
	"/harness cancel",
].join("\n");

/** These operations are deliberately commands, never model-callable tools. */
export function registerHarnessCommand(pi: ExtensionAPI, root?: string): void {
	let running: Fiber.Fiber<void, HarnessError> | undefined;
	const cancel = async (): Promise<void> => {
		const fiber = running;
		if (fiber !== undefined) await runPromise(Fiber.interrupt(fiber));
	};
	pi.on("session_start", cancel);
	pi.on("session_tree", cancel);
	pi.on("session_shutdown", cancel);
	pi.on("model_select", cancel);
	pi.on("before_agent_start", cancel);

	pi.registerCommand("harness", {
		description: "Review evidence-backed procedural learning, evaluate, approve, reject, or roll back",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(
					"/harness requires an interactive terminal; model tools cannot perform these operations.",
					"error",
				);
				return;
			}
			if (args.trim() === "cancel") {
				await cancel();
				return;
			}
			if (running !== undefined || !ctx.isIdle()) {
				ctx.ui.notify(
					"Harness commands require an idle agent and no running harness command. Use /harness cancel to stop evaluation.",
					"warning",
				);
				return;
			}
			const fiber = runFork(commandEffect(pi, ctx, args, root));
			running = fiber;
			try {
				await runPromise(Fiber.join(fiber));
			} catch (cause) {
				ctx.ui.notify(toError(cause).message, "error");
			} finally {
				if (running === fiber) running = undefined;
			}
		},
	});
}

const commandEffect = Effect.fn("harnessLearning.command")(function* (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	root?: string,
): Effect.fn.Return<void, HarnessError> {
	const trimmed = args.trim();
	const [action = "status", ...parts] = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
	const sessionId = ctx.sessionManager.getSessionId();
	const ensureCurrent = (): void => {
		if (!ctx.isIdle() || ctx.sessionManager.getSessionId() !== sessionId)
			throw new HarnessError({ message: "The session changed or the agent resumed; run the command again when idle" });
	};
	const check = () =>
		Effect.try({ try: ensureCurrent, catch: (cause) => new HarnessError({ message: toError(cause).message }) });
	if (
		!["status", "review", "suite", "evaluate", "approve", "reject", "rollback", "lab-review", "lab-release"].includes(
			action,
		)
	) {
		yield* Effect.sync(() => ctx.ui.notify(HELP, "info"));
		return undefined;
	}
	const store = yield* contextStore(pi, ctx, root);
	const loaded = yield* action.startsWith("lab-") ? loadStoreSnapshot(store) : loadStore(store);
	const state = loaded.state;
	if (action === "lab-review" || action === "lab-release") {
		const runId = parts[0];
		if (runId === undefined) return yield* new HarnessError({ message: HELP });
		const labStore = yield* openLabStore(store.scope, runId, store.root).pipe(
			Effect.mapError((error) => new HarnessError({ message: error.message })),
		);
		const lab = yield* loadLabStore(labStore).pipe(
			Effect.mapError((error) => new HarnessError({ message: error.message })),
		);
		const modelId = selectedPhysicalModel(ctx);
		const plan = modelId.pipe(Result.flatMap((model) => labReleasePlan(state, lab.document, model)));
		if (action === "lab-review") {
			yield* Effect.sync(() =>
				ctx.ui.notify(
					JSON.stringify(
						{
							scope: lab.state.scope,
							runId: lab.state.runId,
							targetModel: lab.state.started.config.targetModel,
							productionParent: lab.state.started.config.baseline.productionVersion,
							experimentalVersion: lab.state.head.id,
							finished: lab.state.finished,
							laboratoryGate: labReleaseGate(lab.state),
							productionGate: Result.isSuccess(plan) ? "eligible" : plan.failure.message,
							procedures: labProcedures(lab.state),
							candidates: lab.state.candidates.map((candidate) => ({
								...candidate,
								selection: lab.state.selections.find((entry) => entry.candidateId === candidate.id) ?? null,
							})),
							tasks: lab.state.tasks.map(({ id, phase, taskId, repeat, arm, outcome }) => ({
								id,
								phase,
								taskId,
								repeat,
								arm,
								outcome:
									outcome.status === "completed"
										? { status: outcome.status, verificationExitCode: outcome.verificationExitCode }
										: outcome,
							})),
						},
						null,
						2,
					),
					"info",
				),
			);
			return undefined;
		}
		const reason = parts.slice(1).join(" ");
		if (reason.length === 0) return yield* new HarnessError({ message: "Laboratory release requires a reason" });
		if (Result.isFailure(plan)) return yield* plan.failure;
		const selected = yield* Effect.fromResult(modelId);
		const cwd = ctx.cwd;
		const leaf = ctx.sessionManager.getLeafId();
		const assertReleaseCurrent = (): void => {
			ensureCurrent();
			const current = selectedPhysicalModel(ctx);
			if (ctx.cwd !== cwd || ctx.sessionManager.getLeafId() !== leaf)
				throw new HarnessError({ message: "Repository or session branch changed; release cancelled" });
			if (Result.isFailure(current)) throw current.failure;
			if (current.success !== selected)
				throw new HarnessError({ message: "Selected model changed; release cancelled" });
		};
		yield* Effect.try({
			try: assertReleaseCurrent,
			catch: (cause) => new HarnessError({ message: toError(cause).message }),
		});
		if (
			!(yield* confirm(
				ctx,
				"Release experimental procedural guidance?",
				`${runId}: ${lab.state.head.id} → production parent ${state.head.id}\n${selected}\n${reason}\n\n` +
					renderGuidance(plan.success.procedures) +
					"\n\nRead /harness lab-review first. These are bounded coding-task results, not native-Pi replay or proof of everyday transfer. " +
					"Same-account evidence is not adversarially protected. Other models' procedures are preserved; rollback remains available.",
			))
		)
			return undefined;
		yield* check();
		const currentStore = yield* contextStore(pi, ctx, root);
		if (currentStore.scope !== store.scope)
			return yield* new HarnessError({ message: "Repository scope changed; release cancelled" });
		yield* appendStoreEvent(
			store,
			{
				...(yield* eventEnvelope()),
				kind: "lab-release",
				parentVersion: state.head.id,
				model: selected,
				lab: plan.success.lab,
				reason,
			},
			assertReleaseCurrent,
		);
		yield* Effect.sync(() =>
			ctx.ui.notify(
				"Laboratory release recorded for this model. Guidance changes on the next request; /harness rollback remains available.",
				"info",
			),
		);
		return undefined;
	}
	if (action === "status") {
		yield* Effect.sync(() => ctx.ui.notify(status(state), "info"));
		return undefined;
	}
	if (action === "suite") {
		const path = resolve(ctx.cwd, parts.join(" "));
		if (parts.length === 0) return yield* new HarnessError({ message: HELP });
		const suite = yield* loadProbeSuite(path);
		if (
			!(yield* confirm(
				ctx,
				"Configure independent probe suite?",
				`${path}\n${suite.name}: ${suite.cases.length} cases.\nThe agent must not author or inspect the evaluator's expected answers. ` +
					"Same-account files are not an adversarially isolated or truly blind holdout.",
			))
		)
			return undefined;
		yield* check();
		yield* appendStoreEvent(store, { ...(yield* eventEnvelope()), kind: "suite", suite });
		yield* Effect.sync(() =>
			ctx.ui.notify("Probe suite recorded. Prior evaluations cannot approve against this new suite.", "info"),
		);
		return undefined;
	}
	const id = parts[0];
	if (id === undefined) return yield* new HarnessError({ message: HELP });
	if (action === "rollback") {
		const reason = parts.slice(1).join(" ");
		if (reason.length === 0) return yield* new HarnessError({ message: "Rollback requires a reason" });
		const version = state.versions.find((entry) => entry.id === id);
		if (version === undefined || id === state.head.id)
			return yield* new HarnessError({ message: "Choose a different recorded version" });
		if (
			!(yield* confirm(
				ctx,
				"Roll back procedural guidance?",
				`${state.head.id} → ${id}\n${reason}\nNo history is deleted.`,
			))
		)
			return undefined;
		yield* check();
		yield* appendStoreEvent(store, { ...(yield* eventEnvelope()), kind: "rollback", versionId: id, reason });
		yield* Effect.sync(() => ctx.ui.notify("Rollback recorded. Guidance changes on the next request.", "info"));
		return undefined;
	}
	const proposal = state.proposals.find((entry) => entry.id === id);
	if (proposal === undefined) return yield* new HarnessError({ message: `Unknown candidate: ${id}` });
	if (action === "review") {
		const evidence = state.evidence.filter((entry) => proposal.evidenceIds.includes(entry.id));
		yield* Effect.sync(() =>
			ctx.ui.notify(
				JSON.stringify(
					{
						proposal,
						evidence,
						decision: state.decisions.find((entry) => entry.candidateId === id) ?? null,
					},
					null,
					2,
				),
				"info",
			),
		);
		return undefined;
	}
	if (state.decisions.some((entry) => entry.candidateId === id))
		return yield* new HarnessError({ message: "Candidate is already decided" });
	if (action === "evaluate") {
		const modelId = yield* Effect.fromResult(selectedModel(ctx));
		const model = ctx.model;
		if (model === undefined) return yield* new HarnessError({ message: "No selected model" });
		const plan = yield* Effect.fromResult(evaluationPlan(state, id));
		if (loaded.document.events.length >= MAX_EVENTS)
			return yield* new HarnessError({ message: "History is full; evaluation cannot be recorded" });
		const calls = plan.suite.suite.cases.length * EVALUATION_REPEATS * 2;
		if (
			!(yield* confirm(
				ctx,
				"Run paid, read-only decision probes?",
				`${modelId}: ${calls} calls (${EVALUATION_REPEATS} paired repeats per case).\n` +
					`Limits: ${PROBE_MAX_TOKENS} requested output tokens/call, ${PROBE_TIMEOUT_MS / 1000}s/call, ${EVALUATION_TIMEOUT_MS / 60_000}m total; no client retries.\n` +
					"No hard dollar ceiling. Provider-side billing/limits may differ. No tools, session history, or expected answers are sent. " +
					"This tests decisions, not end-to-end coding performance. It does not automatically approve.",
			))
		)
			return undefined;
		const assertEvaluationCurrent = (): void => {
			ensureCurrent();
			const current = selectedModel(ctx);
			if (Result.isFailure(current) || current.success !== modelId)
				throw new HarnessError({ message: "Selected model changed; run a new evaluation" });
		};
		yield* Effect.sync(() =>
			ctx.ui.notify(`Running ${calls} decision probes. /harness cancel stops outstanding work.`, "info"),
		);
		const result = yield* evaluateCandidate({
			ctx,
			model,
			modelId,
			state,
			plan,
			assertCurrent: assertEvaluationCurrent,
			onResponse: (message) =>
				pi.appendEntry("harness-learning:probe-usage", {
					candidateId: id,
					suiteId: plan.suite.id,
					parentVersion: plan.baseline.id,
					provider: message.provider,
					model: message.model,
					usage: message.usage,
				}),
		});
		const event = {
			...(yield* eventEnvelope()),
			kind: "evaluation",
			candidateId: id,
			parentVersion: plan.baseline.id,
			suiteId: plan.suite.id,
			model: modelId,
			pairs: result.pairs,
		};
		const next = yield* appendStoreEvent(store, event);
		const gate = promotionGate(next, id, event.id);
		yield* Effect.sync(() =>
			ctx.ui.notify(
				`Evaluation ${event.id}: ${gate.eligible ? "eligible for human approval" : gate.reasons.join("; ")}.\n` +
					`${result.calls} calls, ${result.tokens} reported tokens, $${result.cost.toFixed(4)} reported cost. ` +
					"Usage is audited in custom session entries, not added to Pi's ordinary session totals.",
				gate.eligible ? "info" : "warning",
			),
		);
		return undefined;
	}
	const reason = parts.slice(1).join(" ");
	if (reason.length === 0) return yield* new HarnessError({ message: "Approval/rejection requires a reason" });
	const evaluation = state.evaluations.findLast((entry) => entry.candidateId === id);
	const approve = action === "approve";
	const modelId = approve ? yield* Effect.fromResult(selectedModel(ctx)) : undefined;
	if (approve) {
		if (evaluation === undefined || evaluation.model !== modelId)
			return yield* new HarnessError({ message: "Approval requires an evaluation using the currently selected model" });
		const gate = promotionGate(state, id, evaluation.id);
		if (!gate.eligible) return yield* new HarnessError({ message: `Promotion refused: ${gate.reasons.join("; ")}` });
	}
	if (
		!(yield* confirm(
			ctx,
			approve ? "Approve procedural guidance?" : "Reject candidate?",
			`${proposal.procedure.title}\n${proposal.procedure.action}\n${reason}\n` +
				(approve
					? "Read /harness review first. A decision-probe pass is not proof of end-to-end reliability."
					: "The rejected candidate and its evidence remain in history."),
		))
	)
		return undefined;
	yield* check();
	if (approve) {
		const current = yield* Effect.fromResult(selectedModel(ctx));
		if (current !== modelId) return yield* new HarnessError({ message: "Selected model changed; approval cancelled" });
	}
	yield* appendStoreEvent(store, {
		...(yield* eventEnvelope()),
		kind: "decision",
		candidateId: id,
		decision: approve ? "approve" : "reject",
		evaluationId: evaluation?.id ?? null,
		reason,
	});
	yield* Effect.sync(() =>
		ctx.ui.notify(
			approve ? "Procedure approved for this model. Guidance changes on the next request." : "Candidate rejected.",
			"info",
		),
	);
	return undefined;
});

const confirm = (ctx: ExtensionCommandContext, title: string, message: string) =>
	Effect.tryPromise({
		try: () => ctx.ui.confirm(title, message),
		catch: (cause) => new HarnessError({ message: `Confirmation failed: ${toError(cause).message}` }),
	});

function status(state: HarnessState): string {
	return [
		`Scope: ${state.scope}`,
		`Current version: ${state.head.id}`,
		`Active candidates: ${state.head.candidateIds.join(", ") || "none"}`,
		`${state.evidence.length} evidence records; ${state.proposals.length} proposals; ${state.evaluations.length} evaluations.`,
		`${state.releases.length} reviewed laboratory releases.`,
		`Recent laboratory runs: ${
			state.releases
				.slice(-5)
				.map((release) => release.lab.runId)
				.join(", ") || "none"
		}`,
		`Latest suite: ${state.suites.at(-1)?.id ?? "none"}`,
		`Recent versions: ${state.versions
			.slice(-10)
			.map((version) => version.id)
			.join(", ")}`,
		"",
		HELP,
	].join("\n");
}
