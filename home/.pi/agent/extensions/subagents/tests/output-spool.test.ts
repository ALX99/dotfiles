import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { OutputSpool } from "../output-spool.ts";

test("OutputSpool appends in order, bounds preview, and creates a private file", async (t) => {
	const spool = new OutputSpool({ maxPreviewBytes: 12, maxPreviewLines: 10 });
	t.after(() => spool.close());
	await Promise.all([spool.append("first"), spool.append("second"), spool.append("third")]);
	const preview = spool.preview();
	assert.equal(preview.truncated, true);
	assert.match(preview.text, /^first/);
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
