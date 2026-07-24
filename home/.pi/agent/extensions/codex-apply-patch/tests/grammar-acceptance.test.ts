import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "../index.ts";

// These cases pin *what the real Codex `apply_patch` binary accepts at parse
// time*. The Lark grammar in `../types.ts` is intentionally aligned to this
// oracle: the model is grammar-constrained, so the grammar must accept exactly
// the patch strings Codex parses (and reject the ones it rejects), otherwise
// the model emits patches that Codex refuses.
//
// Verify by running the actual `codex` CLI in its `apply_patch` multicall mode.
// The test is skipped when `codex` is not on PATH.
interface Case {
	readonly name: string;
	readonly patch: string;
	/** Whether Codex parses the patch (apply-stage file errors are still "accepted"). */
	readonly accepted: boolean;
	readonly note?: string;
}

const CASES: readonly Case[] = [
	{
		name: "add file with content",
		patch: "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "add empty file (grammar uses add_line*)",
		patch: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch\n",
		accepted: true,
		note: "Upstream grammar's add_line+ wrongly rejected empty-file creation.",
	},
	{
		name: "add file with a blank line",
		patch: "*** Begin Patch\n*** Add File: b.txt\n+first\n+\n+third\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "delete file",
		patch: "*** Begin Patch\n*** Delete File: d.txt\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "update file with a change",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@\n-old\n+new\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "update file with move and change",
		patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "bare @@ context",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@\n-a\n+b\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "empty @@ context (grammar uses /.*/)",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@ \n-a\n+b\n*** End Patch\n",
		accepted: true,
		note: "Upstream grammar's /(.+)/ wrongly rejected a bare '@@ ' context.",
	},
	{
		name: "@@ context with text",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@ def f():\n-a\n+b\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "End of File marker",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@\n+new\n*** End of File\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "add and update in one patch",
		patch: "*** Begin Patch\n*** Add File: r1.txt\n+line\n*** Update File: r2.txt\n@@\n+new\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "empty update hunk is rejected (grammar requires change)",
		patch: "*** Begin Patch\n*** Update File: u.txt\n*** End Patch\n",
		accepted: false,
		note: "Codex: 'Update file hunk ... is empty'. Upstream grammar's change? allowed it.",
	},
	{
		name: "move-only rename is rejected (grammar requires change)",
		patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n",
		accepted: false,
		note: "Codex rejects empty update hunks, so a pure rename needs no hunk here.",
	},
	{
		name: "bad first line is rejected",
		patch: "*** Begin Pach\n*** End Patch\n",
		accepted: false,
	},
	{
		name: "missing end marker is rejected",
		patch: "*** Begin Patch\n*** Add File: a.txt\n+hi\n",
		accepted: false,
	},
	{
		name: "blank line inside add hunk is rejected",
		patch: "*** Begin Patch\n*** Add File: k.txt\n+first\n\n+third\n*** End Patch\n",
		accepted: false,
	},
	{
		name: "End of File marker inside add hunk is rejected",
		patch: "*** Begin Patch\n*** Add File: j.txt\n+first\n*** End of File\n*** End Patch\n",
		accepted: false,
	},
	{
		name: "Environment ID preamble is accepted by Codex",
		patch: "*** Begin Patch\n*** Environment ID: remote\n*** Add File: e.txt\n+hi\n*** End Patch\n",
		accepted: true,
		note: "Intentionally omitted from the grammar: this extension is single-environment.",
	},
];

async function codexAccepts(patch: string): Promise<boolean> {
	const cwd = await mkdtemp(path.join(tmpdir(), "codex-apply-patch-accept-"));
	try {
		await createApplyPatchTool().execute("tool_accept", { patch }, undefined, undefined, { cwd } as ExtensionContext);
		return true;
	} catch (error) {
		if (error instanceof Error && /spawn codex ENOENT/.test(error.message)) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		// Parse rejections carry an "Invalid patch" message. Any other failure
		// (missing file, context mismatch) means Codex parsed the patch fine.
		return !/Invalid patch/.test(message);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("apply_patch grammar aligns with what Codex accepts", async (t) => {
	let skipped = false;
	for (const { name, patch, accepted, note } of CASES) {
		try {
			const actual = await codexAccepts(patch);
			assert.equal(actual, accepted, `${name}${note ? ` (${note})` : ""}`);
		} catch (error) {
			if (error instanceof Error && /spawn codex ENOENT/.test(error.message)) {
				t.skip("Codex is not installed on PATH");
				skipped = true;
				break;
			}
			throw error;
		}
	}
	void skipped;
});
