import { test } from "node:test";
import * as assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasNodeErrorCode } from "../../_shared/errors.ts";
import {
	applyPreflightedPatch,
	MAX_PATCH_SOURCE_BYTES,
	PatchEngineError,
	preflightPatch,
	setPatchEngineFailureInjectorForTests,
	type PatchEngineFailurePoint,
	type SourceSnapshot,
} from "../engine.ts";
import { parsePatch } from "../parser.ts";
import { PatchParseError } from "../patch-types.ts";

async function workspace(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "codex-compat-"));
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
	const root = await workspace();
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function wrap(body: string): string {
	return `*** Begin Patch\n${body}\n*** End Patch\n`;
}

function required<T>(value: T | undefined): T {
	assert.notEqual(value, undefined);
	if (value === undefined) throw new Error("expected test fixture value");
	return value;
}

function sameSnapshot(expected: SourceSnapshot, actual: SourceSnapshot): boolean {
	if (expected.absolutePath !== actual.absolutePath || expected.state !== actual.state) return false;
	return expected.state === "missing" || actual.state === "missing" || expected.hash === actual.hash;
}

test("parser returns typed add, delete, move/update, and multiple chunks", () => {
	const parsed = parsePatch(
		wrap(`*** Add File: added.txt
+hello
*** Delete File: deleted.txt
*** Update File: old.txt
*** Move to: nested/new.txt
@@ heading
-old
+new
@@
 tail
+last
*** End of File`),
	);

	assert.equal(parsed.operations.length, 3);
	assert.deepEqual(parsed.operations[0], {
		kind: "add",
		path: "added.txt",
		content: "hello\n",
		line: 2,
	});
	assert.deepEqual(parsed.operations[1], { kind: "delete", path: "deleted.txt", line: 4 });
	assert.deepEqual(parsed.operations[2], {
		kind: "update",
		path: "old.txt",
		moveTo: "nested/new.txt",
		line: 5,
		chunks: [
			{ context: "heading", oldLines: ["old"], newLines: ["new"], endOfFile: false, line: 7 },
			{ oldLines: ["tail"], newLines: ["tail", "last"], endOfFile: true, line: 10 },
		],
	});
});

test("parser rejects malformed envelopes, unknown headers, and empty hunks", () => {
	assert.throws(
		() => parsePatch("bad"),
		(error) => error instanceof PatchParseError && error.code === "invalid_envelope",
	);
	assert.throws(
		() => parsePatch(wrap("*** Replace File: x")),
		(error) => error instanceof PatchParseError && error.code === "invalid_header",
	);
	assert.throws(
		() => parsePatch(wrap("*** Add File: x")),
		(error) => error instanceof PatchParseError && error.code === "invalid_hunk",
	);
	assert.throws(
		() => parsePatch(wrap("*** Update File: x")),
		(error) => error instanceof PatchParseError && error.code === "invalid_hunk",
	);
});

test("accepts Codex-compatible context-only update chunks", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "edit.txt"), "anchor\nbefore\n");
		const patch = wrap(`*** Update File: edit.txt
@@
 anchor
@@
-before
+after`);

		const plan = await preflightPatch(patch, { workspaceRoot: root });
		assert.equal(plan.changes[0]?.afterContent, "anchor\nafter\n");
	});
});

