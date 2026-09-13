import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { isBashToolResult, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Schedule, Schema } from "effect";
import { runFork, runPromise } from "../_shared/effect-runtime.ts";
import type { FsError } from "../_shared/errors.ts";
import {
	makeDirectory,
	readFileStringIfExists,
	removeDirectoryIfEmpty,
	removeFile,
	removeTree,
	writeFileString,
} from "../_shared/fs.ts";

/** A retained process group that could not be terminated. */
export class ProcessReaperError extends Schema.TaggedError<ProcessReaperError>()("ProcessReaperError", {
	message: Schema.String,
	pids: Schema.Array(Schema.Int),
}) {}

const TERMINATION_GRACE_MS = 500;
const TERMINATION_SETTLE_MS = 50;
const BACKGROUND_SWEEP_INTERVAL_MS = 5_000;
const GLOBAL_STATE_KEY = Symbol.for("dotfiles.pi.process-reaper.state-v1");

type ProcessSignal = "SIGTERM" | "SIGKILL";

interface OwnerProcesses {
	readonly markers: Map<string, PendingProcess>;
	readonly groups: Map<number, BackgroundJob>;
}

interface PendingProcess {
	readonly marker: string;
	readonly command: string;
}

interface ProcessReaperState {
	readonly rootDir: string;
	readonly owners: Map<string, OwnerProcesses>;
}

interface ProcessReaperGlobal {
	[GLOBAL_STATE_KEY]?: ProcessReaperState;
}

export interface ProcessReaperOptions {
	readonly rootDir?: string;
	readonly groupExists?: (pid: number) => boolean;
	readonly processExists?: (pid: number) => boolean;
	readonly signalGroup?: (pid: number, signal: ProcessSignal) => void;
	/** Sleep seam for tests; production sleeps on the Effect clock. */
	readonly sleep?: (milliseconds: number) => Effect.Effect<void>;
}

export interface BackgroundJob {
	readonly pid: number;
	readonly ownerId: string;
	readonly toolCallId: string;
	readonly command: string;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function defaultRootDir(): string {
	return path.join(os.tmpdir(), `pi-process-reaper-${process.pid}-${randomBytes(16).toString("hex")}`);
}

function quoteShellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function errnoCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	const { code } = error;
	return typeof code === "string" ? code : undefined;
}

function defaultGroupExists(pid: number): boolean {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, 0);
		return true;
	} catch (error) {
		return errnoCode(error) === "EPERM";
	}
}

function defaultProcessExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoCode(error) === "EPERM";
	}
}

function defaultSignalGroup(pid: number, signal: ProcessSignal): void {
	if (process.platform === "win32") {
		const child = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
		// A process can exit between the existence check and taskkill. Consume
		// the resulting asynchronous spawn error just like POSIX signal races.
		child.once("error", () => {});
		return;
	}
	process.kill(-pid, signal);
}

function defaultSleep(milliseconds: number): Effect.Effect<void> {
	return Effect.sleep(milliseconds);
}

function parsePid(contents: string): number | undefined {
	const pid = Number(contents.trim());
	return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : undefined;
}

function readPid(marker: string): Effect.Effect<number | undefined, FsError> {
	return Effect.gen(function* () {
		const contents = yield* readFileStringIfExists(marker);
		return contents === undefined ? undefined : parsePid(contents);
	});
}

/**
 * Tracks detached process groups started by Bash calls in this Pi process.
 *
 * Marker files are a short-lived handoff from the detached shell to the
 * extension. Ownership and live groups remain process-local so stale PIDs are
 * never recovered after a crash or restart.
 */
export class ProcessReaper {
	private readonly state: ProcessReaperState;
	private readonly groupExists: (pid: number) => boolean;
	private readonly processExists: (pid: number) => boolean;
	private readonly signalGroup: (pid: number, signal: ProcessSignal) => void;
	private readonly sleep: (milliseconds: number) => Effect.Effect<void>;

