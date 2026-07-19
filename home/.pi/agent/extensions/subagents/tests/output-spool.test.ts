import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { OutputSpool } from "../output-spool.ts";

test("OutputSpool appends in order, bounds preview, and creates a private file", async (t) => {
	const spool = new OutputSpool({ maxPreviewBytes: 12, maxPreviewLines: 10 });
	t.after(() => spool.close());
	await Promise.all([spool.append("first"), spool.append("second"), spool.append("third")]);
	const preview = spool.preview();
	assert.equal(preview.truncated, true);
	assert.match(preview.text, /^first/);
	assert.doesNotMatch(preview.text, /Full output saved to:/);
	assert.ok(preview.outputFile);
	assert.equal((await fs.promises.stat(preview.outputFile)).mode & 0o777, 0o600);
	assert.equal(await spool.loadFullOutput(), "first\n\nsecond\n\nthird");
});

test("OutputSpool reports read failure and cleanup is repeatable", async () => {
	const spool = new OutputSpool({ maxPreviewBytes: 1 });
	await spool.append("complete");
	const outputFile = spool.preview().outputFile;
	assert.ok(outputFile);
	const directory = path.dirname(outputFile);
	await fs.promises.rm(outputFile);
	await assert.rejects(spool.loadFullOutput(), /ENOENT/);
	const first = spool.close();
	const second = spool.close();
	assert.equal(first, second);
	await first;
	assert.equal(fs.existsSync(directory), false);
	await assert.rejects(spool.append("late"), /closed/);
});

test("OutputSpool does not publish bytes, lines, or preview text after append failure", async () => {
	const baseDirectory = await fs.promises.mkdtemp(path.join(process.cwd(), "output-spool-failure-"));
	const blocker = path.join(baseDirectory, "not-a-directory");
	await fs.promises.writeFile(blocker, "x");
	const spool = new OutputSpool({ baseDirectory: blocker, maxPreviewBytes: 1 });
	try {
		await assert.rejects(spool.append("unwritten"), /ENOTDIR/);
		assert.deepEqual(spool.preview(), { text: "", truncated: false });
		await assert.rejects(spool.append("also unwritten"), /ENOTDIR/);
		assert.deepEqual(spool.preview(), { text: "", truncated: false });
	} finally {
		await assert.rejects(spool.close(), /cleanup failed/);
		await fs.promises.rm(baseDirectory, { recursive: true, force: true });
	}
});

test("OutputSpool preserves concurrent Unicode append order across preview limits", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.string({ maxLength: 200 }), { maxLength: 10 }),
			fc.integer({ min: 1, max: 500 }),
			fc.integer({ min: 1, max: 20 }),
			async (chunks, maxPreviewBytes, maxPreviewLines) => {
				const spool = new OutputSpool({ maxPreviewBytes, maxPreviewLines });
				let outputFile: string | undefined;
				try {
					await Promise.all(chunks.map((chunk) => spool.append(chunk)));
					let expected = "";
					for (const chunk of chunks) {
						if (Buffer.byteLength(expected, "utf8") > 0) expected += "\n\n";
						expected += chunk;
					}
					assert.equal(await spool.loadFullOutput(), expected);
					const preview = spool.preview();
					if (!preview.truncated) assert.equal(preview.text, expected);
					else {
						assert.ok(preview.outputFile);
						assert.match(preview.text, /\[Output truncated:/);
						assert.ok(
							Buffer.byteLength(preview.text.split("\n\n[Output truncated:")[0] ?? "", "utf8") <= maxPreviewBytes,
						);
					}
					outputFile = preview.outputFile;
				} finally {
					await spool.close();
				}
				if (outputFile) assert.equal(fs.existsSync(outputFile), false);
			},
		),
		{ numRuns: 50 },
	);
});