test("explicit apply performs add, exact/context multi-chunk update, delete, and move", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "edit.txt"), "heading\none\nmiddle\ntwo\n");
		await writeFile(path.join(root, "delete.txt"), "gone\n");
		await writeFile(path.join(root, "move.txt"), "before\n");
		const patch = wrap(`*** Add File: nested/add.txt
+added
*** Update File: edit.txt
@@ heading
-one
+ONE
@@
 middle
-two
+TWO
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved/result.txt
@@
-before
+after`);

		const plan = await preflightPatch(patch, { workspaceRoot: root });
		assert.deepEqual(plan.summary, {
			added: ["nested/add.txt"],
			updated: ["edit.txt"],
			deleted: ["delete.txt"],
			moved: [{ from: "move.txt", to: "moved/result.txt" }],
		});
		assert.equal(required(plan.changes[1]).beforeContent, "heading\none\nmiddle\ntwo\n");
		assert.equal(required(plan.changes[1]).afterContent, "heading\nONE\nmiddle\nTWO\n");
		await assert.rejects(readFile(path.join(root, "nested/add.txt")), { code: "ENOENT" });

		const result = await applyPreflightedPatch(plan);
		assert.equal(result.changes.length, 4);
		assert.equal(await readFile(path.join(root, "nested/add.txt"), "utf8"), "added\n");
		assert.equal(await readFile(path.join(root, "edit.txt"), "utf8"), "heading\nONE\nmiddle\nTWO\n");
		await assert.rejects(readFile(path.join(root, "delete.txt")), { code: "ENOENT" });
		await assert.rejects(readFile(path.join(root, "move.txt")), { code: "ENOENT" });
		assert.equal(await readFile(path.join(root, "moved/result.txt"), "utf8"), "after\n");
	});
});

test("preflight refuses to overwrite an existing add target", async () => {
	await withWorkspace(async (root) => {
		const target = path.join(root, "existing.txt");
		await writeFile(target, "keep add target\n");
		await assert.rejects(
			preflightPatch(wrap("*** Add File: existing.txt\n+replacement"), { workspaceRoot: root }),
			(error) => error instanceof PatchEngineError && error.code === "target_exists",
		);
		assert.equal(await readFile(target, "utf8"), "keep add target\n");
	});
});

test("preflight refuses to overwrite an existing move destination", async () => {
	await withWorkspace(async (root) => {
		const source = path.join(root, "source.txt");
		const destination = path.join(root, "destination.txt");
		await writeFile(source, "source\n");
		await writeFile(destination, "keep destination\n");
		await assert.rejects(
			preflightPatch(
				wrap(`*** Update File: source.txt
*** Move to: destination.txt
@@
-source
+updated`),
				{ workspaceRoot: root },
			),
			(error) => error instanceof PatchEngineError && error.code === "target_exists",
		);
		assert.equal(await readFile(source, "utf8"), "source\n");
		assert.equal(await readFile(destination, "utf8"), "keep destination\n");
	});
});

test("preflight rejects ancestor/descendant targets in either order without writes", async () => {
	await withWorkspace(async (root) => {
		for (const body of [
			"*** Add File: tree\n+file\n*** Add File: tree/child.txt\n+child",
			"*** Add File: tree/child.txt\n+child\n*** Add File: tree\n+file",
		]) {
			await assert.rejects(
				preflightPatch(wrap(body), { workspaceRoot: root }),
				(error) => error instanceof PatchEngineError && error.code === "path_conflict",
			);
		}
		await assert.rejects(readFile(path.join(root, "tree")), { code: "ENOENT" });
	});
});

test("a later preflight failure leaves all earlier files untouched", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "existing.txt"), "original\n");
		const patch = wrap(`*** Add File: would-write.txt
+new
*** Update File: existing.txt
@@
-missing
+changed`);

		await assert.rejects(
			preflightPatch(patch, { workspaceRoot: root }),
			(error) => error instanceof PatchEngineError && error.code === "patch_mismatch",
		);
		await assert.rejects(readFile(path.join(root, "would-write.txt")), { code: "ENOENT" });
		assert.equal(await readFile(path.join(root, "existing.txt"), "utf8"), "original\n");
	});
});