	constructor(options: ProcessReaperOptions = {}, state?: ProcessReaperState) {
		this.state = state ?? createState(options.rootDir ?? defaultRootDir());
		this.groupExists = options.groupExists ?? defaultGroupExists;
		this.processExists = options.processExists ?? defaultProcessExists;
		this.signalGroup = options.signalGroup ?? defaultSignalGroup;
		this.sleep = options.sleep ?? defaultSleep;
	}

	markerPath(ownerId: string, toolCallId: string): string {
		return path.join(this.state.rootDir, hash(ownerId), `${hash(toolCallId)}.pid`);
	}

	/**
	 * Register a Bash call for cleanup and wrap its command so the shell records
	 * its own PID in the marker file before running anything else.
	 */
	prepareCommand(ownerId: string, toolCallId: string, command: string): Effect.Effect<string, FsError> {
		return Effect.gen({ self: this }, function* () {
			const marker = this.markerPath(ownerId, toolCallId);
			yield* makeDirectory(path.dirname(marker), 0o700);
			yield* writeFileString(marker, "", { mode: 0o600 });
			this.owner(ownerId).markers.set(toolCallId, { marker, command });

			const quotedMarker = quoteShellArgument(marker);
			return [
				`if ! printf '%s\\n' "$$" > ${quotedMarker}; then`,
				"  printf '%s\\n' 'Pi could not register this process for cleanup.' >&2",
				"  exit 125",
				"fi",
				command,
			].join("\n");
		});
	}

	finishCommand(ownerId: string, toolCallId: string): Effect.Effect<void, FsError> {
		return Effect.gen({ self: this }, function* () {
			const owner = this.state.owners.get(ownerId);
			const pending = owner?.markers.get(toolCallId);
			if (owner === undefined || pending === undefined) return undefined;

			const pid = yield* readPid(pending.marker);
			owner.markers.delete(toolCallId);
			if (pid !== undefined && this.groupExists(pid)) {
				owner.groups.set(pid, {
					pid,
					ownerId,
					toolCallId,
					command: pending.command,
				});
			}
			yield* removeFile(pending.marker);
			yield* this.removeOwnerIfEmpty(ownerId, owner);
			return undefined;
		});
	}

	terminateOwner(ownerId: string): Effect.Effect<void, FsError | ProcessReaperError> {
		return Effect.gen({ self: this }, function* () {
			const owner = this.state.owners.get(ownerId);
			if (owner === undefined) return undefined;

			// A settled Bash shell has exited. A process now using its PID belongs
			// to a later process group and must not be signalled.
			const groups = new Set([...owner.groups.keys()].filter((pid) => !this.processExists(pid)));
			for (const marker of owner.markers.values()) {
				const pid = yield* readPid(marker.marker);
				if (pid !== undefined) groups.add(pid);
			}

			const liveGroups = [...groups].filter((pid) => this.groupExists(pid));
			for (const pid of liveGroups) this.trySignal(pid, "SIGTERM");
			if (liveGroups.length > 0) yield* this.sleep(TERMINATION_GRACE_MS);

			const survivors = liveGroups.filter((pid) => this.groupExists(pid));
			for (const pid of survivors) this.trySignal(pid, "SIGKILL");
			if (survivors.length > 0) yield* this.sleep(TERMINATION_SETTLE_MS);

			const remaining = survivors.filter((pid) => this.groupExists(pid));
			if (remaining.length > 0) {
				return yield* new ProcessReaperError({
					message: `Could not terminate process groups: ${remaining.join(", ")}`,
					pids: remaining,
				});
			}

			this.state.owners.delete(ownerId);
			yield* removeTree(path.join(this.state.rootDir, hash(ownerId)));
			yield* this.removeRootIfEmpty();
			return undefined;
		});
	}

