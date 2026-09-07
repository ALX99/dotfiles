import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { isBashToolResult, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TERMINATION_GRACE_MS = 500;
const TERMINATION_SETTLE_MS = 50;
const BACKGROUND_SWEEP_INTERVAL_MS = 5_000;
const GLOBAL_STATE_KEY = Symbol.for("dotfiles.pi.process-reaper.state-v1");

type ProcessSignal = "SIGTERM" | "SIGKILL";

interface OwnerProcesses {
	readonly markers: Map<string, PendingProcess>;
	readonly groups: Map<number, BackgroundJob>;
}

type BackgroundGroupCountListener = (backgroundGroups: number) => void;

interface PendingProcess {
	readonly marker: string;
	readonly command: string;
}

interface ProcessReaperState {
	readonly rootDir: string;
	readonly owners: Map<string, OwnerProcesses>;
	readonly listeners: Set<BackgroundGroupCountListener>;
}

interface ProcessReaperGlobal {
	[GLOBAL_STATE_KEY]?: ProcessReaperState;
}

export interface ProcessReaperOptions {
	readonly rootDir?: string;
	readonly groupExists?: (pid: number) => boolean;
	readonly processExists?: (pid: number) => boolean;
	readonly signalGroup?: (pid: number, signal: ProcessSignal) => void;
	readonly sleep?: (milliseconds: number) => Promise<void>;
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

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parsePid(contents: string): number | undefined {
	const pid = Number(contents.trim());
	return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : undefined;
}

async function readPid(marker: string): Promise<number | undefined> {
	try {
		return parsePid(await fsp.readFile(marker, "utf8"));
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return undefined;
		throw error;
	}
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
	private readonly sleep: (milliseconds: number) => Promise<void>;

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

	prepareCommand(ownerId: string, toolCallId: string, command: string): string {
		const marker = this.markerPath(ownerId, toolCallId);
		fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
		fs.writeFileSync(marker, "", { encoding: "utf8", mode: 0o600 });
		this.owner(ownerId).markers.set(toolCallId, { marker, command });

		const quotedMarker = quoteShellArgument(marker);
		return [
			`if ! printf '%s\\n' "$$" > ${quotedMarker}; then`,
			"  printf '%s\\n' 'Pi could not register this process for cleanup.' >&2",
			"  exit 125",
			"fi",
			command,
		].join("\n");
	}

	async finishCommand(ownerId: string, toolCallId: string): Promise<void> {
		const owner = this.state.owners.get(ownerId);
		const pending = owner?.markers.get(toolCallId);
		if (owner === undefined || pending === undefined) return;
		const previousBackgroundGroups = this.backgroundGroupCount();

		const pid = await readPid(pending.marker);
		owner.markers.delete(toolCallId);
		if (pid !== undefined && this.groupExists(pid)) {
			owner.groups.set(pid, {
				pid,
				ownerId,
				toolCallId,
				command: pending.command,
			});
		}
		await fsp.rm(pending.marker, { force: true });
		await this.removeOwnerIfEmpty(ownerId, owner);
		this.notifyBackgroundGroupChange(previousBackgroundGroups);
	}

	async terminateOwner(ownerId: string): Promise<void> {
		const owner = this.state.owners.get(ownerId);
		if (owner === undefined) return;
		const previousBackgroundGroups = this.backgroundGroupCount();

		// A settled Bash shell has exited. A process now using its PID belongs
		// to a later process group and must not be signalled.
		const groups = new Set([...owner.groups.keys()].filter((pid) => !this.processExists(pid)));
		for (const marker of owner.markers.values()) {
			const pid = await readPid(marker.marker);
			if (pid !== undefined) groups.add(pid);
		}

		const liveGroups = [...groups].filter((pid) => this.groupExists(pid));
		for (const pid of liveGroups) this.trySignal(pid, "SIGTERM");
		if (liveGroups.length > 0) await this.sleep(TERMINATION_GRACE_MS);

		const survivors = liveGroups.filter((pid) => this.groupExists(pid));
		for (const pid of survivors) this.trySignal(pid, "SIGKILL");
		if (survivors.length > 0) await this.sleep(TERMINATION_SETTLE_MS);

		const remaining = survivors.filter((pid) => this.groupExists(pid));
		if (remaining.length > 0) {
			throw new Error(`Could not terminate process groups: ${remaining.join(", ")}`);
		}

		this.state.owners.delete(ownerId);
		await fsp.rm(path.join(this.state.rootDir, hash(ownerId)), { recursive: true, force: true });
		await this.removeRootIfEmpty();
		this.notifyBackgroundGroupChange(previousBackgroundGroups);
	}

	/** Drop retained groups that have exited and notify when the count changes. */
	async pruneFinishedJobs(): Promise<void> {
		const previousBackgroundGroups = this.backgroundGroupCount();
		for (const [ownerId, owner] of this.state.owners) {
			for (const pid of owner.groups.keys()) {
				if (!this.groupExists(pid)) owner.groups.delete(pid);
			}
			await this.removeOwnerIfEmpty(ownerId, owner);
		}
		this.notifyBackgroundGroupChange(previousBackgroundGroups);
	}

	/** Subscribe to background-group count changes. The current count is emitted immediately. */
	onBackgroundGroupChange(listener: BackgroundGroupCountListener): () => void {
		const listeners = this.state.listeners;
		listeners.add(listener);
		listener(this.backgroundGroupCount());
		return () => listeners.delete(listener);
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

	private async removeOwnerIfEmpty(ownerId: string, owner: OwnerProcesses): Promise<void> {
		if (owner.markers.size > 0 || owner.groups.size > 0) return;
		if (this.state.owners.get(ownerId) === owner) this.state.owners.delete(ownerId);
		try {
			await fsp.rmdir(path.join(this.state.rootDir, hash(ownerId)));
		} catch (error) {
			const code = errnoCode(error);
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
		}
		await this.removeRootIfEmpty();
	}

	private async removeRootIfEmpty(): Promise<void> {
		try {
			await fsp.rmdir(this.state.rootDir);
		} catch (error) {
			const code = errnoCode(error);
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
		}
	}

	private backgroundGroupCount(): number {
		let count = 0;
		for (const owner of this.state.owners.values()) count += owner.groups.size;
		return count;
	}

	private notifyBackgroundGroupChange(previousBackgroundGroups: number): void {
		const backgroundGroups = this.backgroundGroupCount();
		if (backgroundGroups === previousBackgroundGroups) return;
		for (const listener of this.state.listeners) listener(backgroundGroups);
	}
}

function createState(rootDir: string): ProcessReaperState {
	return { rootDir, owners: new Map(), listeners: new Set() };
}

export function getProcessReaper(): ProcessReaper {
	const host = globalThis as typeof globalThis & ProcessReaperGlobal;
	const state = host[GLOBAL_STATE_KEY] ?? createState(defaultRootDir());
	host[GLOBAL_STATE_KEY] = state;
	return new ProcessReaper({}, state);
}

function registerProcessReaper(pi: ExtensionAPI, reaper = getProcessReaper()): void {
	// Retained groups are only revisited on tool results and shutdown, so sweep
	// on a timer to converge stored state with live truth (and the bg badge)
	// when a job exits while the user is idle. Unref'd like other extension
	// ticks; the reaper owns freshness, consumers just subscribe.
	setInterval(() => {
		void reaper.pruneFinishedJobs().catch(() => {});
	}, BACKGROUND_SWEEP_INTERVAL_MS).unref?.();

	pi.registerCommand("jobs", {
		description: "List background jobs tracked by the process reaper",
		handler: async (_args, ctx) => {
			await reaper.pruneFinishedJobs();
			ctx.ui.notify(formatBackgroundJobs(reaper.listBackgroundJobs()), "info");
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const ownerId = ctx.sessionManager.getSessionId();
		event.input.command = reaper.prepareCommand(ownerId, event.toolCallId, event.input.command);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event)) return;
		await reaper.finishCommand(ctx.sessionManager.getSessionId(), event.toolCallId);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await reaper.terminateOwner(ctx.sessionManager.getSessionId());
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