test("path policy rejects absolute paths, traversal, and symlink components", async () => {
	await withWorkspace(async (root) => {
		const outside = await workspace();
		try {
			await mkdir(path.join(root, "safe"));
			await symlink(outside, path.join(root, "safe", "link"));
			for (const unsafe of [
				wrap("*** Add File: ../escape.txt\n+bad"),
				wrap(`*** Add File: ${path.join(root, "absolute.txt")}\n+bad`),
				wrap("*** Add File: nested\\windows.txt\n+bad"),
				wrap("*** Add File: safe/link/escape.txt\n+bad"),
			]) {
				await assert.rejects(
					preflightPatch(unsafe, { workspaceRoot: root }),
					(error) =>
						error instanceof PatchEngineError && (error.code === "unsafe_path" || error.code === "symlink_path"),
				);
			}
			await assert.rejects(readFile(path.join(outside, "escape.txt")), { code: "ENOENT" });
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("apply revalidates every source before any mutation", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "source.txt"), "old\n");
		const plan = await preflightPatch(
			wrap(`*** Add File: first.txt
+first
*** Update File: source.txt
@@
-old
+new`),
			{ workspaceRoot: root },
		);
		await writeFile(path.join(root, "source.txt"), "changed elsewhere\n");

		await assert.rejects(
			applyPreflightedPatch(plan),
			(error) => error instanceof PatchEngineError && error.code === "stale_source",
		);
		await assert.rejects(readFile(path.join(root, "first.txt")), { code: "ENOENT" });
		assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "changed elsewhere\n");
	});
});

test("blank-only files and a blank after the EOF marker are handled", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "blank.txt"), "\n");
		const patch = wrap("*** Update File: blank.txt\n@@\n-\n+not blank\n*** End of File\n");
		const plan = await preflightPatch(patch, { workspaceRoot: root });
		assert.equal(required(plan.changes[0]).afterContent, "not blank\n");
		await applyPreflightedPatch(plan);
		assert.equal(await readFile(path.join(root, "blank.txt"), "utf8"), "not blank\n");
	});
});

test("custom source hashing is used consistently for before and after hashes", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "hash.txt"), "before\n");
		const hashSource = (content: string) => `fixture:${content.length}`;
		const plan = await preflightPatch(wrap("*** Update File: hash.txt\n@@\n-before\n+after"), {
			workspaceRoot: root,
			hashSource,
		});
		assert.equal(required(plan.changes[0]).beforeHash, "fixture:7");
		assert.equal(required(plan.changes[0]).afterHash, "fixture:6");
		const result = await applyPreflightedPatch(plan, { hashSource });
		assert.equal(required(result.changes[0]).afterHash, "fixture:6");
	});
});

test("a path-sensitive hasher hashes move output at its destination", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "from.txt"), "before\n");
		const hashSource = (content: string, absolutePath: string) => `${path.basename(absolutePath)}:${content.length}`;
		const plan = await preflightPatch(
			wrap(`*** Update File: from.txt
*** Move to: to.txt
@@
-before
+after`),
			{ workspaceRoot: root, hashSource },
		);
		assert.equal(required(plan.changes[0]).beforeHash, "from.txt:7");
		assert.equal(required(plan.changes[0]).afterHash, "to.txt:6");
		await applyPreflightedPatch(plan, { hashSource });
	});
});

test("a plan binds its hasher and revalidation strategy", async () => {
	await withWorkspace(async (root) => {
		const hashSource = (content: string) => `fixture:${content.length}`;
		const revalidateSource = (expected: SourceSnapshot, actual: SourceSnapshot) => sameSnapshot(expected, actual);
		const plan = await preflightPatch(wrap("*** Add File: bound.txt\n+bound"), {
			workspaceRoot: root,
			hashSource,
			revalidateSource,
		});
		await assert.rejects(
			applyPreflightedPatch(plan, { hashSource: (content) => content }),
			(error) => error instanceof PatchEngineError && error.code === "invalid_plan",
		);
		await assert.rejects(
			applyPreflightedPatch(plan, { revalidateSource: () => true }),
			(error) => error instanceof PatchEngineError && error.code === "invalid_plan",
		);
		await applyPreflightedPatch(plan);
		assert.equal(await readFile(path.join(root, "bound.txt"), "utf8"), "bound\n");
	});
});

test("apply rejects a structurally forged plan", async () => {
	await withWorkspace(async (root) => {
		const plan = await preflightPatch(wrap("*** Add File: safe.txt\n+safe"), { workspaceRoot: root });
		const forged = { ...plan, changes: [...plan.changes] };
		await assert.rejects(
			applyPreflightedPatch(forged),
			(error) => error instanceof PatchEngineError && error.code === "invalid_plan",
		);
		await assert.rejects(readFile(path.join(root, "safe.txt")), { code: "ENOENT" });
	});
});

