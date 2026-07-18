import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

const NOTICE_RESERVE_BYTES = 2_048;
const NOTICE_RESERVE_LINES = 2;

export interface OutputPreview {
	readonly text: string;
	readonly outputFile?: string;
	readonly truncated: boolean;
}

export interface OutputSpoolOptions {
	readonly baseDirectory?: string;
	readonly maxPreviewBytes?: number;
	readonly maxPreviewLines?: number;
}

/** Owns one private append-only output file and its bounded head preview. */
export class OutputSpool {
	private readonly options: OutputSpoolOptions;
	private directory: string | undefined;
	private filePath: string | undefined;
	private previewText = "";
	private totalBytes = 0;
	private totalNewlines = 0;
	private truncated = false;
	private writeTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<void> | undefined;
	private closed = false;

	constructor(options: OutputSpoolOptions = {}) {
		this.options = options;
	}

	async append(text: string): Promise<OutputPreview> {
		if (this.closed) throw new Error("Output spool is closed.");
		const separator = this.totalBytes > 0 ? "\n\n" : "";
		const addition = `${separator}${text}`;
		this.totalBytes += Buffer.byteLength(addition, "utf8");
		this.totalNewlines += countNewlines(addition);
		this.updatePreview(addition);
		const operation = this.writeTail.then(async () => {
			const outputFile = await this.ensureFile();
			await fs.promises.appendFile(outputFile, addition, "utf8");
		});
		this.writeTail = operation;
		await operation;
		return this.preview();
	}

	preview(): OutputPreview {
		if (!this.truncated) return { text: this.previewText, truncated: false };
		const outputFile = this.filePath;
		const notice = `\n\n[Output truncated: ${countLines(this.previewText)} of ${this.totalBytes === 0 ? 0 : this.totalNewlines + 1} lines (${formatSize(Buffer.byteLength(this.previewText, "utf8"))} of ${formatSize(this.totalBytes)}).${outputFile ? ` Full output saved to: ${outputFile}` : ""}]`;
		return {
			text: `${this.previewText}${notice}`,
			...(outputFile === undefined ? {} : { outputFile }),
			truncated: true,
		};
	}

	async loadFullOutput(): Promise<string> {
		await this.writeTail;
		if (!this.filePath) return "";
		return fs.promises.readFile(this.filePath, "utf8");
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = (async () => {
			const failures: unknown[] = [];
			try {
				await this.writeTail;
			} catch (error) {
				failures.push(error);
			}
			try {
				if (this.directory) await fs.promises.rm(this.directory, { recursive: true, force: true });
			} catch (error) {
				failures.push(error);
			} finally {
				this.directory = undefined;
				this.filePath = undefined;
			}
			if (failures.length > 0) throw new AggregateError(failures, "Output spool cleanup failed.");
		})();
		return this.closePromise;
	}

	private updatePreview(addition: string): void {
		if (this.truncated) return;
		const result = truncateHead(this.previewText + addition, {
			maxBytes: this.options.maxPreviewBytes ?? DEFAULT_MAX_BYTES - NOTICE_RESERVE_BYTES,
			maxLines: this.options.maxPreviewLines ?? DEFAULT_MAX_LINES - NOTICE_RESERVE_LINES,
		});
		this.previewText = result.content;
		this.truncated = result.truncated;
	}

	private async ensureFile(): Promise<string> {
		if (this.filePath) return this.filePath;
		const baseDirectory = this.options.baseDirectory ?? os.tmpdir();
		this.directory = await fs.promises.mkdtemp(path.join(baseDirectory, "subagent-output-"));
		this.filePath = path.join(this.directory, "final.md");
		await fs.promises.writeFile(this.filePath, "", { encoding: "utf8", mode: 0o600 });
		return this.filePath;
	}
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return countNewlines(text) + 1;
}

function countNewlines(text: string): number {
	let newlines = 0;
	for (const character of text) if (character === "\n") newlines++;
	return newlines;
}
