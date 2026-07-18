import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runInstaller } from "../apply-pi-ai-0.80.10.mjs";
import { assertPatchAssets, loadPatchManifest } from "../manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../apply-pi-ai-0.80.10.mjs");
const manifest = await loadPatchManifest(resolve(HERE, "../pi-ai-patch-manifest.json"));
const VERSION = manifest.version;
const [sharedTarget, codexTarget] = manifest.targets;
assert.ok(sharedTarget && codexTarget, "patch manifest must define both targets");
const PATCH = resolve(HERE, `../${sharedTarget.patch}`);
const CODEX_PATCH = resolve(HERE, `../${codexTarget.patch}`);
const TARGET_RELATIVE = sharedTarget.targetRelative;
const CODEX_TARGET_RELATIVE = codexTarget.targetRelative;
const BEFORE_SHA256 = sharedTarget.beforeSha256;
const AFTER_SHA256 = sharedTarget.afterSha256;
const CODEX_BEFORE_SHA256 = codexTarget.beforeSha256;
const CODEX_AFTER_SHA256 = codexTarget.afterSha256;

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

function installedPiRoot() {
    const executable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    return resolve(dirname(realpathSync(executable)), "..");
}

function reverseUnifiedDiff(source, patch) {
    const reversed = patch
        .split("\n")
        .map((line) => {
            if (line.startsWith("--- "))
                return "+++ b/dist/api/openai-responses-shared.js";
            if (line.startsWith("+++ "))
                return "--- a/dist/api/openai-responses-shared.js";
            if (line.startsWith("@@ ")) {
                return line.replace(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/, "@@ -$2 +$1 @@");
            }
            if (line.startsWith("+"))
                return `-${line.slice(1)}`;
            if (line.startsWith("-"))
                return `+${line.slice(1)}`;
            return line;
        })
        .join("\n");

    const sourceLines = source.split("\n");
    const patchLines = reversed.split("\n");
    const output = [];
    let sourceIndex = 0;
    for (let i = patchLines.findIndex((line) => line.startsWith("@@ ")); i >= 0 && i < patchLines.length;) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patchLines[i]);
        assert.ok(match);
        const start = Number(match[1]) - 1;
        output.push(...sourceLines.slice(sourceIndex, start));
        sourceIndex = start;
        i++;
        while (i < patchLines.length && !patchLines[i].startsWith("@@ ")) {
            const marker = patchLines[i][0];
            const text = patchLines[i].slice(1);
            if (marker === " " || marker === "-") {
                assert.equal(sourceLines[sourceIndex], text);
                sourceIndex++;
            }
            if (marker === " " || marker === "+")
                output.push(text);
            if (patchLines[i] === "" && i === patchLines.length - 1) {
                i++;
                break;
            }
            i++;
        }
    }
    output.push(...sourceLines.slice(sourceIndex));
    return output.join("\n");
}