test("EOF matching is exact and updates normalize a missing final newline", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "no-newline.txt"), "first\nlast");
		const plan = await preflightPatch(
			wrap(`*** Update File: no-newline.txt
@@
-last
+LAST
*** End of File`),
			{ workspaceRoot: root },
		);
		assert.equal(required(plan.changes[0]).afterContent, "first\nLAST\n");
		await applyPreflightedPatch(plan);
		assert.equal(await readFile(path.join(root, "no-newline.txt"), "utf8"), "first\nLAST\n");

		await assert.rejects(
			preflightPatch(
				wrap(`*** Update File: no-newline.txt
@@
-first
+FIRST
*** End of File`),
				{ workspaceRoot: root },
			),
			(error) => error instanceof PatchEngineError && error.code === "patch_mismatch",
		);
	});
});

test(
	"updates preserve ordinary permissions without carrying special mode bits",
	{
		skip: process.platform === "win32",
	},
	async () => {
		await withWorkspace(async (root) => {
			const target = path.join(root, "mode.txt");
			await writeFile(target, "before\n");
			await chmod(target, 0o4751);
			const plan = await preflightPatch(wrap("*** Update File: mode.txt\n@@\n-before\n+after"), {
				workspaceRoot: root,
			});
			await applyPreflightedPatch(plan);
			assert.equal((await stat(target)).mode & 0o7777, 0o751);
		});
	},
);

test("an already-cancelled apply performs zero writes", async () => {
	await withWorkspace(async (root) => {
		const plan = await preflightPatch(wrap("*** Add File: cancelled.txt\n+nope"), { workspaceRoot: root });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			applyPreflightedPatch(plan, { signal: controller.signal }),
			(error) => error instanceof PatchEngineError && error.code === "cancelled",
		);
		await assert.rejects(readFile(path.join(root, "cancelled.txt")), { code: "ENOENT" });
	});
});

test("preflight rejects hard-link aliases to the same existing file", async () => {
	await withWorkspace(async (root) => {
		const first = path.join(root, "first.txt");
		await writeFile(first, "same inode\n");
		await link(first, path.join(root, "alias.txt"));
		await assert.rejects(
			preflightPatch(
				wrap(`*** Update File: first.txt
@@
-same inode
+first
*** Update File: alias.txt
@@
-same inode
+second`),
				{ workspaceRoot: root },
			),
			(error) => error instanceof PatchEngineError && error.code === "path_conflict",
		);
		assert.equal(await readFile(first, "utf8"), "same inode\n");
	});
});

