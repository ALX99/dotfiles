/** Incremental JSONL framing with a byte limit applied before UTF-8 decoding. */
export class ByteBoundedJsonlFramer {
	private segments: Buffer[] = [];
	private bufferedBytes = 0;
	private readonly maxFrameBytes: number;

	constructor(maxFrameBytes: number) {
		this.maxFrameBytes = maxFrameBytes;
	}

	push(raw: Buffer | string): string[] {
		const lines: string[] = [];
		const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
		let offset = 0;
		while (offset < chunk.byteLength) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline < 0 ? chunk.byteLength : newline;
			this.append(chunk.subarray(offset, end));
			if (newline < 0) break;
			lines.push(this.takeLine());
			offset = newline + 1;
		}
		return lines;
	}

	end(): string[] {
		return this.bufferedBytes === 0 ? [] : [this.takeLine()];
	}

	private append(segment: Buffer): void {
		if (this.bufferedBytes + segment.byteLength > this.maxFrameBytes) {
			throw new Error(`JSONL frame exceeds the ${this.maxFrameBytes} byte limit.`);
		}
		if (segment.byteLength === 0) return;
		this.segments.push(segment);
		this.bufferedBytes += segment.byteLength;
	}

	private takeLine(): string {
		let line = Buffer.concat(this.segments, this.bufferedBytes);
		if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
		this.segments = [];
		this.bufferedBytes = 0;
		return line.toString("utf8");
	}
}
