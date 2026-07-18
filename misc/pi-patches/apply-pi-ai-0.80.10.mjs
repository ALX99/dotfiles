#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { link, lstat, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPatchAssets, loadPatchManifest, patchAssetPath } from "./manifest.mjs";

const MANIFEST_PATH = fileURLToPath(new URL("./pi-ai-patch-manifest.json", import.meta.url));
const MANIFEST = await loadPatchManifest(MANIFEST_PATH);
await assertPatchAssets(MANIFEST_PATH, MANIFEST);
const EXPECTED_VERSION = MANIFEST.version;
const PATCHES = MANIFEST.targets.map((target) => ({
    ...target,
    patchPath: patchAssetPath(MANIFEST_PATH, target.patch),
}));

function fail(message) {
    throw new Error(message);
}

function parseArgs(argv) {
    let check = false;
    let piRoot;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--check") {
            check = true;
        }
        else if (arg === "--pi-root") {
            if (!argv[i + 1])
                fail("--pi-root requires a path");
            piRoot = resolve(argv[++i]);
        }
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: apply-pi-ai-0.80.10.mjs [--check] [--pi-root PATH]");
            process.exit(0);
        }
        else {
            fail(`Unknown argument: ${arg}`);
        }
    }
    return { check, piRoot };
}

