import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "../index.ts";

// These cases pin the syntax accepted by the installed Codex apply_patch
// executable. Codex remains the sole patch parser and application authority;
// this matrix verifies that the extension delegates to it unchanged.
interface Case {
	readonly name: string;
	readonly patch: string;
	/** Whether Codex parses the patch (apply-stage file errors are still accepted). */
	readonly accepted: boolean;
}

const CASES: readonly Case[] = [
	{
		name: "empty patch",
		patch: "*** Begin Patch\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "add file with content",
		patch: "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "trimmed markers and CRLF",
		patch: "  *** Begin Patch \r\n  *** Add File: a.txt   \r\n+hello\r\n *** End Patch \r\n",
		accepted: true,
	},
	{
		name: "add empty file",
		patch: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch\n",
		accepted: true,
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
		name: "empty @@ context",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@ \n-a\n+b\n*** End Patch\n",
		accepted: true,
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
		name: "blank update line and blank line after End of File",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@\n-old\n\n+new\n*** End of File\n\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "add and update in one patch",
		patch: "*** Begin Patch\n*** Add File: r1.txt\n+line\n*** Update File: r2.txt\n@@\n+new\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "empty update hunk is rejected",
		patch: "*** Begin Patch\n*** Update File: u.txt\n*** End Patch\n",
		accepted: false,
	},
	{
		name: "move-only rename is rejected",
		patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n",
		accepted: false,
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
		name: "context-only update hunk is rejected",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@\n*** End Patch\n",
		accepted: false,
	},
	{
		name: "context and End of File without change lines is rejected",
		patch: "*** Begin Patch\n*** Update File: u.txt\n@@\n*** End of File\n*** End Patch\n",
		accepted: false,
	},
	{
		name: "Environment ID with trailing whitespace",
		patch: "*** Begin Patch\n*** Environment ID: remote  \n*** Add File: e.txt\n+hi\n*** End Patch\n",
		accepted: true,
	},
	{
		name: "blank Environment ID is rejected",
		patch: "*** Begin Patch\n*** Environment ID:   \n*** Add File: e.txt\n+hi\n*** End Patch\n",
		accepted: false,
	},
];

async function codexAccepts(patch: string): Promise<boolean> {
	const cwd = await mkdtemp(path.join(tmpdir(), "codex-apply-patch-accept-"));
	try {
		await createApplyPatchTool().execute("tool_accept", { patch }, undefined, undefined, {
			cwd,
		} as ExtensionContext);
		return true;
	} catch (error) {
		if (error instanceof Error && /spawn codex ENOENT/.test(error.message)) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		// Parse rejections carry an "Invalid patch" message. Any other failure
		// (missing file, context mismatch, or no files modified) means Codex parsed it.
		return !/Invalid patch/.test(message);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("apply_patch delegates syntax acceptance to Codex", async (t) => {
	for (const { name, patch, accepted } of CASES) {
		try {
			const actual = await codexAccepts(patch);
			assert.equal(actual, accepted, name);
		} catch (error) {
			if (error instanceof Error && /spawn codex ENOENT/.test(error.message)) {
				t.skip("Codex is not installed on PATH");
				return;
			}
			throw error;
		}
	}
});
