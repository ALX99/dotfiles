#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPatchManifest } from "../../../../../misc/pi-patches/manifest.mjs";

export const PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

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

function exactVersion(value, packageName) {
	if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
		fail(`${packageName} must use an exact version, found ${JSON.stringify(value)}`);
	}
	return value;
}

function sha256(source) {
	return createHash("sha256").update(source).digest("hex");
}

export async function checkPiCompatibility(options = {}) {
	const extensionRoot = resolve(options.extensionRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
	const repoRoot = resolve(options.repoRoot ?? join(extensionRoot, "../../../.."));
	const packageJson = await readJson(join(extensionRoot, "package.json"), "extension package metadata");
	const packageLock = await readJson(join(extensionRoot, "package-lock.json"), "extension lockfile");

	const declaredVersions = PI_PACKAGES.map((name) =>
		exactVersion(packageJson.dependencies?.[name], `${name} dependency`),
	);
	const expectedVersion = declaredVersions[0];
	if (!declaredVersions.every((version) => version === expectedVersion)) {
		fail(`Pi dependencies must have one version, found ${declaredVersions.join(", ")}`);
	}

	const lockDependencies = packageLock.packages?.[""]?.dependencies;
	for (const name of PI_PACKAGES) {
		if (lockDependencies?.[name] !== expectedVersion) {
			fail(`lockfile root declares ${name} ${JSON.stringify(lockDependencies?.[name])}, expected ${expectedVersion}`);
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

	const piAiRoot = join(extensionRoot, "node_modules", "@earendil-works", "pi-ai");
	const treeStates = [];
	for (const target of nativePatch.targets) {
		const targetPath = join(piAiRoot, target.targetRelative);
		const targetSource = await readFile(targetPath);
		const actualHash = sha256(targetSource);
		if (actualHash === target.beforeSha256) treeStates.push("original");
		else if (actualHash === target.afterSha256) treeStates.push("patched");
		else {
			fail(
				`${targetPath} has SHA-256 ${actualHash}; expected original ${target.beforeSha256} or patched ${target.afterSha256}`,
			);
		}
	}
	if (!treeStates.every((state) => state === treeStates[0])) {
		fail(`installed pi-ai tree is partially patched (${treeStates.join(", ")})`);
	}

	return {
		version: expectedVersion,
		treeState: treeStates[0],
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
