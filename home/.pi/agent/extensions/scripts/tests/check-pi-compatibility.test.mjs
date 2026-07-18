import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkPiCompatibility, PI_PACKAGES } from "../check-pi-compatibility.mjs";

const VERSION = "0.80.10";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-compat-"));
	const extensionRoot = join(root, "home/.pi/agent/extensions");
	const patchPath = join(root, `apply-pi-ai-${VERSION}.mjs`);
	await mkdir(extensionRoot, { recursive: true });

	const dependencies = Object.fromEntries(PI_PACKAGES.map((name) => [name, VERSION]));
	await writeFile(join(extensionRoot, "package.json"), JSON.stringify({ dependencies }));
	await writeFile(join(extensionRoot, "package-lock.json"), JSON.stringify({ packages: { "": { dependencies } } }));
	for (const name of PI_PACKAGES) {
		const packageRoot = join(extensionRoot, "node_modules", name);
		await mkdir(packageRoot, { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version: VERSION }));
	}

	const target = join(extensionRoot, "node_modules/@earendil-works/pi-ai/dist/api/target.js");
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, "original");
	const crypto = await import("node:crypto");
	const before = crypto.createHash("sha256").update("original").digest("hex");
	const after = crypto.createHash("sha256").update("patched").digest("hex");
	await writeFile(
		patchPath,
		`const EXPECTED_VERSION = "${VERSION}";\nconst PATCHES = [{\n` +
			`targetRelative: "dist/api/target.js",\nbeforeSha256: "${before}",\nafterSha256: "${after}",\n}];\n`,
	);

	return {
		root,
		extensionRoot,
		patchPath,
		target,
		options: { extensionRoot, repoRoot: root, nativePatchPath: patchPath },
	};
}

test("accepts matching exact packages with an original or patched Pi tree", async (t) => {
	const files = await fixture();
	t.after(() => rm(files.root, { recursive: true, force: true }));

	assert.deepEqual(await checkPiCompatibility(files.options), {
		version: VERSION,
		treeState: "original",
		targetCount: 1,
	});
	await writeFile(files.target, "patched");
	assert.equal((await checkPiCompatibility(files.options)).treeState, "patched");
});

test("rejects ranges, version drift, unknown hashes, and a mismatched patch version", async (t) => {
	const files = await fixture();
	t.after(() => rm(files.root, { recursive: true, force: true }));

	const packagePath = join(files.extensionRoot, "package.json");
	const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
	packageJson.dependencies[PI_PACKAGES[0]] = `^${VERSION}`;
	await writeFile(packagePath, JSON.stringify(packageJson));
	await assert.rejects(checkPiCompatibility(files.options), /must use an exact version/);

	packageJson.dependencies[PI_PACKAGES[0]] = VERSION;
	await writeFile(packagePath, JSON.stringify(packageJson));
	const installedPath = join(files.extensionRoot, "node_modules", PI_PACKAGES[1], "package.json");
	await writeFile(installedPath, JSON.stringify({ name: PI_PACKAGES[1], version: "0.80.11" }));
	await assert.rejects(checkPiCompatibility(files.options), /expected 0\.80\.10/);

	await writeFile(installedPath, JSON.stringify({ name: PI_PACKAGES[1], version: VERSION }));
	await writeFile(files.target, "unknown");
	await assert.rejects(checkPiCompatibility(files.options), /expected original/);

	await writeFile(files.target, "original");
	const patch = await readFile(files.patchPath, "utf8");
	await writeFile(files.patchPath, patch.replace(`"${VERSION}"`, '"0.80.11"'));
	await assert.rejects(checkPiCompatibility(files.options), /native patch expects Pi 0\.80\.11/);
});
