import { test } from "node:test";
import * as assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyPreflightedPatch,
	PatchEngineError,
	preflightPatch,
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

test("parser returns typed add, delete, move/update, and multiple chunks", () => {
	const parsed = parsePatch(wrap(`*** Add File: added.txt
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
*** End of File`));

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
	assert.throws(() => parsePatch("bad"), (error) =>
		error instanceof PatchParseError && error.code === "invalid_envelope"
	);
	assert.throws(() => parsePatch(wrap("*** Replace File: x")), (error) =>
		error instanceof PatchParseError && error.code === "invalid_header"
	);
	assert.throws(() => parsePatch(wrap("*** Add File: x")), (error) =>
		error instanceof PatchParseError && error.code === "invalid_hunk"
	);
	assert.throws(() => parsePatch(wrap("*** Update File: x")), (error) =>
		error instanceof PatchParseError && error.code === "invalid_hunk"
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
		assert.equal(plan.changes[1].beforeContent, "heading\none\nmiddle\ntwo\n");
		assert.equal(plan.changes[1].afterContent, "heading\nONE\nmiddle\nTWO\n");
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
			preflightPatch(wrap(`*** Update File: source.txt
*** Move to: destination.txt
@@
-source
+updated`), { workspaceRoot: root }),
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
					(error) => error instanceof PatchEngineError
						&& (error.code === "unsafe_path" || error.code === "symlink_path"),
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
		const plan = await preflightPatch(wrap(`*** Add File: first.txt
+first
*** Update File: source.txt
@@
-old
+new`), { workspaceRoot: root });
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
		assert.equal(plan.changes[0].afterContent, "not blank\n");
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
		assert.equal(plan.changes[0].beforeHash, "fixture:7");
		assert.equal(plan.changes[0].afterHash, "fixture:6");
		const result = await applyPreflightedPatch(plan, { hashSource });
		assert.equal(result.changes[0].afterHash, "fixture:6");
	});
});

test("a path-sensitive hasher hashes move output at its destination", async () => {
	await withWorkspace(async (root) => {
		await writeFile(path.join(root, "from.txt"), "before\n");
		const hashSource = (content: string, absolutePath: string) => `${path.basename(absolutePath)}:${content.length}`;
		const plan = await preflightPatch(wrap(`*** Update File: from.txt
*** Move to: to.txt
@@
-before
+after`), { workspaceRoot: root, hashSource });
		assert.equal(plan.changes[0].beforeHash, "from.txt:7");
		assert.equal(plan.changes[0].afterHash, "to.txt:6");
		await applyPreflightedPatch(plan, { hashSource });
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
		const plan = await preflightPatch(wrap(`*** Update File: no-newline.txt
@@
-last
+LAST
*** End of File`), { workspaceRoot: root });
		assert.equal(plan.changes[0].afterContent, "first\nLAST\n");
		await applyPreflightedPatch(plan);
		assert.equal(await readFile(path.join(root, "no-newline.txt"), "utf8"), "first\nLAST\n");

		await assert.rejects(
			preflightPatch(wrap(`*** Update File: no-newline.txt
@@
-first
+FIRST
*** End of File`), { workspaceRoot: root }),
			(error) => error instanceof PatchEngineError && error.code === "patch_mismatch",
		);
	});
});

