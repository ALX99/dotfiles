/**
 * Caffeinate Extension — Prevents macOS sleep while an agent is running.
 *
 * Spawns `caffeinate` when a user prompt begins processing and kills it when
 * the agent finishes. The assertion is also tied to Pi's PID so abnormal exits
 * cannot leave an orphaned caffeinate process behind.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { toError } from "./_shared/errors.ts";

export interface CaffeinateProcess {
	kill(): boolean | undefined;
	once(event: "error" | "exit", listener: (error?: Error) => void): unknown;
}

export interface CaffeinateControllerOptions {
	readonly platform: NodeJS.Platform;
	readonly pid: number;
	readonly spawn: (
		command: string,
		args: readonly string[],
		options: { readonly stdio: "ignore" },
	) => CaffeinateProcess;
	readonly onError: (error: Error) => void;
}

/** A small owner for the one session-scoped caffeinate child process. */
export class CaffeinateController {
	private process: CaffeinateProcess | undefined;
	private readonly options: CaffeinateControllerOptions;

	constructor(options: CaffeinateControllerOptions) {
		this.options = options;
	}

	start(): void {
		if (this.options.platform !== "darwin" || this.process) return;

		let child: CaffeinateProcess;
		try {
			child = this.options.spawn("/usr/bin/caffeinate", ["-i", "-w", String(this.options.pid)], { stdio: "ignore" });
		} catch (error) {
			this.options.onError(toError(error));
			return;
		}
		this.process = child;
		const clearProcess = () => {
			if (this.process === child) this.process = undefined;
		};
		child.once("error", (error) => {
			clearProcess();
			this.options.onError(error ?? new Error("caffeinate emitted an error without details"));
		});
		child.once("exit", clearProcess);
	}

	stop(): void {
		const child = this.process;
		this.process = undefined;
		if (!child) return;
		try {
			child.kill();
		} catch (error) {
			this.options.onError(toError(error));
		}
	}
}

export default function caffeinate(pi: ExtensionAPI): void {
	const controller = new CaffeinateController({
		platform: process.platform,
		pid: process.pid,
		spawn,
		onError: (error) => process.emitWarning(error, { type: "CaffeinateError" }),
	});

	// Start caffeinate when the agent begins processing a user prompt.
	pi.on("agent_start", () => controller.start());

	// Stop caffeinate when the agent finishes.
	pi.on("agent_end", () => controller.stop());

	// Safety net: clean up on session shutdown (quit, reload, switch, fork).
	pi.on("session_shutdown", () => controller.stop());
}
