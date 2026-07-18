import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep, win32 } from "node:path";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class PatchManifestError extends Error {
	constructor(manifestPath, message) {
		super(`Pi patch manifest ${manifestPath}: ${message}`);
		this.name = "PatchManifestError";
	}
}

function fail(manifestPath, message) {
	throw new PatchManifestError(manifestPath, message);
}

function exactObject(manifestPath, value, keys, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(manifestPath, `${label} must be an object`);
	}
	const actualKeys = Object.keys(value).sort();
	const expectedKeys = [...keys].sort();
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
		fail(manifestPath, `${label} must contain exactly: ${expectedKeys.join(", ")}`);
	}
}

function relativePath(manifestPath, value, label) {
	if (typeof value !== "string" || value.length === 0) fail(manifestPath, `${label} must be a nonempty string`);
	if (
		isAbsolute(value) ||
		win32.isAbsolute(value) ||
		value.includes("\\") ||
		value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	) {
		fail(manifestPath, `${label} must be a contained relative path`);
	}
	return value;
}

function validateManifest(manifestPath, value) {
	exactObject(manifestPath, value, ["version", "targets"], "root");
	if (typeof value.version !== "string" || !VERSION.test(value.version)) {
		fail(manifestPath, "version must be an exact version string");
	}
	if (!Array.isArray(value.targets) || value.targets.length === 0) {
		fail(manifestPath, "targets must be a nonempty array");
	}

	const targetPaths = new Set();
	const targets = value.targets.map((target, index) => {
		const label = `targets[${index}]`;
		exactObject(manifestPath, target, ["targetRelative", "beforeSha256", "afterSha256", "patch"], label);
		const targetRelative = relativePath(manifestPath, target.targetRelative, `${label}.targetRelative`);
		const patch = relativePath(manifestPath, target.patch, `${label}.patch`);
		if (typeof target.beforeSha256 !== "string" || !SHA256.test(target.beforeSha256)) {
			fail(manifestPath, `${label}.beforeSha256 must be a lowercase SHA-256 hash`);
		}
		if (typeof target.afterSha256 !== "string" || !SHA256.test(target.afterSha256)) {
			fail(manifestPath, `${label}.afterSha256 must be a lowercase SHA-256 hash`);
		}
		if (target.beforeSha256 === target.afterSha256) {
			fail(manifestPath, `${label} must have different beforeSha256 and afterSha256`);
		}
		if (targetPaths.has(targetRelative)) fail(manifestPath, `targetRelative is duplicated: ${targetRelative}`);
		targetPaths.add(targetRelative);
		return { targetRelative, beforeSha256: target.beforeSha256, afterSha256: target.afterSha256, patch };
	});

	return { version: value.version, targets };
}

export async function loadPatchManifest(manifestPath) {
	let source;
	try {
		source = await readFile(manifestPath, "utf8");
	} catch (cause) {
		fail(manifestPath, `cannot read: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	try {
		return validateManifest(manifestPath, JSON.parse(source));
	} catch (cause) {
		if (cause instanceof PatchManifestError) throw cause;
		fail(manifestPath, `is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

export function patchAssetPath(manifestPath, patch) {
	const manifestDirectory = dirname(manifestPath);
	const assetPath = resolve(manifestDirectory, patch);
	if (assetPath !== manifestDirectory && !assetPath.startsWith(`${manifestDirectory}${sep}`)) {
		fail(manifestPath, `patch asset escapes manifest directory: ${patch}`);
	}
	return assetPath;
}

/** Installer-only validation: the compatibility checker only needs target hashes. */
export async function assertPatchAssets(manifestPath, manifest) {
	for (const target of manifest.targets) {
		const assetPath = patchAssetPath(manifestPath, target.patch);
		try {
			await access(assetPath);
		} catch (cause) {
			fail(manifestPath, `cannot access patch asset ${target.patch}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}
}
