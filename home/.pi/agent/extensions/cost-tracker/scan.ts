import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { hasNodeErrorCode } from "../_shared/errors.ts";
import { startOfMonth, type ScanDiagnosticCounts } from "./aggregate.ts";
import { parseSessionLine, type TurnRecord } from "./schema.ts";

export interface ScanOptions {
	readonly sessionsDir: string;
	readonly now: number;
	readonly concurrency?: number;
}

export interface ScanResult {
	readonly records: readonly TurnRecord[];
	readonly diagnostics: ScanDiagnosticCounts;
	readonly messages: readonly string[];
}

interface MutableDiagnostics {
	filesFound: number;
	filesScanned: number;
	filesSkipped: number;
	unreadableFiles: number;
	unreadableDirectories: number;
	emptyLines: number;
	acceptedRecords: number;
	unrelatedRecords: number;
	malformedRecords: number;
}

const MAX_DIAGNOSTIC_MESSAGES = 20;

function addMessage(messages: string[], message: string): void {
	if (messages.length < MAX_DIAGNOSTIC_MESSAGES) messages.push(message);
}

function createDiagnostics(): MutableDiagnostics {
	return {
		filesFound: 0,
		filesScanned: 0,
		filesSkipped: 0,
		unreadableFiles: 0,
		unreadableDirectories: 0,
		emptyLines: 0,
		acceptedRecords: 0,
		unrelatedRecords: 0,
		malformedRecords: 0,
	};
}

async function collectJsonlFiles(
	directory: string,
	diagnostics: MutableDiagnostics,
	messages: string[],
): Promise<string[]> {
	const files: string[] = [];
	try {
		const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				files.push(...(await collectJsonlFiles(path, diagnostics, messages)));
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}
	} catch (error) {
		// A fresh Pi profile has no sessions directory yet; that is an empty
		// source, not an unreadable one.
		if (hasNodeErrorCode(error, "ENOENT")) return files;
		diagnostics.unreadableDirectories++;
		addMessage(messages, `${directory}: unable to list session directory: ${String(error)}`);
	}
	return files;
}

async function scanFile(
	file: string,
	monthCutoff: number,
	diagnostics: MutableDiagnostics,
	messages: string[],
): Promise<TurnRecord[]> {
	try {
		const metadata = await stat(file);
		if (metadata.mtimeMs < monthCutoff) {
			diagnostics.filesSkipped++;
			return [];
		}
	} catch (error) {
		diagnostics.unreadableFiles++;
		addMessage(messages, `${file}: unable to stat session log: ${String(error)}`);
		return [];
	}

	const records: TurnRecord[] = [];
	try {
		const input = createReadStream(file, { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (line.trim().length === 0) {
				diagnostics.emptyLines++;
				continue;
			}
			const parsed = parseSessionLine(line, file);
			switch (parsed.kind) {
				case "accepted":
					if (parsed.record.ts >= monthCutoff) records.push(parsed.record);
					diagnostics.acceptedRecords++;
					break;
				case "unrelated":
					diagnostics.unrelatedRecords++;
					break;
				case "malformed":
					diagnostics.malformedRecords++;
					addMessage(messages, parsed.message);
					break;
			}
		}
		diagnostics.filesScanned++;
	} catch (error) {
		diagnostics.unreadableFiles++;
		addMessage(messages, `${file}: unable to read session log: ${String(error)}`);
	}
	return records;
}

/** Scan session files incrementally; at most `concurrency` streams are open. */
export async function scanUsageRecords(options: ScanOptions): Promise<ScanResult> {
	const diagnostics = createDiagnostics();
	const messages: string[] = [];
	const files = await collectJsonlFiles(options.sessionsDir, diagnostics, messages);
	diagnostics.filesFound = files.length;
	const monthCutoff = startOfMonth(options.now);
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
	const records: TurnRecord[] = [];
	let next = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const index = next++;
			const file = files[index];
			if (file === undefined) return;
			records.push(...(await scanFile(file, monthCutoff, diagnostics, messages)));
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
	return { records, diagnostics, messages };
}