async function makeFixture(t) {
    const installedRoot = installedPiRoot();
    const installedPiAi = join(installedRoot, "node_modules/@earendil-works/pi-ai");
    const root = await mkdtemp(join(tmpdir(), "pi-ai-patch-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(installedRoot, "package.json"), join(root, "package.json"));
    const fixturePiAi = join(root, "node_modules/@earendil-works/pi-ai");
    await cp(installedPiAi, fixturePiAi, { recursive: true });
    await cp(join(installedRoot, "node_modules/partial-json"), join(root, "node_modules/partial-json"), { recursive: true });

    const target = join(fixturePiAi, TARGET_RELATIVE);
    const codexTarget = join(fixturePiAi, CODEX_TARGET_RELATIVE);
    const installed = await readFile(target, "utf8");
    const installedHash = sha256(installed);
    if (installedHash === AFTER_SHA256) {
        const before = reverseUnifiedDiff(installed, await readFile(PATCH, "utf8"));
        assert.equal(sha256(before), BEFORE_SHA256);
        await writeFile(target, before);
    }
    else {
        assert.equal(installedHash, BEFORE_SHA256, "installed Pi 0.80.10 codec must match a pinned pre/post image");
    }
    const installedCodex = await readFile(codexTarget, "utf8");
    const installedCodexHash = sha256(installedCodex);
    if (installedCodexHash === CODEX_AFTER_SHA256) {
        const beforeCodex = reverseUnifiedDiff(installedCodex, await readFile(CODEX_PATCH, "utf8"));
        assert.equal(sha256(beforeCodex), CODEX_BEFORE_SHA256);
        await writeFile(codexTarget, beforeCodex);
    }
    else {
        assert.equal(installedCodexHash, CODEX_BEFORE_SHA256, "installed Codex codec must match a pinned pre/post image");
    }
    return { root, target, codexTarget, fixturePiAi };
}

function runScript(root, ...args) {
    return spawnSync(process.execPath, [SCRIPT, "--pi-root", root, ...args], { encoding: "utf8" });
}

test("patch manifest parser rejects malformed metadata and installer assets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-patch-manifest-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manifestPath = join(root, "manifest.json");
    const valid = {
        version: "0.80.10",
        targets: [{
            targetRelative: "dist/api/target.js",
            beforeSha256: "a".repeat(64),
            afterSha256: "b".repeat(64),
            patch: "target.patch",
        }],
    };
    const cases = [
        ["requires exact root keys", (value) => { value.extra = true; }, /root must contain exactly/],
        ["requires an exact version", (value) => { value.version = "^0.80.10"; }, /version must be an exact version string/],
        ["requires targets", (value) => { value.targets = []; }, /targets must be a nonempty array/],
        ["requires exact target keys", (value) => { delete value.targets[0].patch; }, /targets\[0\] must contain exactly/],
        ["rejects duplicate targets", (value) => { value.targets.push(structuredClone(value.targets[0])); }, /targetRelative is duplicated/],
        ["rejects escaping target paths", (value) => { value.targets[0].targetRelative = "../target.js"; }, /targetRelative must be a contained relative path/],
        ["rejects invalid hashes", (value) => { value.targets[0].beforeSha256 = "A".repeat(64); }, /beforeSha256 must be a lowercase SHA-256 hash/],
        ["rejects identical hashes", (value) => { value.targets[0].afterSha256 = value.targets[0].beforeSha256; }, /must have different beforeSha256 and afterSha256/],
        ["rejects escaping patch paths", (value) => { value.targets[0].patch = "/target.patch"; }, /patch must be a contained relative path/],
    ];

    for (const [description, mutate, expected] of cases) {
        const candidate = structuredClone(valid);
        mutate(candidate);
        await writeFile(manifestPath, JSON.stringify(candidate));
        await assert.rejects(loadPatchManifest(manifestPath), expected, description);
    }

    await writeFile(manifestPath, JSON.stringify(valid));
    const parsed = await loadPatchManifest(manifestPath);
    await assert.rejects(assertPatchAssets(manifestPath, parsed), /cannot access patch asset target\.patch/);
    await writeFile(join(root, "target.patch"), "patch");
    await assert.doesNotReject(assertPatchAssets(manifestPath, parsed));
});

test("installer is strict, atomic, and idempotent on a temporary package copy", async (t) => {
    const { root, target, codexTarget } = await makeFixture(t);

    const beforeCheck = runScript(root, "--check");
    assert.equal(beforeCheck.status, 1);
    assert.match(beforeCheck.stderr, /Patch is not applied/);
    assert.equal(sha256(await readFile(target, "utf8")), BEFORE_SHA256);
    assert.equal(sha256(await readFile(codexTarget, "utf8")), CODEX_BEFORE_SHA256);

    const apply = runScript(root);
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(sha256(await readFile(target, "utf8")), AFTER_SHA256);
    assert.equal(sha256(await readFile(codexTarget, "utf8")), CODEX_AFTER_SHA256);

    const secondApply = runScript(root);
    assert.equal(secondApply.status, 0, secondApply.stderr);
    assert.match(secondApply.stdout, /verified/);
    assert.equal(sha256(await readFile(target, "utf8")), AFTER_SHA256);
    assert.equal(sha256(await readFile(codexTarget, "utf8")), CODEX_AFTER_SHA256);

    const afterCheck = runScript(root, "--check");
    assert.equal(afterCheck.status, 0, afterCheck.stderr);
});

test("installer refuses version and content mismatches without modifying the target", async (t) => {
    const versionFixture = await makeFixture(t);
    const piPackagePath = join(versionFixture.root, "package.json");
    const piPackage = JSON.parse(await readFile(piPackagePath, "utf8"));
    piPackage.version = "0.80.11";
    await writeFile(piPackagePath, `${JSON.stringify(piPackage)}\n`);
    const versionBefore = await readFile(versionFixture.target, "utf8");
    const versionResult = runScript(versionFixture.root);
    assert.equal(versionResult.status, 1);
    assert.match(versionResult.stderr, new RegExp(`Expected @earendil-works/pi-coding-agent ${VERSION}`));
    assert.equal(await readFile(versionFixture.target, "utf8"), versionBefore);

    const piAiVersionFixture = await makeFixture(t);
    const piAiPackagePath = join(piAiVersionFixture.fixturePiAi, "package.json");
    const piAiPackage = JSON.parse(await readFile(piAiPackagePath, "utf8"));
    piAiPackage.version = "0.80.9";
    await writeFile(piAiPackagePath, `${JSON.stringify(piAiPackage)}\n`);
    const piAiVersionBefore = await readFile(piAiVersionFixture.target, "utf8");
    const piAiVersionResult = runScript(piAiVersionFixture.root);
    assert.equal(piAiVersionResult.status, 1);
    assert.match(piAiVersionResult.stderr, new RegExp(`Expected @earendil-works/pi-ai ${VERSION}`));
    assert.equal(await readFile(piAiVersionFixture.target, "utf8"), piAiVersionBefore);

    const contentFixture = await makeFixture(t);
    await writeFile(contentFixture.target, `${await readFile(contentFixture.target, "utf8")}// mismatch\n`);
    const mismatchBefore = await readFile(contentFixture.target, "utf8");
    const mismatchResult = runScript(contentFixture.root);
    assert.equal(mismatchResult.status, 1);
    assert.match(mismatchResult.stderr, /Refusing to modify/);
    assert.equal(await readFile(contentFixture.target, "utf8"), mismatchBefore);
});

test("installer preflights both files before committing either replacement", async (t) => {
    const fixture = await makeFixture(t);
    const sharedBefore = await readFile(fixture.target, "utf8");
    await writeFile(fixture.codexTarget, `${await readFile(fixture.codexTarget, "utf8")}// mismatch\n`);
    const codexBefore = await readFile(fixture.codexTarget, "utf8");

    const result = runScript(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to modify/);
    assert.equal(await readFile(fixture.target, "utf8"), sharedBefore);
    assert.equal(await readFile(fixture.codexTarget, "utf8"), codexBefore);
    assert.equal(sha256(sharedBefore), BEFORE_SHA256);
});

test("installer keeps each target present while preparing its replacement", async (t) => {
    const fixture = await makeFixture(t);
    const expectedBefore = new Map([
        [realpathSync(fixture.target), BEFORE_SHA256],
        [realpathSync(fixture.codexTarget), CODEX_BEFORE_SHA256],
    ]);
    let backupChecks = 0;

    await runInstaller(["--pi-root", fixture.root], {
        async afterBackup({ targetPath }) {
            backupChecks++;
            const targetStat = await lstat(targetPath);
            assert.equal(targetStat.isFile(), true);
            assert.equal(targetStat.isSymbolicLink(), false);
            assert.equal(sha256(await readFile(targetPath, "utf8")), expectedBefore.get(targetPath));
        },
    });
    assert.equal(backupChecks, 2);
});

test("installer rolls the first file back when the second commit fails", async (t) => {
    const fixture = await makeFixture(t);
    const sharedBefore = await readFile(fixture.target, "utf8");
    const codexBefore = await readFile(fixture.codexTarget, "utf8");
    let rollbackRestoreChecks = 0;

    await assert.rejects(
        runInstaller(["--pi-root", fixture.root], {
            beforeCommit({ index }) {
                if (index === 1)
                    throw new Error("injected second-file commit failure");
            },
            async beforeRollbackRestore({ targetPath }) {
                rollbackRestoreChecks++;
                const targetStat = await lstat(targetPath);
                assert.equal(targetStat.isFile(), true);
            },
        }),
        /transaction rolled back/,
    );
    assert.equal(await readFile(fixture.target, "utf8"), sharedBefore);
    assert.equal(await readFile(fixture.codexTarget, "utf8"), codexBefore);
    assert.equal(sha256(sharedBefore), BEFORE_SHA256);
    assert.equal(sha256(codexBefore), CODEX_BEFORE_SHA256);
    assert.equal(rollbackRestoreChecks, 1);
});

test("installer rolls back a target replaced by a symlink during commit", async (t) => {
    const fixture = await makeFixture(t);
    const sharedBefore = await readFile(fixture.target, "utf8");
    const codexBefore = await readFile(fixture.codexTarget, "utf8");
    const injectedTarget = `${fixture.target}.injected`;

    await assert.rejects(
        runInstaller(["--pi-root", fixture.root], {
            async beforeCommit({ index }) {
                if (index !== 1)
                    return;
                await cp(fixture.target, injectedTarget);
                await rm(fixture.target);
                await symlink(injectedTarget, fixture.target);
            },
        }),
        /transaction rolled back/,
    );
    assert.equal((await lstat(fixture.target)).isSymbolicLink(), false);
    assert.equal(await readFile(fixture.target, "utf8"), sharedBefore);
    assert.equal(await readFile(fixture.codexTarget, "utf8"), codexBefore);
});

test("installer rejects symlink targets even when their content is already patched", async (t) => {
    const fixture = await makeFixture(t);
    const apply = runScript(fixture.root);
    assert.equal(apply.status, 0, apply.stderr);

    const realTarget = `${fixture.target}.real`;
    await cp(fixture.target, realTarget);
    await rm(fixture.target);
    await symlink(realTarget, fixture.target);

    for (const args of [[], ["--check"]]) {
        const result = runScript(fixture.root, ...args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Refusing symlink patch target/);
        assert.equal(sha256(await readFile(realTarget, "utf8")), AFTER_SHA256);
    }
});

test("patched codec scopes raw apply_patch conversion to the Codex caller", async (t) => {
    const { root, fixturePiAi } = await makeFixture(t);
    const apply = runScript(root);
    assert.equal(apply.status, 0, apply.stderr);

    const codec = await import(`${pathToFileURL(join(fixturePiAi, TARGET_RELATIVE)).href}?test=${Date.now()}`);
    const parameters = { type: "object", properties: { command: { type: "string" } } };
    const patchParameters = { type: "object", properties: { patch: { type: "string" } } };
    const tools = [
        { name: "apply_patch", description: "Apply a patch", parameters: patchParameters },
        { name: "bash", description: "Run a command", parameters },
    ];
    assert.deepEqual(codec.convertResponsesTools(tools, { strict: true }), [
        { type: "function", name: "apply_patch", description: "Apply a patch", parameters: patchParameters, strict: true },
        { type: "function", name: "bash", description: "Run a command", parameters, strict: true },
    ]);
    const customToolNames = new Set(["apply_patch"]);
    assert.deepEqual(codec.convertResponsesTools(tools, { strict: true, customToolNames }), [
        { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } },
        { type: "function", name: "bash", description: "Run a command", parameters, strict: true },
    ]);

    const model = {
        id: "gpt-test",
        provider: "openai",
        api: "openai-responses",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const patchText = "*** Begin Patch\n+\"quoted\\\\path\"\n*** End Patch";
    const context = {
        messages: [
            {
                role: "assistant",
                provider: model.provider,
                api: model.api,
                model: model.id,
                stopReason: "toolUse",
                content: [
                    { type: "toolCall", id: "call_patch|ctc_1", name: "apply_patch", arguments: { patch: patchText } },
                    { type: "toolCall", id: "call_bash|fc_1", name: "bash", arguments: { command: "true" } },
                ],
            },
            { role: "toolResult", toolCallId: "call_patch|ctc_1", toolName: "apply_patch", content: [{ type: "text", text: "Done" }] },
            { role: "toolResult", toolCallId: "call_bash|fc_1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
        ],
    };
    const regularReplay = codec.convertResponsesMessages(model, context, new Set([model.provider]));
    assert.deepEqual(regularReplay, [
        { type: "function_call", id: "ctc_1", call_id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ patch: patchText }) },
        { type: "function_call", id: "fc_1", call_id: "call_bash", name: "bash", arguments: "{\"command\":\"true\"}" },
        { type: "function_call_output", call_id: "call_patch", output: "Done" },
        { type: "function_call_output", call_id: "call_bash", output: "ok" },
    ]);
    const codexReplay = codec.convertResponsesMessages(
        model,
        context,
        new Set([model.provider]),
        { customToolNames },
    );
    assert.deepEqual(codexReplay, [
        { type: "custom_tool_call", id: "ctc_1", call_id: "call_patch", name: "apply_patch", input: patchText },
        { type: "function_call", id: "fc_1", call_id: "call_bash", name: "bash", arguments: "{\"command\":\"true\"}" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "Done" },
        { type: "function_call_output", call_id: "call_bash", output: "ok" },
    ]);

    const codexSource = await readFile(join(fixturePiAi, CODEX_TARGET_RELATIVE), "utf8");
    assert.match(codexSource, /parallel_tool_calls: false/);
    assert.match(codexSource, /model\.provider === "openai-codex" \? CODEX_CUSTOM_TOOL_NAMES : undefined/);
    assert.doesNotMatch(codexSource, /parallel_tool_calls: true/);

    const output = {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const emitted = [];
    async function* events() {
        yield { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ctc_2", call_id: "call_2", name: "apply_patch", input: "" } };
        yield { type: "response.custom_tool_call_input.delta", output_index: 0, delta: patchText.slice(0, 25) };
        yield { type: "response.custom_tool_call_input.done", output_index: 0, input: patchText };
        yield { type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "ctc_2", call_id: "call_2", name: "apply_patch", input: patchText } };
        yield { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } };
    }
    await codec.processResponsesStream(events(), output, { push: (event) => emitted.push(event) }, model);
    assert.deepEqual(output.content, [
        { type: "toolCall", id: "call_2|ctc_2", name: "apply_patch", arguments: { patch: patchText } },
    ]);
    assert.equal(output.stopReason, "toolUse");
    const toolCallJson = emitted.filter((event) => event.type === "toolcall_delta").map((event) => event.delta).join("");
    assert.deepEqual(JSON.parse(toolCallJson), { patch: patchText });
    assert.equal(emitted.at(-1).type, "toolcall_end");
});

