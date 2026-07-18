import {
	PatchParseError,
	type ParsedPatch,
	type PatchChunk,
	type PatchOperation,
} from "./patch-types.ts";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";

function splitLines(input: string): string[] {
	const lines = input.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function operationHeader(line: string): boolean {
	return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
}

function readPath(line: string, prefix: string, lineNumber: number): string {
	const value = line.slice(prefix.length);
	if (value.length === 0) throw new PatchParseError("empty_path", lineNumber, "file path is empty");
	return value;
}

/** Parse raw `*** Begin Patch` text without touching the filesystem. */
export function parsePatch(input: string): ParsedPatch {
	if (typeof input !== "string") throw new TypeError("patch input must be a string");
	const lines = splitLines(input);
	if (lines[0] !== BEGIN) {
		throw new PatchParseError("invalid_envelope", 1, `first line must be '${BEGIN}'`);
	}
	if (lines.length < 2 || lines.at(-1) !== END) {
		throw new PatchParseError("invalid_envelope", Math.max(lines.length, 1), `last line must be '${END}'`);
	}

	const operations: PatchOperation[] = [];
	let index = 1;
	const bodyEnd = lines.length - 1;
	while (index < bodyEnd) {
		const header = lines[index];
		const lineNumber = index + 1;
		if (header.startsWith(ADD)) {
			const path = readPath(header, ADD, lineNumber);
			index++;
			const content: string[] = [];
			while (index < bodyEnd && !operationHeader(lines[index])) {
				if (!lines[index].startsWith("+")) {
					throw new PatchParseError("invalid_hunk", index + 1, "add-file lines must start with '+'");
				}
				content.push(lines[index].slice(1));
				index++;
			}
			if (content.length === 0) {
				throw new PatchParseError("invalid_hunk", lineNumber, `add-file hunk for '${path}' is empty`);
			}
			operations.push({ kind: "add", path, content: `${content.join("\n")}\n`, line: lineNumber });
			continue;
		}

		if (header.startsWith(DELETE)) {
			operations.push({
				kind: "delete",
				path: readPath(header, DELETE, lineNumber),
				line: lineNumber,
			});
			index++;
			if (index < bodyEnd && !operationHeader(lines[index])) {
				throw new PatchParseError("invalid_hunk", index + 1, "delete-file hunk cannot have a body");
			}
			continue;
		}

		if (!header.startsWith(UPDATE)) {
			throw new PatchParseError("invalid_header", lineNumber, `unrecognized operation '${header}'`);
		}

		const path = readPath(header, UPDATE, lineNumber);
		index++;
		let moveTo: string | undefined;
		if (index < bodyEnd && lines[index].startsWith(MOVE)) {
			moveTo = readPath(lines[index], MOVE, index + 1);
			index++;
		}

		const chunks: PatchChunk[] = [];
		let chunk: PatchChunk | undefined;
		while (index < bodyEnd && !operationHeader(lines[index])) {
			const line = lines[index];
			if (line === "@@" || line.startsWith("@@ ")) {
				chunk = {
					...(line === "@@" ? {} : { context: line.slice(3) }),
					oldLines: [],
					newLines: [],
					endOfFile: false,
					line: index + 1,
				};
				chunks.push(chunk);
				index++;
				continue;
			}
			if (line === EOF) {
				if (chunk === undefined) {
					throw new PatchParseError("invalid_hunk", index + 1, "end-of-file marker requires an update chunk");
				}
				chunk.endOfFile = true;
				index++;
				while (index < bodyEnd && lines[index] === "") index++;
				if (index < bodyEnd && !operationHeader(lines[index])) {
					throw new PatchParseError("invalid_hunk", index + 1, "end-of-file marker must end its file hunk");
				}
				break;
			}
			if (line.startsWith("***")) {
				throw new PatchParseError("invalid_header", index + 1, `unrecognized marker '${line}'`);
			}
			if (!line.startsWith("+") && !line.startsWith("-") && !line.startsWith(" ")) {
				throw new PatchParseError("invalid_hunk", index + 1, "update lines must start with '+', '-', or space");
			}
			if (chunk === undefined) {
				chunk = { oldLines: [], newLines: [], endOfFile: false, line: index + 1 };
				chunks.push(chunk);
			}
			const text = line.slice(1);
			if (line[0] !== "+") chunk.oldLines.push(text);
			if (line[0] !== "-") chunk.newLines.push(text);
			index++;
		}

		if (chunks.length === 0 && moveTo === undefined) {
			throw new PatchParseError("invalid_hunk", lineNumber, `update-file hunk for '${path}' is empty`);
		}
		operations.push({ kind: "update", path, ...(moveTo === undefined ? {} : { moveTo }), chunks, line: lineNumber });
	}

	if (operations.length === 0) throw new PatchParseError("empty_patch", 1, "patch has no file operations");
	return { raw: input, operations };
}
