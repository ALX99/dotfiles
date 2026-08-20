import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { isBashToolResult, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TERMINATION_GRACE_MS = 500;
const TERMINATION_SETTLE_MS = 50;
const GLOBAL_STATE_KEY = Symbol.for("dozy.dotfiles.pi.process-reaper.state-v1");

type ProcessSignal = "SIGTERM" | "SIGKILL";

interface OwnerProcesses {
	readonly markers: Map<string, string>;
	readonly groups: Set<number>;
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
	readonly sleep?: (milliseconds: number) => Promise<void>;
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

function defaultGroupExists(pid: number): boolean {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultProcessExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultSignalGroup(pid: number, signal: ProcessSignal): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
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
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
		this.owner(ownerId).markers.set(toolCallId, marker);

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
		const marker = owner?.markers.get(toolCallId);
		if (owner === undefined || marker === undefined) return;

		const pid = await readPid(marker);
		owner.markers.delete(toolCallId);
		if (pid !== undefined && this.groupExists(pid)) owner.groups.add(pid);
		await fsp.rm(marker, { force: true });
		await this.removeOwnerIfEmpty(ownerId, owner);
	}

	async terminateOwner(ownerId: string): Promise<void> {
		const owner = this.state.owners.get(ownerId);
		if (owner === undefined) return;

		// A settled Bash shell has exited. A process now using its PID belongs
		// to a later process group and must not be signalled.
		const groups = new Set([...owner.groups].filter((pid) => !this.processExists(pid)));
		for (const marker of owner.markers.values()) {
			const pid = await readPid(marker);
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
	}

	private owner(ownerId: string): OwnerProcesses {
		let owner = this.state.owners.get(ownerId);
		if (owner !== undefined) return owner;
		owner = { markers: new Map(), groups: new Set() };
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
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
		}
		await this.removeRootIfEmpty();
	}

	private async removeRootIfEmpty(): Promise<void> {
		try {
			await fsp.rmdir(this.state.rootDir);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
		}
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

export function registerProcessReaper(pi: ExtensionAPI, reaper = getProcessReaper()): void {
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

export default registerProcessReaper;