test("apply rejects a parent replaced by a symlink after preflight", async () => {
	await withWorkspace(async (root) => {
		const parent = path.join(root, "parent");
		const outside = await workspace();
		try {
			await mkdir(parent);
			await writeFile(path.join(parent, "source.txt"), "old\n");
			await writeFile(path.join(outside, "source.txt"), "outside\n");
			const plan = await preflightPatch(
				wrap(`*** Update File: parent/source.txt
@@
-old
+new`),
				{ workspaceRoot: root },
			);
			await rm(parent, { recursive: true });
			await symlink(outside, parent);

			await assert.rejects(
				applyPreflightedPatch(plan),
				(error) => error instanceof PatchEngineError && error.code === "symlink_path",
			);
			assert.equal(await readFile(path.join(outside, "source.txt"), "utf8"), "outside\n");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("a later commit failure rolls back earlier files and reports journal state", async () => {
	await withWorkspace(async (root) => {
		const first = path.join(root, "first.txt");
		const raced = path.join(root, "raced.txt");
		await writeFile(first, "before\n");
		const validationCounts = new Map<string, number>();
		const revalidateSource = async (expected: SourceSnapshot, actual: SourceSnapshot) => {
			const count = (validationCounts.get(expected.path) ?? 0) + 1;
			validationCounts.set(expected.path, count);
			if (expected.path === "raced.txt" && count === 2) {
				await writeFile(raced, "concurrent owner\n");
			}
			return sameSnapshot(expected, actual);
		};
		const plan = await preflightPatch(
			wrap(`*** Update File: first.txt
@@
-before
+after
*** Add File: raced.txt
+planned`),
			{ workspaceRoot: root, revalidateSource },
		);

		let observing = true;
		let observedMissing = false;
		const observer = (async () => {
			while (observing) {
				try {
					await lstat(first);
				} catch (error) {
					if (hasNodeErrorCode(error, "ENOENT")) observedMissing = true;
					else throw error;
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		})();
		try {
			await assert.rejects(
				applyPreflightedPatch(plan, {
					revalidateSource,
				}),
				(error) => {
					assert.ok(error instanceof PatchEngineError);
					assert.equal(error.code, "write_failed");
					assert.deepEqual(
						error.writeState?.applied.map((change) => change.path),
						["first.txt"],
					);
					assert.deepEqual(
						error.writeState?.rolledBack.map((change) => change.path),
						["first.txt"],
					);
					assert.deepEqual(error.writeState?.rollbackFailures, []);
					assert.deepEqual(error.writeState?.journalArtifacts, []);
					return true;
				},
			);
		} finally {
			observing = false;
			await observer;
		}

		assert.equal(observedMissing, false);
		assert.equal(await readFile(first, "utf8"), "before\n");
		assert.equal(await readFile(raced, "utf8"), "concurrent owner\n");
		assert.equal(
			(await readdir(root)).some((name) => name.includes(".apply-patch-")),
			false,
		);
	});
});

test(
	"apply rejects a permission change made after preflight",
	{
		skip: process.platform === "win32",
	},
	async () => {
		await withWorkspace(async (root) => {
			const target = path.join(root, "permissions.txt");
			await writeFile(target, "before\n", { mode: 0o644 });
			await chmod(target, 0o600);
			const plan = await preflightPatch(
				wrap(`*** Update File: permissions.txt
@@
-before
+after`),
				{ workspaceRoot: root },
			);
			await chmod(target, 0o640);

			await assert.rejects(
				applyPreflightedPatch(plan),
				(error) => error instanceof PatchEngineError && error.code === "stale_source",
			);
			assert.equal(await readFile(target, "utf8"), "before\n");
			assert.equal((await stat(target)).mode & 0o777, 0o640);
		});
	},
);

test("rollback state excludes an operation whose backup hardlink never succeeded", async () => {
	await withWorkspace(async (root) => {
		const source = path.join(root, "source.txt");
		await writeFile(source, "before\n");
		const validationCounts = new Map<string, number>();
		const revalidateSource = async (expected: SourceSnapshot, actual: SourceSnapshot) => {
			const count = (validationCounts.get(expected.path) ?? 0) + 1;
			validationCounts.set(expected.path, count);
			if (expected.path === "source.txt" && count === 2) await rm(source);
			return sameSnapshot(expected, actual);
		};
		const plan = await preflightPatch(
			wrap(`*** Add File: first.txt
+first
*** Update File: source.txt
@@
-before
+after`),
			{ workspaceRoot: root, revalidateSource },
		);

		await assert.rejects(applyPreflightedPatch(plan, { revalidateSource }), (error) => {
			assert.ok(error instanceof PatchEngineError);
			assert.equal(error.code, "write_failed");
			assert.deepEqual(
				error.writeState?.applied.map((change) => change.path),
				["first.txt"],
			);
			assert.deepEqual(
				error.writeState?.rolledBack.map((change) => change.path),
				["first.txt"],
			);
			return true;
		});
		await assert.rejects(readFile(path.join(root, "first.txt")), { code: "ENOENT" });
		await assert.rejects(readFile(source), { code: "ENOENT" });
	});
});

test("in-place replacement never makes the target path disappear", async () => {
	await withWorkspace(async (root) => {
		const target = path.join(root, "continuous.txt");
		await writeFile(target, "before\n");
		const hashSource = async (content: string) => {
			await new Promise<void>((resolve) => setTimeout(resolve, 3));
			return `fixture:${content}`;
		};
		const plan = await preflightPatch(
			wrap(`*** Update File: continuous.txt
@@
-before
+after`),
			{ workspaceRoot: root, hashSource },
		);

		let observing = true;
		let observedMissing = false;
		const observer = (async () => {
			while (observing) {
				try {
					await lstat(target);
				} catch (error) {
					if (hasNodeErrorCode(error, "ENOENT")) observedMissing = true;
					else throw error;
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		})();
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			await applyPreflightedPatch(plan, { hashSource });
		} finally {
			observing = false;
			await observer;
		}

		assert.equal(observedMissing, false);
		assert.equal(await readFile(target, "utf8"), "after\n");
	});
});

async function injectFailure<T>(
	point: PatchEngineFailurePoint,
	run: () => Promise<T>,
	extra?: (seen: PatchEngineFailurePoint) => void,
): Promise<T> {
	setPatchEngineFailureInjectorForTests((seen) => {
		extra?.(seen);
		if (seen === point) throw new Error(`injected ${point}`);
	});
	try {
		return await run();
	} finally {
		setPatchEngineFailureInjectorForTests(undefined);
	}
}

async function expectWriteFailure(run: () => Promise<unknown>): Promise<PatchEngineError> {
	try {
		await run();
		throw new Error("expected patch application to fail");
	} catch (error) {
		assert.ok(error instanceof PatchEngineError);
		assert.equal(error.code, "write_failed");
		return error;
	}
}

test("preflight failure injection leaves the workspace and unrelated files unchanged", async () => {
	await withWorkspace(async (root) => {
		const source = path.join(root, "source.txt");
		const unrelated = path.join(root, "unrelated.txt");
		await writeFile(source, "before\n");
		await writeFile(unrelated, "keep\n");
		const patch = wrap("*** Update File: source.txt\n@@\n-before\n+after");

		for (const point of ["source_read", "hash"] as const) {
			await injectFailure(point, async () => {
				await assert.rejects(preflightPatch(patch, { workspaceRoot: root }), /injected/);
			});
			assert.equal(await readFile(source, "utf8"), "before\n");
			assert.equal(await readFile(unrelated, "utf8"), "keep\n");
		}

		const controller = new AbortController();
		setPatchEngineFailureInjectorForTests((point) => {
			if (point === "hash") controller.abort();
		});
		try {
			await assert.rejects(
				preflightPatch(patch, { workspaceRoot: root, signal: controller.signal }),
				(error) => error instanceof PatchEngineError && error.code === "cancelled",
			);
		} finally {
			setPatchEngineFailureInjectorForTests(undefined);
		}
		assert.equal(await readFile(source, "utf8"), "before\n");
		assert.equal(await readFile(unrelated, "utf8"), "keep\n");
	});
});

test("staging and publication failure injection leaves no applied change or unrelated modification", async () => {
	const cases: readonly {
		readonly point: PatchEngineFailurePoint;
		readonly patch: string;
		readonly prepare?: (root: string) => Promise<void>;
	}[] = [
		{ point: "parent_creation", patch: "*** Add File: made/output.txt\n+after" },
		{ point: "temporary_write", patch: "*** Add File: output.txt\n+after" },
		{
			point: "chmod",
			patch: "*** Update File: source.txt\n@@\n-before\n+after",
			prepare: async (root) => writeFile(path.join(root, "source.txt"), "before\n"),
		},
		{ point: "guard_capture", patch: "*** Add File: output.txt\n+after" },
		{ point: "guard_revalidation", patch: "*** Add File: output.txt\n+after" },
		{
			point: "backup_hard_link",
			patch: "*** Update File: source.txt\n@@\n-before\n+after",
			prepare: async (root) => writeFile(path.join(root, "source.txt"), "before\n"),
		},
		{
			point: "backup_verification",
			patch: "*** Update File: source.txt\n@@\n-before\n+after",
			prepare: async (root) => writeFile(path.join(root, "source.txt"), "before\n"),
		},
		{ point: "destination_publication", patch: "*** Add File: output.txt\n+after" },
		{
			point: "source_unlink",
			patch: "*** Delete File: source.txt",
			prepare: async (root) => writeFile(path.join(root, "source.txt"), "before\n"),
		},
		{ point: "installed_output_verification", patch: "*** Add File: output.txt\n+after" },
	];

	for (const fixture of cases) {
		await withWorkspace(async (root) => {
			await fixture.prepare?.(root);
			const unrelated = path.join(root, "unrelated.txt");
			await writeFile(unrelated, "keep\n");
			const plan = await preflightPatch(wrap(fixture.patch), { workspaceRoot: root });
			const error = await injectFailure(fixture.point, () => expectWriteFailure(() => applyPreflightedPatch(plan)));
			assert.deepEqual(error.writeState?.applied, []);
			assert.deepEqual(error.writeState?.journalArtifacts, []);
			assert.ok(error.writeState?.rolledBack.every((change) => change.path === "output.txt"));
			assert.equal(await readFile(unrelated, "utf8"), "keep\n");
			assert.equal(
				(await readdir(root)).some((name) => name.includes(".apply-patch-")),
				false,
			);
			if (fixture.prepare !== undefined)
				assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "before\n");
			else await assert.rejects(readFile(path.join(root, "output.txt")), { code: "ENOENT" });
		});
	}
});

test("rollback, cleanup, and cancellation injection report recovery state without touching unrelated files", async () => {
	await withWorkspace(async (root) => {
		const unrelated = path.join(root, "unrelated.txt");
		await writeFile(unrelated, "keep\n");
		const controller = new AbortController();
		const plan = await preflightPatch(wrap("*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second"), {
			workspaceRoot: root,
		});
		setPatchEngineFailureInjectorForTests((point) => {
			if (point === "operation_committed") controller.abort();
		});
		try {
			const error = await expectWriteFailure(() => applyPreflightedPatch(plan, { signal: controller.signal }));
			assert.deepEqual(
				error.writeState?.applied.map((change) => change.path),
				["first.txt"],
			);
			assert.deepEqual(
				error.writeState?.rolledBack.map((change) => change.path),
				["first.txt"],
			);
			assert.deepEqual(error.writeState?.journalArtifacts, []);
		} finally {
			setPatchEngineFailureInjectorForTests(undefined);
		}
		await assert.rejects(readFile(path.join(root, "first.txt")), { code: "ENOENT" });
		await assert.rejects(readFile(path.join(root, "second.txt")), { code: "ENOENT" });
		assert.equal(await readFile(unrelated, "utf8"), "keep\n");
	});

	for (const point of ["rollback_unlink", "rollback_restore"] as const) {
		await withWorkspace(async (root) => {
			const unrelated = path.join(root, "unrelated.txt");
			await writeFile(unrelated, "keep\n");
			if (point === "rollback_restore") await writeFile(path.join(root, "first.txt"), "before\n");
			const second = point === "rollback_restore" ? "second.txt" : "source.txt";
			if (point === "rollback_unlink") await writeFile(path.join(root, second), "before\n");
			let secondChecks = 0;
			const revalidateSource = (expected: SourceSnapshot, actual: SourceSnapshot) => {
				if (expected.path === second) {
					secondChecks++;
					return secondChecks < 2;
				}
				return sameSnapshot(expected, actual);
			};
			const patch =
				point === "rollback_restore"
					? "*** Update File: first.txt\n@@\n-before\n+after\n*** Add File: second.txt\n+second"
					: "*** Add File: first.txt\n+first\n*** Update File: source.txt\n@@\n-before\n+after";
			const plan = await preflightPatch(wrap(patch), { workspaceRoot: root, revalidateSource });
			const error = await injectFailure(point, () => expectWriteFailure(() => applyPreflightedPatch(plan)));
			assert.ok(error.writeState?.rollbackFailures.some((failure) => failure.action.length > 0));
			assert.equal(await readFile(unrelated, "utf8"), "keep\n");
		});
	}

	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "source.txt"), "before\n");
		await writeFile(path.join(root, "unrelated.txt"), "keep\n");
		let destinationChecks = 0;
		const revalidateSource = (expected: SourceSnapshot, actual: SourceSnapshot) => {
			if (expected.path === "second.txt") {
				destinationChecks++;
				return destinationChecks < 2;
			}
			return sameSnapshot(expected, actual);
		};
		const plan = await preflightPatch(wrap("*** Delete File: source.txt\n*** Add File: second.txt\n+second"), {
			workspaceRoot: root,
			revalidateSource,
		});
		const error = await injectFailure("rollback_restore", () => expectWriteFailure(() => applyPreflightedPatch(plan)));
		assert.ok(error.writeState?.rollbackFailures.some((failure) => failure.action === "restore original"));
		assert.equal(await readFile(path.join(root, "unrelated.txt"), "utf8"), "keep\n");
	});

	await withWorkspace(async (root) => {
		const unrelated = path.join(root, "unrelated.txt");
		await writeFile(unrelated, "keep\n");
		await writeFile(path.join(root, "source.txt"), "before\n");
		const plan = await preflightPatch(wrap("*** Update File: source.txt\n@@\n-before\n+after"), {
			workspaceRoot: root,
		});
		await injectFailure("journal_cleanup", async () => {
			const result = await applyPreflightedPatch(plan);
			assert.equal(result.journalArtifacts.length, 1);
		});
		assert.equal(await readFile(unrelated, "utf8"), "keep\n");
	});
});

test("source reads are bounded and cancellation during staging removes staged output", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "large.txt"), Buffer.alloc(MAX_PATCH_SOURCE_BYTES + 1));
		await assert.rejects(
			preflightPatch(wrap("*** Delete File: large.txt"), { workspaceRoot: root }),
			(error) => error instanceof PatchEngineError && error.code === "source_too_large",
		);

		const controller = new AbortController();
		const plan = await preflightPatch(wrap("*** Add File: nested/output.txt\n+after"), { workspaceRoot: root });
		setPatchEngineFailureInjectorForTests((point) => {
			if (point === "temporary_write") controller.abort();
		});
		try {
			const error = await expectWriteFailure(() => applyPreflightedPatch(plan, { signal: controller.signal }));
			assert.equal(error.writeState?.phase, "staging");
			assert.deepEqual(error.writeState?.journalArtifacts, []);
			assert.deepEqual(error.writeState?.createdDirectoriesRemaining, []);
		} finally {
			setPatchEngineFailureInjectorForTests(undefined);
		}
		await assert.rejects(readFile(path.join(root, "nested", "output.txt")), { code: "ENOENT" });
	});
});

