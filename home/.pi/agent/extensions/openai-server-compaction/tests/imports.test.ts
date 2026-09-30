import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Pi loads extensions through jiti, which applies a package's exports map to the first
 * subpath segment only: `@earendil-works/pi-ai/utils/pi-user-agent` resolves to
 * `dist/compat.js/utils/pi-user-agent` and the extension fails to load at runtime, while
 * typecheck and `node --test` both accept it. Keep Pi imports at a package root or a single
 * subpath segment.
 */
describe("extension imports", () => {
	it("keeps Pi imports to a root or single subpath segment", () => {
		for (const file of sourceFiles(extensionDir)) {
			for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
				if (!specifier.startsWith("@earendil-works/")) continue;
				const segments = specifier.split("/").slice(1);
				assert.ok(segments.length <= 2, file + " imports " + specifier);
			}
		}
	});
});

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function importSpecifiers(source: string): string[] {
	return [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
}