function findPiRoot(explicitRoot) {
    if (explicitRoot)
        return explicitRoot;
    if (process.env.PI_CODING_AGENT_ROOT)
        return resolve(process.env.PI_CODING_AGENT_ROOT);
    let executable;
    try {
        executable = execFileSync("which", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        fail("Could not locate pi; pass --pi-root or set PI_CODING_AGENT_ROOT");
    }
    if (!executable)
        fail("Could not locate pi; pass --pi-root or set PI_CODING_AGENT_ROOT");
    const cliPath = realpathSync(executable);
    if (!cliPath.endsWith("/dist/cli.js"))
        fail(`Cannot infer the Pi package root from ${cliPath}; pass --pi-root`);
    return resolve(dirname(cliPath), "..");
}

async function readPackage(path, expectedName) {
    let pkg;
    try {
        pkg = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        fail(`Cannot read ${expectedName} package metadata at ${path}: ${error.message}`);
    }
    if (pkg.name !== expectedName)
        fail(`Expected ${expectedName} at ${path}, found ${pkg.name ?? "unnamed package"}`);
    if (pkg.version !== EXPECTED_VERSION)
        fail(`Expected ${expectedName} ${EXPECTED_VERSION}, found ${pkg.version ?? "unknown"}`);
    return pkg;
}

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

function sameDirectoryEntry(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

function isWithinRoot(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function captureParentGuard(root, targetPath) {
    const parentPath = dirname(targetPath);
    const before = await lstat(parentPath);
    if (before.isSymbolicLink() || !before.isDirectory())
        fail(`Patch target parent is not a real directory: ${parentPath}`);
    const canonical = await realpath(parentPath);
    const after = await lstat(parentPath);
    if (!sameDirectoryEntry(before, after) || canonical !== parentPath || !isWithinRoot(root, canonical))
        fail(`Patch target parent changed while validating: ${parentPath}`);
    return { path: parentPath, dev: after.dev, ino: after.ino };
}

async function assertParentGuard(root, guard) {
    const actual = await captureParentGuard(root, join(guard.path, "__guard__"));
    if (actual.path !== guard.path || actual.dev !== guard.dev || actual.ino !== guard.ino)
        fail(`Patch target parent changed after staging: ${guard.path}`);
}

async function verifyInstalledTarget(entry) {
    await assertParentGuard(entry.piAiRoot, entry.parentGuard);
    const before = await lstat(entry.targetPath);
    if (before.isSymbolicLink() || !before.isFile())
        fail(`Installed patch target is not a regular non-symlink file: ${entry.targetPath}`);
    const content = await readFile(entry.targetPath, "utf8");
    const after = await lstat(entry.targetPath);
    if (after.isSymbolicLink() || !after.isFile() || !sameDirectoryEntry(before, after))
        fail(`Installed patch target changed during verification: ${entry.targetPath}`);
    if (sha256(content) !== entry.afterSha256)
        fail(`Post-write verification failed for ${entry.targetPath}`);
    await assertParentGuard(entry.piAiRoot, entry.parentGuard);
}

function parseRange(value) {
    const [start, count] = value.split(",");
    return { start: Number(start), count: count === undefined ? 1 : Number(count) };
}

function applyUnifiedDiff(source, patch) {
    const sourceLines = source.split("\n");
    const patchLines = patch.split("\n");
    const result = [];
    let sourceIndex = 0;
    let patchIndex = patchLines.findIndex((line) => line.startsWith("@@ "));
    if (patchIndex < 0)
        fail("Patch asset contains no hunks");

    while (patchIndex < patchLines.length && patchLines[patchIndex].startsWith("@@ ")) {
        const match = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/.exec(patchLines[patchIndex]);
        if (!match)
            fail(`Invalid patch hunk header: ${patchLines[patchIndex]}`);
        const oldRange = parseRange(match[1]);
        const newRange = parseRange(match[2]);
        const hunkSourceStart = oldRange.start - 1;
        if (hunkSourceStart < sourceIndex)
            fail("Patch hunks overlap or are out of order");
        result.push(...sourceLines.slice(sourceIndex, hunkSourceStart));
        sourceIndex = hunkSourceStart;
        patchIndex++;

        let oldCount = 0;
        let newCount = 0;
        while (patchIndex < patchLines.length && !patchLines[patchIndex].startsWith("@@ ")) {
            const line = patchLines[patchIndex];
            if (line.startsWith("--- ") || line.startsWith("+++ "))
                fail("Patch asset must modify exactly one file");
            if (line === "\\ No newline at end of file") {
                patchIndex++;
                continue;
            }
            const marker = line[0];
            const text = line.slice(1);
            if (marker === " " || marker === "-") {
                if (sourceLines[sourceIndex] !== text)
                    fail(`Patch context mismatch at source line ${sourceIndex + 1}`);
                sourceIndex++;
                oldCount++;
            }
            if (marker === " " || marker === "+") {
                result.push(text);
                newCount++;
            }
            if (marker !== " " && marker !== "-" && marker !== "+") {
                if (line === "" && patchIndex === patchLines.length - 1)
                    break;
                fail(`Invalid patch line: ${line}`);
            }
            patchIndex++;
        }
        if (oldCount !== oldRange.count || newCount !== newRange.count)
            fail(`Patch hunk count mismatch (expected -${oldRange.count}/+${newRange.count}, got -${oldCount}/+${newCount})`);
    }
    result.push(...sourceLines.slice(sourceIndex));
    return result.join("\n");
}

export async function runInstaller(argv, hooks = {}) {
    const { check, piRoot: explicitRoot } = parseArgs(argv);
    const piRoot = await realpath(findPiRoot(explicitRoot));
    const piAiRoot = join(piRoot, "node_modules/@earendil-works/pi-ai");
    await readPackage(join(piRoot, "package.json"), "@earendil-works/pi-coding-agent");
    await readPackage(join(piAiRoot, "package.json"), "@earendil-works/pi-ai");

    // Validate both targets and generate every replacement before changing
    // either file. lstat intentionally runs even for an already-patched hash.
    const prepared = [];
    for (const spec of PATCHES) {
        const targetPath = join(piAiRoot, spec.targetRelative);
        const parentGuard = await captureParentGuard(piAiRoot, targetPath);
        let targetStat;
        try {
            targetStat = await lstat(targetPath);
        }
        catch (error) {
            fail(`Cannot inspect patch target ${targetPath}: ${error.message}`);
        }
        if (targetStat.isSymbolicLink())
            fail(`Refusing symlink patch target: ${targetPath}`);
        if (!targetStat.isFile())
            fail(`Patch target is not a regular file: ${targetPath}`);

        let source;
        try {
            source = await readFile(targetPath, "utf8");
        }
        catch (error) {
            fail(`Cannot read patch target ${targetPath}: ${error.message}`);
        }
        const targetAfterRead = await lstat(targetPath);
        if (targetAfterRead.isSymbolicLink() || !targetAfterRead.isFile() || !sameDirectoryEntry(targetStat, targetAfterRead))
            fail(`Patch target changed while reading: ${targetPath}`);
        await assertParentGuard(piAiRoot, parentGuard);
        const currentHash = sha256(source);
        const alreadyPatched = currentHash === spec.afterSha256;
        if (!alreadyPatched && currentHash !== spec.beforeSha256) {
            fail(`Refusing to modify ${targetPath}: expected pre-patch SHA-256 ${spec.beforeSha256} or post-patch SHA-256 ${spec.afterSha256}, found ${currentHash}`);
        }
        let patched = source;
        if (!alreadyPatched) {
            const patch = await readFile(spec.patchPath, "utf8");
            patched = applyUnifiedDiff(source, patch);
            const patchedHash = sha256(patched);
            if (patchedHash !== spec.afterSha256)
                fail(`Patch asset produced unexpected SHA-256 ${patchedHash}; targets were not modified`);
        }
        prepared.push({
            ...spec,
            targetPath,
            targetStat,
            parentGuard,
            piAiRoot,
            currentHash,
            patched,
            alreadyPatched,
        });
    }

    const pending = prepared.filter((entry) => !entry.alreadyPatched);
    if (check && pending.length > 0)
        fail(`Patch is not applied: ${pending.map((entry) => entry.targetPath).join(", ")}`);
    if (check || pending.length === 0) {
        for (const entry of prepared)
            console.log(`verified: ${entry.targetPath} is patched for Pi ${EXPECTED_VERSION}`);
        return;
    }

    // Stage and fsync all replacements before the first target replacement.
    try {
        for (const entry of pending) {
            await assertParentGuard(piAiRoot, entry.parentGuard);
            entry.temporaryPath = join(
                dirname(entry.targetPath),
                `.${entry.targetRelative.split("/").at(-1)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
            );
            const permissions = entry.targetStat.mode & 0o777;
            const handle = await open(entry.temporaryPath, "wx", permissions);
            try {
                await handle.writeFile(entry.patched, "utf8");
                await handle.chmod(permissions);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await assertParentGuard(piAiRoot, entry.parentGuard);
        }
    }
    catch (error) {
        for (const entry of pending) {
            if (entry.temporaryPath)
                await rm(entry.temporaryPath, { force: true }).catch(() => {});
        }
        fail(`Could not stage transactional replacements; targets were not modified: ${error.message}`);
    }

    const exists = async (filePath) => {
        try {
            await lstat(filePath);
            return true;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return false;
            throw error;
        }
    };

    // Revalidate versions, links, and both exact file images immediately before
    // entering the two-file commit window.
    try {
        await readPackage(join(piRoot, "package.json"), "@earendil-works/pi-coding-agent");
        await readPackage(join(piAiRoot, "package.json"), "@earendil-works/pi-ai");
        for (const entry of prepared) {
            await assertParentGuard(piAiRoot, entry.parentGuard);
            const currentStat = await lstat(entry.targetPath);
            if (currentStat.isSymbolicLink())
                fail(`Refusing symlink patch target: ${entry.targetPath}`);
            if (!currentStat.isFile())
                fail(`Patch target is not a regular file: ${entry.targetPath}`);
            if (!sameDirectoryEntry(entry.targetStat, currentStat))
                fail(`Patch target identity changed: ${entry.targetPath}`);
            const currentContent = await readFile(entry.targetPath, "utf8");
            const afterReadStat = await lstat(entry.targetPath);
            if (!sameDirectoryEntry(currentStat, afterReadStat) || afterReadStat.isSymbolicLink())
                fail(`Patch target changed while revalidating: ${entry.targetPath}`);
            if (sha256(currentContent) !== entry.currentHash)
                fail(`Refusing concurrently modified target: ${entry.targetPath}`);
            await assertParentGuard(piAiRoot, entry.parentGuard);
        }
    }
    catch (error) {
        for (const entry of pending) {
            if (entry.temporaryPath)
                await rm(entry.temporaryPath, { force: true }).catch(() => {});
        }
        throw error;
    }

    const rollbackFailures = [];
    try {
        for (let index = 0; index < pending.length; index++) {
            const entry = pending[index];
            await hooks.beforeCommit?.({ index, targetPath: entry.targetPath });
            const backupPath = join(
                dirname(entry.targetPath),
                `.${entry.targetRelative.split("/").at(-1)}.${process.pid}.${randomBytes(8).toString("hex")}.rollback`,
            );
            await assertParentGuard(piAiRoot, entry.parentGuard);
            await link(entry.targetPath, backupPath);
            entry.backupPath = backupPath;
            const backupStat = await lstat(backupPath);
            if (backupStat.isSymbolicLink() || !backupStat.isFile())
                fail(`Target changed type during transactional commit: ${entry.targetPath}`);
            const sourceStat = await lstat(entry.targetPath);
            if (!sameDirectoryEntry(sourceStat, backupStat))
                fail(`Backup is not linked to the patch target: ${entry.targetPath}`);
            if (sha256(await readFile(backupPath, "utf8")) !== entry.currentHash)
                fail(`Target changed during transactional commit: ${entry.targetPath}`);
            await hooks.afterBackup?.({ index, targetPath: entry.targetPath });
            await assertParentGuard(piAiRoot, entry.parentGuard);
            await rename(entry.temporaryPath, entry.targetPath);
            entry.installed = true;
            entry.temporaryPath = undefined;
            await assertParentGuard(piAiRoot, entry.parentGuard);
        }
        for (const entry of prepared)
            await verifyInstalledTarget(entry);
    }
    catch (cause) {
        for (const entry of pending.toReversed()) {
            if (entry.installed) {
                try {
                    if (!entry.backupPath || !await exists(entry.backupPath))
                        throw new Error("original backup is unavailable");
                    await hooks.beforeRollbackRestore?.({ targetPath: entry.targetPath });
                    await assertParentGuard(piAiRoot, entry.parentGuard);
                    if (await exists(entry.targetPath)) {
                        const targetStat = await lstat(entry.targetPath);
                        if (targetStat.isFile()) {
                            if (sha256(await readFile(entry.targetPath, "utf8")) !== entry.afterSha256)
                                throw new Error("installed target changed; refusing to replace it");
                        }
                        else if (!targetStat.isSymbolicLink()) {
                            throw new Error("installed target changed type; refusing to replace it");
                        }
                    }
                    await rename(entry.backupPath, entry.targetPath);
                    entry.backupPath = undefined;
                    entry.installed = false;
                }
                catch (error) {
                    rollbackFailures.push(`atomically restore ${entry.targetPath}: ${error.message}`);
                }
            }
            else if (entry.backupPath && await exists(entry.backupPath)) {
                try {
                    await assertParentGuard(piAiRoot, entry.parentGuard);
                    const targetStat = await lstat(entry.targetPath);
                    const backupStat = await lstat(entry.backupPath);
                    if (!sameDirectoryEntry(targetStat, backupStat))
                        throw new Error("target no longer matches its backup hardlink");
                    await unlink(entry.backupPath);
                    entry.backupPath = undefined;
                }
                catch (error) {
                    rollbackFailures.push(`remove unused backup ${entry.backupPath}: ${error.message}`);
                }
            }
            if (entry.temporaryPath)
                await rm(entry.temporaryPath, { force: true }).catch((error) => {
                    rollbackFailures.push(`remove ${entry.temporaryPath}: ${error.message}`);
                });
        }
        const artifacts = pending
            .flatMap((entry) => [entry.backupPath, entry.temporaryPath])
            .filter(Boolean)
            .filter((filePath) => {
                try {
                    return realpathSync(filePath).length > 0;
                }
                catch {
                    return false;
                }
            });
        const rollbackState = rollbackFailures.length === 0
            ? "transaction rolled back"
            : `rollback incomplete (${rollbackFailures.join("; ")}); recovery artifacts: ${artifacts.join(", ") || "none"}`;
        fail(`Transactional patch commit failed: ${cause.message}; ${rollbackState}`);
    }

    const retainedBackups = [];
    for (const entry of pending) {
        try {
            await unlink(entry.backupPath);
            entry.backupPath = undefined;
        }
        catch {
            retainedBackups.push(entry.backupPath);
        }
    }
    for (const entry of prepared) {
        const action = entry.alreadyPatched ? "verified" : "applied and verified";
        console.log(`${action}: ${entry.targetPath} for Pi ${EXPECTED_VERSION}`);
    }
    if (retainedBackups.length > 0)
        fail(`Patch installed, but rollback backup cleanup failed: ${retainedBackups.join(", ")}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
    runInstaller(process.argv.slice(2)).catch((error) => {
        console.error(`pi-ai patch error: ${error.message}`);
        process.exitCode = 1;
    });
}