test("Codex request building keeps custom providers on function apply_patch", async (t) => {
    const { root, fixturePiAi } = await makeFixture(t);
    const apply = runScript(root);
    assert.equal(apply.status, 0, apply.stderr);
    const codexApi = await import(`${pathToFileURL(join(fixturePiAi, CODEX_TARGET_RELATIVE)).href}?provider=${Date.now()}`);
    const tokenPayload = {
        "https://api.openai.com/auth": { chatgpt_account_id: "account_fixture" },
    };
    const token = [
        Buffer.from("{}").toString("base64url"),
        Buffer.from(JSON.stringify(tokenPayload)).toString("base64url"),
        "signature",
    ].join(".");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
        `data: ${JSON.stringify({
            type: "response.completed",
            response: { id: "resp_fixture", status: "completed", output: [] },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const captureRequest = async (provider) => {
        let payload;
        const model = {
            id: "codex-fixture",
            name: "Codex fixture",
            api: "openai-codex-responses",
            provider,
            baseUrl: "https://chatgpt.example/backend-api",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 4096,
        };
        const context = {
            systemPrompt: "test",
            messages: [{ role: "user", content: "patch", timestamp: Date.now() }],
            tools: [{
                name: "apply_patch",
                description: "Apply a patch",
                parameters: { type: "object", properties: { patch: { type: "string" } } },
            }],
        };
        const events = codexApi.stream(model, context, {
            apiKey: token,
            transport: "sse",
            onPayload(value) {
                payload = value;
            },
        });
        for await (const event of events)
            assert.notEqual(event.type, "error", event.error?.errorMessage);
        return payload;
    };

    const customProviderPayload = await captureRequest("custom-codex");
    assert.equal(customProviderPayload.parallel_tool_calls, false);
    assert.equal(customProviderPayload.tools[0].type, "function");
    assert.deepEqual(customProviderPayload.tools[0].parameters.properties, { patch: { type: "string" } });

    const chatGptPayload = await captureRequest("openai-codex");
    assert.equal(chatGptPayload.parallel_tool_calls, false);
    assert.deepEqual(chatGptPayload.tools[0], {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
        format: { type: "text" },
    });
});

test("custom stream correlation tolerates missing indexes and item IDs and finalizes at item.done", async (t) => {
    const { root, fixturePiAi } = await makeFixture(t);
    const apply = runScript(root);
    assert.equal(apply.status, 0, apply.stderr);

    const codec = await import(`${pathToFileURL(join(fixturePiAi, TARGET_RELATIVE)).href}?missing=${Date.now()}`);
    const model = {
        id: "codex-test",
        provider: "openai-codex",
        api: "openai-codex-responses",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const patchText = "*** Begin Patch\n*** Add File: escaped.txt\n+\"quoted\\\\value\"\n*** End Patch";
    const output = {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const emitted = [];
    async function* events() {
        yield {
            type: "response.output_item.added",
            item: { type: "custom_tool_call", call_id: "call_without_item_id", name: "apply_patch", input: "" },
        };
        yield { type: "response.custom_tool_call_input.delta", delta: patchText.slice(0, 21) };
        yield { type: "response.custom_tool_call_input.delta", delta: patchText.slice(21) };
        // Codex sometimes omits input.done. output_item.done must close the
        // synthesized JSON stream and can also omit output_index and item.id.
        yield {
            type: "response.output_item.done",
            item: { type: "custom_tool_call", call_id: "call_without_item_id", name: "apply_patch", input: patchText },
        };
        yield { type: "response.completed", response: { id: "resp_missing", status: "completed", output: [] } };
    }

    await codec.processResponsesStream(events(), output, { push: (event) => emitted.push(event) }, model);
    assert.deepEqual(output.content, [
        { type: "toolCall", id: "call_without_item_id", name: "apply_patch", arguments: { patch: patchText } },
    ]);
    const jsonDeltas = emitted.filter((event) => event.type === "toolcall_delta").map((event) => event.delta);
    assert.deepEqual(JSON.parse(jsonDeltas.join("")), { patch: patchText });
    assert.match(jsonDeltas.at(-1), /"}$/);
    assert.equal(emitted.filter((event) => event.type === "toolcall_end").length, 1);
    assert.equal(output.stopReason, "toolUse");
});
