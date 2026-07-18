/**
 * Caffeinate Extension — Prevents macOS sleep while an agent is running.
 *
 * Spawns `caffeinate` when a user prompt begins processing and kills it when
 * the agent finishes. The assertion is also tied to Pi's PID so abnormal exits
 * cannot leave an orphaned caffeinate process behind.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toError } from "./_shared/errors.ts";

type CaffeinateProcess = {
	kill(): boolean | undefined;
	once(event: "error" | "exit", listener: (error?: Error) => void): unknown;
};

type SpawnCaffeinate = (
	command: string,
	args: readonly string[],
	options: { readonly stdio: "ignore" },
) => CaffeinateProcess;

export function createCaffeinate(
	platform: NodeJS.Platform,
	pid: number,
	spawnProcess: SpawnCaffeinate,
	onError: (error: Error) => void,
): { start(): void; stop(): void } {
	let child: CaffeinateProcess | undefined;

	function start(): void {
		if (platform !== "darwin" || child) return;

		let spawned: CaffeinateProcess;
		try {
			spawned = spawnProcess("/usr/bin/caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
		} catch (error) {
			onError(toError(error));
			return;
		}
		child = spawned;
		const clearProcess = () => {
			if (child === spawned) child = undefined;
		};
		spawned.once("error", (error) => {
			clearProcess();
			onError(error ?? new Error("caffeinate emitted an error without details"));
		});
		spawned.once("exit", clearProcess);
	}

	function stop(): void {
		const activeChild = child;
		child = undefined;
		if (!activeChild) return;
		try {
			activeChild.kill();
		} catch (error) {
			onError(toError(error));
		}
	}

	return { start, stop };
}

export default function caffeinate(pi: ExtensionAPI): void {
	const controller = createCaffeinate(process.platform, process.pid, spawn, (error) =>
		process.emitWarning(error, { type: "CaffeinateError" }),
	);

	// Start caffeinate when the agent begins processing a user prompt.
	pi.on("agent_start", () => controller.start());

	// Stop caffeinate when the agent finishes.
	pi.on("agent_end", () => controller.stop());

	// Safety net: clean up on session shutdown (quit, reload, switch, fork).
	pi.on("session_shutdown", () => controller.stop());
}
