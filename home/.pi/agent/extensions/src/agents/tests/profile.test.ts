import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "effect";

import { runPromise } from "../../support/effect-runtime.ts";
import { discoverProfiles, loadProfile, parseProfile, type ProfileModelLookup } from "../profile.ts";

const MODEL = "anthropic/claude-sonnet-4-5";
const models: ProfileModelLookup = {
	find: (provider, modelId) =>
		provider === "anthropic" && modelId === "claude-sonnet-4-5" ? { provider, modelId } : undefined,
};

test("profile parsing resolves model and freezes the prompt and explicit allowlists", () => {
	const parsed = parseProfile(
		"engineer",
		"/profiles/engineer.md",
		[
			"---",
			`model: ${MODEL}:xhigh`,
			"tools: [read, bash]",
			"skills: [typescript, testing]",
			"spawn_profiles: [engineer, researcher]",
			"---",
			"",
			"  Focus on clear, tested implementations.  ",
		].join("\n"),
		models,
	);

	if (Result.isFailure(parsed)) assert.fail(parsed.failure.message);
	assert.deepEqual(parsed.success.model, { provider: "anthropic", id: "claude-sonnet-4-5" });
	assert.equal(parsed.success.thinkingLevel, "xhigh");
	assert.equal(parsed.success.prompt, "Focus on clear, tested implementations.");
	assert.deepEqual(parsed.success.tools, ["read", "bash"]);
	assert.deepEqual(parsed.success.skills, ["typescript", "testing"]);
	assert.deepEqual(parsed.success.spawnProfiles, ["engineer", "researcher"]);
	assert.ok(Object.isFrozen(parsed.success));
	assert.ok(Object.isFrozen(parsed.success.model));
	assert.ok(Object.isFrozen(parsed.success.tools));
	assert.ok(Object.isFrozen(parsed.success.skills));
	assert.ok(Object.isFrozen(parsed.success.spawnProfiles));
});

test("omitted and empty allowlists remain distinct", () => {
	const unrestricted = parseProfile("researcher", "/profiles/researcher.md", profile(""), models);
	const restrictedToNone = parseProfile(
		"researcher",
		"/profiles/researcher.md",
		profile("tools: []\nskills: []\nspawn_profiles: []\n"),
		models,
	);

	if (Result.isFailure(unrestricted)) assert.fail(unrestricted.failure.message);
	if (Result.isFailure(restrictedToNone)) assert.fail(restrictedToNone.failure.message);
	assert.equal(unrestricted.success.tools, undefined);
	assert.equal(unrestricted.success.skills, undefined);
	assert.equal(unrestricted.success.spawnProfiles, undefined);
	assert.deepEqual(restrictedToNone.success.tools, []);
	assert.deepEqual(restrictedToNone.success.skills, []);
	assert.deepEqual(restrictedToNone.success.spawnProfiles, []);
});

test("invalid names, missing models, malformed fields, duplicate allowlists, and unknown models fail validation", () => {
	const cases = [
		{ name: "../engineer", content: profile(""), expected: /Invalid profile name/u },
		{ name: "engineer", content: "---\ntools: [read]\n---\nPrompt\n", expected: /model/u },
		{ name: "engineer", content: profile("tools: read"), expected: /tools/u },
		{ name: "engineer", content: profile("tools: [read, read]"), expected: /duplicates/u },
		{ name: "engineer", content: profile("spawn_profiles: [engineer, engineer]"), expected: /duplicates/u },
		{ name: "engineer", content: profile("spawn_profiles: [Bad_Name]"), expected: /lowercase letters/u },
		{ name: "engineer", content: profile("spawn_profiles: engineer"), expected: /spawn_profiles/u },
		{ name: "engineer", content: profile(`model: "${MODEL}:"`), expected: /thinking-level suffix/u },
		{ name: "engineer", content: profile(`model: ${MODEL}:turbo`), expected: /thinking-level suffix/u },
		{
			name: "engineer",
			content: profile("model: openai/not-configured"),
			expected: /Unknown profile model/u,
		},
		{ name: "engineer", content: "---\nmodel: anthropic/claude-sonnet-4-5\n---\n   \n", expected: /empty/u },
	];

	for (const { name, content, expected } of cases) {
		const parsed = parseProfile(name, "/profiles/engineer.md", content, models);
		assert.ok(Result.isFailure(parsed));
		if (Result.isFailure(parsed)) assert.match(parsed.failure.message, expected);
	}
});

test("loading again after a profile edit creates a new snapshot without mutating the old one", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-profile-snapshot-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "engineer.md");
	await writeFile(path, profile("tools: [read]\nspawn_profiles: [researcher]"));

	const first = await runPromise(loadProfile("engineer", models, root));
	await writeFile(path, profile("tools: [read, bash]\nspawn_profiles: [designer]", "Use concise explanations."));
	const second = await runPromise(loadProfile("engineer", models, root));

	assert.deepEqual(first.tools, ["read"]);
	assert.deepEqual(first.spawnProfiles, ["researcher"]);
	assert.equal(first.prompt, "A profile prompt.");
	assert.deepEqual(second.tools, ["read", "bash"]);
	assert.deepEqual(second.spawnProfiles, ["designer"]);
	assert.equal(second.prompt, "Use concise explanations.");
	assert.notEqual(first, second);
});

test("discovery sorts valid profiles and reports invalid files without failing the directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-profile-discovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "zeta.md"), profile(""));
	await writeFile(join(root, "bad.md"), "---\nmodel: missing-slash\n---\nInvalid\n");
	await writeFile(join(root, "alpha.md"), profile("skills: []"));
	await writeFile(join(root, "notes.txt"), "not a profile");

	const result = await runPromise(discoverProfiles(models, root));
	assert.deepEqual(
		result.profiles.map(({ name }) => name),
		["alpha", "zeta"],
	);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0]?.message ?? "", /provider\/model-id/u);
});

test("discovery includes symlinked profile files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-profile-symlink-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "profiles");
	const target = join(root, "manager.md");
	await mkdir(directory);
	await writeFile(target, profile(""));
	await symlink(target, join(directory, "manager.md"));

	const result = await runPromise(discoverProfiles(models, directory));
	assert.deepEqual(
		result.profiles.map(({ name }) => name),
		["manager"],
	);
	assert.deepEqual(result.diagnostics, []);
});

test("discovery treats an absent profile directory as empty", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-profile-empty-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	assert.deepEqual(await runPromise(discoverProfiles(models, join(root, "profiles"))), {
		profiles: [],
		diagnostics: [],
	});
});

function profile(fields: string, prompt = "A profile prompt."): string {
	const model = fields.includes("model:") ? "" : `model: ${MODEL}\n`;
	return `---\n${model}${fields}${fields.length === 0 || fields.endsWith("\n") ? "" : "\n"}---\n${prompt}\n`;
}
