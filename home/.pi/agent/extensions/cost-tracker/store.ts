import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hasNodeErrorCode, toError } from "../_shared/errors.ts";
import { startOfMonth } from "./aggregate.ts";
import { CostTrackerStoreV1Schema, ToolRecordSchema, type ToolRecord } from "./schema.ts";

export interface StoreFileSystem {
	readonly mkdir: typeof mkdir;
	readonly readFile: typeof readFile;
	readonly rename: typeof rename;
	readonly unlink: typeof unlink;
	readonly writeFile: typeof writeFile;
}

const nodeFileSystem: StoreFileSystem = { mkdir, readFile, rename, unlink, writeFile };

export interface StoreOptions {
	readonly file: string;
	readonly now: () => number;
	readonly fs?: StoreFileSystem;
}

export interface StoreLoadResult {
	readonly records: readonly ToolRecord[];
	readonly messages: readonly string[];
	/** False means saving would overwrite data we could not preserve. */
	readonly writable: boolean;
}

export class CostTrackerStore {
	private readonly file: string;
	private readonly now: () => number;
	private readonly fs: StoreFileSystem;
	private writeTail: Promise<void> = Promise.resolve();
	private tempSequence = 0;
	private writable = true;

	constructor(options: StoreOptions) {
		this.file = options.file;
		this.now = options.now;
		this.fs = options.fs ?? nodeFileSystem;
	}

	async load(): Promise<StoreLoadResult> {
		let raw: string;
		try {
			raw = await this.fs.readFile(this.file, "utf8");
		} catch (error) {
			if (hasNodeErrorCode(error, "ENOENT")) return { records: [], messages: [], writable: true };
			this.writable = false;
			return {
				records: [],
				messages: [`${this.file}: unable to read tool store: ${toError(error).message}`],
				writable: false,
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			return this.quarantineInvalidStore(`invalid JSON: ${toError(error).message}`);
		}
		const validated = CostTrackerStoreV1Schema.safeParse(parsed);
		if (validated.success) return { records: validated.data.records, messages: [], writable: this.writable };

		// The former extension wrote a bare array. It is unambiguous and can be
		// safely upgraded on the next save instead of discarding existing counts.
		const legacy = ToolRecordSchema.array().safeParse(parsed);
		if (legacy.success) {
			return {
				records: legacy.data,
				messages: [`${this.file}: loaded legacy tool store; it will be upgraded on save`],
				writable: this.writable,
			};
		}
		return this.quarantineInvalidStore(
			`invalid store format: ${validated.error.issues[0]?.message ?? "unknown validation error"}`,
		);
	}

	private async quarantineInvalidStore(reason: string): Promise<StoreLoadResult> {
		const quarantine = `${this.file}.corrupt-${this.now()}-${this.tempSequence++}`;
		try {
			await this.fs.rename(this.file, quarantine);
			return {
				records: [],
				messages: [`${this.file}: ${reason}; moved aside as ${basename(quarantine)}`],
				writable: true,
			};
		} catch (error) {
			this.writable = false;
			return {
				records: [],
				messages: [`${this.file}: ${reason}; could not quarantine existing store: ${toError(error).message}`],
				writable: false,
			};
		}
	}

	save(records: readonly ToolRecord[]): Promise<void> {
		const operation = this.writeTail.then(async () => {
			if (!this.writable) throw new Error(`Refusing to overwrite unavailable tool store: ${this.file}`);
			await this.persist(records);
		});
		// A failed write must not prevent a later deliberate save attempt.
		this.writeTail = operation.catch(() => undefined);
		return operation;
	}

	private async persist(records: readonly ToolRecord[]): Promise<void> {
		const cutoff = startOfMonth(this.now());
		const store = { version: 1 as const, records: records.filter((record) => record.ts >= cutoff) };
		const serialized = JSON.stringify(store);
		const directory = dirname(this.file);
		const temporary = join(directory, `.${basename(this.file)}.tmp-${process.pid}-${this.tempSequence++}`);

		await this.fs.mkdir(directory, { recursive: true });
		try {
			await this.fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
			const staged = CostTrackerStoreV1Schema.safeParse(JSON.parse(await this.fs.readFile(temporary, "utf8")));
			if (!staged.success) throw new Error(`Refusing to publish invalid tool store: ${staged.error.message}`);
			// rename is atomic when source and target are on the same filesystem.
			await this.fs.rename(temporary, this.file);
		} catch (error) {
			try {
				await this.fs.unlink(temporary);
			} catch (cleanupError) {
				if (!hasNodeErrorCode(cleanupError, "ENOENT")) {
					throw new Error(`Failed to save ${this.file}; temporary cleanup also failed`, {
						cause: new AggregateError([error, cleanupError]),
					});
				}
			}
			throw error;
		}
	}
}
