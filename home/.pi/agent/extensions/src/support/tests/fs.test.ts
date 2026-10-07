import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runPromise } from "../effect-runtime.ts";
import { readDirectoryFileNames } from "../fs.ts";

test("directory file listing includes only regular files by default and opts into file symlinks", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-directory-file-names-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "entries");
	const directoryTarget = join(root, "directory-target");
	await mkdir(directory);
	await mkdir(directoryTarget);
	await writeFile(join(directory, "regular.txt"), "");
	await writeFile(join(root, "linked-target.txt"), "");
	await symlink(join(root, "linked-target.txt"), join(directory, "linked.txt"));
	await symlink(join(root, "missing.txt"), join(directory, "broken.txt"));
	await symlink(directoryTarget, join(directory, "directory-link"));

	const defaultNames = await runPromise(readDirectoryFileNames(directory));
	const namesIncludingFileSymlinks = await runPromise(
		readDirectoryFileNames(directory, { includeSymlinkedFiles: true }),
	);
	assert.deepEqual(defaultNames.toSorted(), ["regular.txt"]);
	assert.deepEqual(namesIncludingFileSymlinks.toSorted(), ["linked.txt", "regular.txt"]);
});