test("a created-directory cleanup failure is retained as a recovery artifact", async () => {
	await withWorkspace(async (root) => {
		const unrelated = path.join(root, "unrelated.txt");
		await writeFile(unrelated, "keep\n");
		const plan = await preflightPatch(wrap("*** Add File: nested/output.txt\n+after"), { workspaceRoot: root });
		setPatchEngineFailureInjectorForTests((point) => {
			if (point === "guard_capture" || point === "created_directory_cleanup") {
				throw new Error(`injected ${point}`);
			}
		});
		try {
			const error = await expectWriteFailure(() => applyPreflightedPatch(plan));
			assert.deepEqual(error.writeState?.applied, []);
			assert.deepEqual(error.writeState?.rolledBack, []);
			assert.equal(error.writeState?.createdDirectoriesRemaining.length, 1);
			assert.equal(path.basename(error.writeState?.createdDirectoriesRemaining[0] ?? ""), "nested");
			assert.deepEqual(
				error.writeState?.rollbackFailures.map((failure) => failure.action),
				["remove created directory"],
			);
		} finally {
			setPatchEngineFailureInjectorForTests(undefined);
		}
		assert.equal(await readFile(unrelated, "utf8"), "keep\n");
		await rm(path.join(root, "nested"), { recursive: true, force: true });
	});
});