	/** Drop retained groups that have exited. */
	pruneFinishedJobs(): Effect.Effect<void, FsError> {
		return Effect.gen({ self: this }, function* () {
			for (const [ownerId, owner] of this.state.owners) {
				for (const pid of owner.groups.keys()) {
					if (!this.groupExists(pid)) owner.groups.delete(pid);
				}
				yield* this.removeOwnerIfEmpty(ownerId, owner);
			}
			return undefined;
		});
	}

	/** Return a snapshot of all background jobs retained by this process. */
	listBackgroundJobs(): BackgroundJob[] {
		return [...this.state.owners.values()]
			.flatMap((owner) => [...owner.groups.values()])
			.toSorted((left, right) => left.pid - right.pid);
	}

	private owner(ownerId: string): OwnerProcesses {
		let owner = this.state.owners.get(ownerId);
		if (owner !== undefined) return owner;
		owner = { markers: new Map(), groups: new Map() };
		this.state.owners.set(ownerId, owner);
		return owner;
	}

	private trySignal(pid: number, signal: ProcessSignal): void {
		try {
			this.signalGroup(pid, signal);
		} catch {
			// The group may exit between the existence check and signal.
		}
	}

	private removeOwnerIfEmpty(ownerId: string, owner: OwnerProcesses): Effect.Effect<void, FsError> {
		return Effect.gen({ self: this }, function* () {
			if (owner.markers.size > 0 || owner.groups.size > 0) return undefined;
			if (this.state.owners.get(ownerId) === owner) this.state.owners.delete(ownerId);
			yield* removeDirectoryIfEmpty(path.join(this.state.rootDir, hash(ownerId)));
			yield* this.removeRootIfEmpty();
			return undefined;
		});
	}

	private removeRootIfEmpty(): Effect.Effect<void, FsError> {
		return Effect.gen({ self: this }, function* () {
			yield* removeDirectoryIfEmpty(this.state.rootDir);
			return undefined;
		});
	}
}

function createState(rootDir: string): ProcessReaperState {
	return { rootDir, owners: new Map() };
}

export function getProcessReaper(): ProcessReaper {
	const host = globalThis as typeof globalThis & ProcessReaperGlobal;
	const state = host[GLOBAL_STATE_KEY] ?? createState(defaultRootDir());
	host[GLOBAL_STATE_KEY] = state;
	return new ProcessReaper({}, state);
}

function registerProcessReaper(pi: ExtensionAPI, reaper = getProcessReaper()): void {
	// Retained groups are only revisited on tool results, the /jobs command, and
	// shutdown, so sweep on a schedule to converge stored state with live truth
	// when a job exits while the user is idle.
	runFork(
		reaper
			.pruneFinishedJobs()
			// A failed sweep must not stop later sweeps from converging state.
			.pipe(
				Effect.catchTag("FsError", () => Effect.void),
				Effect.repeat(Schedule.spaced(BACKGROUND_SWEEP_INTERVAL_MS)),
			),
	);

	pi.registerCommand("jobs", {
		description: "List background jobs tracked by the process reaper",
		handler: async (_args, ctx) => {
			await runPromise(reaper.pruneFinishedJobs());
			ctx.ui.notify(formatBackgroundJobs(reaper.listBackgroundJobs()), "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const ownerId = ctx.sessionManager.getSessionId();
		event.input.command = await runPromise(reaper.prepareCommand(ownerId, event.toolCallId, event.input.command));
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event)) return;
		await runPromise(reaper.finishCommand(ctx.sessionManager.getSessionId(), event.toolCallId));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await runPromise(reaper.terminateOwner(ctx.sessionManager.getSessionId()));
	});
}

export function formatBackgroundJobs(jobs: readonly BackgroundJob[]): string {
	if (jobs.length === 0) return "No background jobs.";
	return [
		`Background jobs (${jobs.length}):`,
		...jobs.map((job) => `  ${job.pid}  ${job.ownerId}  ${formatCommand(job.command)}`),
	].join("\n");
}

function formatCommand(command: string): string {
	return command.replaceAll(/\s+/gu, " ").trim();
}

export default registerProcessReaper;
