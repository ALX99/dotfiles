#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { loadPatchManifest } from "../../../../../misc/pi-patches/manifest.mjs";

export const PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
const PI_AI = "@earendil-works/pi-ai";
const PATCH_PATH = "patches/pi-ai.patch";

function fail(message) {
	throw new Error(`Pi compatibility check failed: ${message}`);
}

async function readJson(path, label) {
	let source;
	try {
		source = await readFile(path, "utf8");
	} catch (cause) {
		fail(`cannot read ${label} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	try {
		return JSON.parse(source);
	} catch (cause) {
		fail(`${label} at ${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

async function readYaml(path, label) {
	let source;
	try {
		source = await readFile(path, "utf8");
	} catch (cause) {
		fail(`cannot read ${label} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	try {
		return parse(source);
	} catch (cause) {
		fail(`${label} at ${path} is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

function exactVersion(value, packageName) {
	if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
		fail(`${packageName} must use an exact version, found ${JSON.stringify(value)}`);
	}
	return value;
}

function sha256(source) {
	return createHash("sha256").update(source).digest("hex");
}

function importerEntry(lockfile, name) {
	const entry = lockfile.importers?.["."]?.dependencies?.[name];
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		fail(`lockfile importer declares invalid ${name} metadata`);
	}
	return entry;
}

export async function checkPiCompatibility(options = {}) {
	const extensionRoot = resolve(options.extensionRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
	const repoRoot = resolve(options.repoRoot ?? join(extensionRoot, "../../../.."));
	const packageJson = await readJson(join(extensionRoot, "package.json"), "extension package metadata");
	const workspace = await readYaml(join(extensionRoot, "pnpm-workspace.yaml"), "pnpm workspace configuration");
	const lockfile = await readYaml(join(extensionRoot, "pnpm-lock.yaml"), "pnpm lockfile");

	const declaredVersions = PI_PACKAGES.map((name) =>
		exactVersion(packageJson.dependencies?.[name], `${name} dependency`),
	);
	const expectedVersion = declaredVersions[0];
	if (!declaredVersions.every((version) => version === expectedVersion)) {
		fail(`Pi dependencies must have one version, found ${declaredVersions.join(", ")}`);
	}

	const patchKey = `${PI_AI}@${expectedVersion}`;
	if (workspace?.patchedDependencies?.[patchKey] !== PATCH_PATH) {
		fail(`pnpm workspace patchedDependencies must map ${patchKey} to ${PATCH_PATH}`);
	}
	const patchHash = lockfile?.patchedDependencies?.[patchKey];
	if (typeof patchHash !== "string" || !/^[a-f0-9]{64}$/.test(patchHash)) {
		fail(`pnpm lockfile patchedDependencies must record a SHA-256 for ${patchKey}`);
	}
	const patchSource = await readFile(join(extensionRoot, PATCH_PATH));
	const actualPatchHash = sha256(patchSource);
	if (actualPatchHash !== patchHash) {
		fail(`pnpm patch has SHA-256 ${actualPatchHash}, lockfile records ${patchHash}`);
	}

	for (const name of PI_PACKAGES) {
		const entry = importerEntry(lockfile, name);
		if (entry.specifier !== expectedVersion) {
			fail(
				`lockfile importer declares ${name} specifier ${JSON.stringify(entry.specifier)}, expected ${expectedVersion}`,
			);
		}
		const escapedVersion = expectedVersion.replaceAll(".", "\\.");
		const peerSuffix = String.raw`(?:\([^()]+\))*`;
		const expectedResolvedVersion = new RegExp(
			name === PI_AI
				? `^${escapedVersion}\\(patch_hash=${patchHash}\\)${peerSuffix}$`
				: `^${escapedVersion}${peerSuffix}$`,
		);
		if (typeof entry.version !== "string" || !expectedResolvedVersion.test(entry.version)) {
			fail(
				`lockfile importer resolves ${name} ${JSON.stringify(entry.version)}, expected ${name === PI_AI ? `a patched ${expectedVersion} version` : expectedVersion}`,
			);
		}
		const installedPackagePath = join(extensionRoot, "node_modules", name, "package.json");
		const installedPackage = await readJson(installedPackagePath, `${name} installed metadata`);
		if (installedPackage.name !== name || installedPackage.version !== expectedVersion) {
			fail(
				`${name} installed as ${installedPackage.name ?? "<unnamed>"} ${installedPackage.version ?? "<unknown>"}, expected ${expectedVersion}`,
			);
		}
	}

	const nativePatchManifestPath = resolve(
		options.nativePatchManifestPath ?? join(repoRoot, "misc/pi-patches", "pi-ai-patch-manifest.json"),
	);
	let nativePatch;
	try {
		nativePatch = await loadPatchManifest(nativePatchManifestPath);
	} catch (cause) {
		fail(cause instanceof Error ? cause.message : String(cause));
	}
	if (nativePatch.version !== expectedVersion) {
		fail(`native patch expects Pi ${nativePatch.version}, package dependencies expect ${expectedVersion}`);
	}
	if (nativePatch.patch !== "pi-ai.patch") {
		fail(`native patch must use the canonical pi-ai.patch asset, found ${nativePatch.patch}`);
	}

	const piAiRoot = join(extensionRoot, "node_modules", "@earendil-works", "pi-ai");
	for (const target of nativePatch.targets) {
		const targetPath = join(piAiRoot, target.targetRelative);
		const targetSource = await readFile(targetPath);
		const actualHash = sha256(targetSource);
		if (actualHash !== target.afterSha256) {
			fail(`${targetPath} has SHA-256 ${actualHash}; expected patched ${target.afterSha256}`);
		}
	}

	return {
		version: expectedVersion,
		treeState: "patched",
		targetCount: nativePatch.targets.length,
	};
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	checkPiCompatibility()
		.then(({ version, treeState, targetCount }) => {
			console.log(
				`Pi compatibility verified: ${version}, ${treeState} pi-ai tree, ${targetCount} native patch targets`,
			);
		})
		.catch((cause) => {
			console.error(cause instanceof Error ? cause.message : String(cause));
			process.exitCode = 1;
		});
}