test("updates preserve ordinary permissions without carrying special mode bits", {
	skip: process.platform === "win32",
}, async () => {
	await withWorkspace(async (root) => {
		const target = path.join(root, "mode.txt");
		await writeFile(target, "before\n");
		await chmod(target, 0o4751);
		const plan = await preflightPatch(wrap("*** Update File: mode.txt\n@@\n-before\n+after"), { workspaceRoot: root });
		await applyPreflightedPatch(plan);
		assert.equal((await stat(target)).mode & 0o7777, 0o751);
	});
});

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
			preflightPatch(wrap(`*** Update File: first.txt
@@
-same inode
+first
*** Update File: alias.txt
@@
-same inode
+second`), { workspaceRoot: root }),
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
			const plan = await preflightPatch(wrap(`*** Update File: parent/source.txt
@@
-old
+new`), { workspaceRoot: root });
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
		const plan = await preflightPatch(wrap(`*** Update File: first.txt
@@
-before
+after
*** Add File: raced.txt
+planned`), { workspaceRoot: root });

		const validationCounts = new Map<string, number>();
		let observing = true;
		let observedMissing = false;
		const observer = (async () => {
			while (observing) {
				try {
					await lstat(first);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT")
						observedMissing = true;
					else
						throw error;
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		})();
		try {
			await assert.rejects(
				applyPreflightedPatch(plan, {
					revalidateSource: async (expected, actual) => {
						const count = (validationCounts.get(expected.path) ?? 0) + 1;
						validationCounts.set(expected.path, count);
						if (expected.path === "raced.txt" && count === 2) {
							await writeFile(raced, "concurrent owner\n");
						}
						return expected.absolutePath === actual.absolutePath
							&& expected.state === actual.state
							&& expected.hash === actual.hash;
					},
				}),
				(error) => {
					assert.ok(error instanceof PatchEngineError);
					assert.equal(error.code, "write_failed");
					assert.deepEqual(error.writeState?.applied.map((change) => change.path), ["first.txt"]);
					assert.deepEqual(error.writeState?.rolledBack.map((change) => change.path), ["first.txt"]);
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
		assert.equal((await readdir(root)).some((name) => name.includes(".apply-patch-")), false);
	});
});

test("apply rejects a permission change made after preflight", {
	skip: process.platform === "win32",
}, async () => {
	await withWorkspace(async (root) => {
		const target = path.join(root, "permissions.txt");
		await writeFile(target, "before\n", { mode: 0o644 });
		await chmod(target, 0o600);
		const plan = await preflightPatch(wrap(`*** Update File: permissions.txt
@@
-before
+after`), { workspaceRoot: root });
		await chmod(target, 0o640);

		await assert.rejects(
			applyPreflightedPatch(plan),
			(error) => error instanceof PatchEngineError && error.code === "stale_source",
		);
		assert.equal(await readFile(target, "utf8"), "before\n");
		assert.equal((await stat(target)).mode & 0o777, 0o640);
	});
});

test("rollback state excludes an operation whose backup hardlink never succeeded", async () => {
	await withWorkspace(async (root) => {
		const source = path.join(root, "source.txt");
		await writeFile(source, "before\n");
		const plan = await preflightPatch(wrap(`*** Add File: first.txt
+first
*** Update File: source.txt
@@
-before
+after`), { workspaceRoot: root });
		const validationCounts = new Map<string, number>();

		await assert.rejects(
			applyPreflightedPatch(plan, {
				revalidateSource: async (expected, actual) => {
					const count = (validationCounts.get(expected.path) ?? 0) + 1;
					validationCounts.set(expected.path, count);
					if (expected.path === "source.txt" && count === 2)
						await rm(source);
					return expected.absolutePath === actual.absolutePath
						&& expected.state === actual.state
						&& expected.hash === actual.hash;
				},
			}),
			(error) => {
				assert.ok(error instanceof PatchEngineError);
				assert.equal(error.code, "write_failed");
				assert.deepEqual(error.writeState?.applied.map((change) => change.path), ["first.txt"]);
				assert.deepEqual(error.writeState?.rolledBack.map((change) => change.path), ["first.txt"]);
				return true;
			},
		);
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
		const plan = await preflightPatch(wrap(`*** Update File: continuous.txt
@@
-before
+after`), { workspaceRoot: root, hashSource });

		let observing = true;
		let observedMissing = false;
		const observer = (async () => {
			while (observing) {
				try {
					await lstat(target);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT")
						observedMissing = true;
					else
						throw error;
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
