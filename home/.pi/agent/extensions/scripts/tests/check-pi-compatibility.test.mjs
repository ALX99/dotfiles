import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkPiCompatibility, PI_PACKAGES } from "../check-pi-compatibility.mjs";

const VERSION = "0.81.1";
const PATCH_SOURCE = "fixture patch\n";
const PATCH_HASH = createHash("sha256").update(PATCH_SOURCE).digest("hex");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-compat-"));
	const extensionRoot = join(root, "home/.pi/agent/extensions");
	const manifestPath = join(root, "pi-ai-patch-manifest.json");
	await mkdir(extensionRoot, { recursive: true });

	const dependencies = Object.fromEntries(PI_PACKAGES.map((name) => [name, VERSION]));
	await writeFile(join(extensionRoot, "package.json"), JSON.stringify({ dependencies }));
	await mkdir(join(extensionRoot, "patches"));
	await writeFile(join(extensionRoot, "patches/pi-ai.patch"), PATCH_SOURCE);
	const patchKey = `@earendil-works/pi-ai@${VERSION}`;
	await writeFile(
		join(extensionRoot, "pnpm-workspace.yaml"),
		`patchedDependencies:\n  "${patchKey}": patches/pi-ai.patch\n`,
	);
	await writeFile(
		join(extensionRoot, "pnpm-lock.yaml"),
		[
			"importers:",
			"  .:",
			"    dependencies:",
			...PI_PACKAGES.flatMap((name) => [
				`      "${name}":`,
				`        specifier: ${VERSION}`,
				`        version: ${
					name === "@earendil-works/pi-ai"
						? `${VERSION}(patch_hash=${PATCH_HASH})(ws@8.21.0)(zod@4.4.3)`
						: name === "@earendil-works/pi-coding-agent"
							? `${VERSION}(ws@8.21.0)(zod@4.4.3)`
							: VERSION
				}`,
			]),
			"patchedDependencies:",
			`  "${patchKey}": ${PATCH_HASH}`,
			"",
		].join("\n"),
	);
	for (const name of PI_PACKAGES) {
		const packageRoot = join(extensionRoot, "node_modules", name);
		await mkdir(packageRoot, { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version: VERSION }));
	}

	const target = join(extensionRoot, "node_modules/@earendil-works/pi-ai/dist/api/target.js");
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, "original");
	const before = createHash("sha256").update("original").digest("hex");
	const after = createHash("sha256").update("patched").digest("hex");
	await writeFile(
		manifestPath,
		JSON.stringify({
			version: VERSION,
			patch: "pi-ai.patch",
			targets: [{ targetRelative: "dist/api/target.js", beforeSha256: before, afterSha256: after }],
		}),
	);

	return {
		root,
		extensionRoot,
		manifestPath,
		target,
		options: { extensionRoot, repoRoot: root, nativePatchManifestPath: manifestPath },
	};
}

test("accepts matching exact packages with a pnpm-patched Pi tree", async (t) => {
	const files = await fixture();
	t.after(() => rm(files.root, { recursive: true, force: true }));

	await writeFile(files.target, "patched");
	assert.deepEqual(await checkPiCompatibility(files.options), {
		version: VERSION,
		treeState: "patched",
		targetCount: 1,
	});
});

test("rejects ranges, package drift, unpatched trees, and a mismatched patch version", async (t) => {
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
	await assert.rejects(checkPiCompatibility(files.options), /expected 0\.81\.1/);

	await writeFile(installedPath, JSON.stringify({ name: PI_PACKAGES[1], version: VERSION }));
	await assert.rejects(checkPiCompatibility(files.options), /expected patched/);

	await writeFile(files.target, "patched");
	const manifest = JSON.parse(await readFile(files.manifestPath, "utf8"));
	manifest.version = "0.81.2";
	await writeFile(files.manifestPath, JSON.stringify(manifest));
	await assert.rejects(checkPiCompatibility(files.options), /native patch expects Pi 0\.81\.2/);
});

test("rejects pnpm workspace and lockfile drift", async (t) => {
	const files = await fixture();
	t.after(() => rm(files.root, { recursive: true, force: true }));
	await writeFile(files.target, "patched");

	const workspacePath = join(files.extensionRoot, "pnpm-workspace.yaml");
	await writeFile(workspacePath, `patchedDependencies:\n  "@earendil-works/pi-ai@${VERSION}": patches/wrong.patch\n`);
	await assert.rejects(
		checkPiCompatibility(files.options),
		/must map @earendil-works\/pi-ai@0\.81\.1 to patches\/pi-ai\.patch/,
	);

	await writeFile(workspacePath, `patchedDependencies:\n  "@earendil-works/pi-ai@${VERSION}": patches/pi-ai.patch\n`);
	const patchPath = join(files.extensionRoot, "patches/pi-ai.patch");
	await writeFile(patchPath, "changed patch\n");
	await assert.rejects(checkPiCompatibility(files.options), /pnpm patch has SHA-256/);
	await writeFile(patchPath, PATCH_SOURCE);

	const lockPath = join(files.extensionRoot, "pnpm-lock.yaml");
	const lock = await readFile(lockPath, "utf8");
	await writeFile(lockPath, lock.replace("specifier: 0.81.1", "specifier: ^0.81.1"));
	await assert.rejects(checkPiCompatibility(files.options), /specifier "\^0\.81\.1"/);

	await writeFile(
		lockPath,
		lock.replace(`version: 0.81.1(patch_hash=${PATCH_HASH})(ws@8.21.0)(zod@4.4.3)`, "version: 0.81.1"),
	);
	await assert.rejects(checkPiCompatibility(files.options), /expected a patched 0\.81\.1 version/);

	await writeFile(lockPath, lock.replaceAll(PATCH_HASH, "not-a-hash"));
	await assert.rejects(checkPiCompatibility(files.options), /must record a SHA-256/);
});

test("rejects malformed native patch manifests before inspecting Pi targets", async (t) => {
	const files = await fixture();
	t.after(() => rm(files.root, { recursive: true, force: true }));

	const manifest = JSON.parse(await readFile(files.manifestPath, "utf8"));
	delete manifest.patch;
	await writeFile(files.manifestPath, JSON.stringify(manifest));

	await assert.rejects(checkPiCompatibility(files.options), /Pi patch manifest .*root must contain exactly/);
});
