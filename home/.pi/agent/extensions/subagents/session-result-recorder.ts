import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { captureGeneration, type CapturedGeneration } from "./result-store.ts";
import {
	getRpcSessionEntries,
	readChildSessionEntriesSince,
	type ChildSessionIdentity,
	type SessionCheckpoint,
	type SessionEntries,
	type SessionEntriesRpc,
} from "./session-cursors.ts";
import { validateChildSessionIdentity } from "./result-store.ts";

const EMPTY_SESSION_CHECKPOINT: SessionCheckpoint = Object.freeze({ appendCursor: null, leafId: null });

export interface SessionResultRecorderOptions {
	readonly agentId: string;
	readonly agentDir: string;
	readonly validateSessionIdentity?: (
		identity: ChildSessionIdentity,
		agentDir: string,
	) => Promise<ChildSessionIdentity>;
}

interface LiveSessionEntriesRpc extends SessionEntriesRpc {
	readonly isOpen: boolean;
}

/**
 * Records native session boundaries for successive generations in one child
 * session. The resulting locators are the durable source of truth.
 */
export class SessionResultRecorder {
	private readonly options: SessionResultRecorderOptions;
	private sessionIdentity: ChildSessionIdentity | undefined;
	private sessionCheckpoint: SessionCheckpoint = EMPTY_SESSION_CHECKPOINT;
	private generationStart: SessionCheckpoint | undefined;
	private generationEntries: SessionEntry[] = [];

	constructor(options: SessionResultRecorderOptions) {
		this.options = options;
	}

	async setIdentity(identity: ChildSessionIdentity): Promise<ChildSessionIdentity> {
		const validated = await (this.options.validateSessionIdentity ?? validateChildSessionIdentity)(
			identity,
			this.options.agentDir,
		);
		this.sessionIdentity = validated;
		return validated;
	}

	async prepareGeneration(transport: SessionEntriesRpc): Promise<void> {
		if (!this.sessionIdentity) throw new Error(`Agent ${this.options.agentId} has no validated session identity.`);
		const captured = await getRpcSessionEntries(transport, this.sessionCheckpoint);
		this.sessionCheckpoint = captured.checkpoint;
		this.generationStart = captured.checkpoint;
		this.generationEntries = [];
	}

	async captureSettlement(
		transport: SessionEntriesRpc,
		generation: number,
		resultId: string,
	): Promise<CapturedGeneration> {
		const start = this.generationStart;
		const previous = this.sessionCheckpoint;
		const identity = this.sessionIdentity;
		if (!start || !previous || !identity) {
			throw new Error(`Agent ${this.options.agentId} generation ${generation} has no validated session checkpoint.`);
		}
		const captured = await getRpcSessionEntries(transport, previous);
		return this.captureEntries(identity, generation, resultId, start, captured.checkpoint, captured.entries);
	}

	async captureFailedGeneration(
		transport: LiveSessionEntriesRpc | undefined,
		generation: number,
		resultId: string,
	): Promise<CapturedGeneration | undefined> {
		const start = this.generationStart;
		const previous = this.sessionCheckpoint;
		const identity = this.sessionIdentity;
		if (!start || !previous || !identity) return undefined;
		let captured: SessionEntries;
		if (transport?.isOpen) {
			try {
				captured = await getRpcSessionEntries(transport, previous);
			} catch (error) {
				if (transport.isOpen) throw error;
				captured = await readChildSessionEntriesSince(identity.sessionFile, previous, this.options.agentDir);
			}
		} else {
			captured = await readChildSessionEntriesSince(identity.sessionFile, previous, this.options.agentDir);
		}
		return this.captureEntries(identity, generation, resultId, start, captured.checkpoint, captured.entries);
	}

	private captureEntries(
		identity: ChildSessionIdentity,
		generation: number,
		resultId: string,
		start: SessionCheckpoint,
		end: SessionCheckpoint,
		entries: readonly SessionEntry[],
	): CapturedGeneration {
		const generationEntries = [...this.generationEntries, ...entries];
		const captured = captureGeneration(identity, generation, resultId, start, end, generationEntries);
		this.generationEntries = generationEntries;
		this.sessionCheckpoint = end;
		return captured;
	}
}
