import assert from "node:assert/strict";
import test from "node:test";

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type RegisteredCommand,
	type SessionEntry,
	type Skill,
	createSyntheticSourceInfo,
} from "@earendil-works/pi-coding-agent";

import skillsExtension from "../index.ts";
import { enabledModelSkillNames, SKILLS_STATE_ENTRY } from "../state.ts";

function makeSkill(name: string, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/tmp/${name}/SKILL.md`, { source: "test" }),
		disableModelInvocation,
	};
}

function selection(data: unknown): SessionEntry {
	return {
		type: "custom",
		id: "selection",
		parentId: null,
		timestamp: "2026-10-05T00:00:00Z",
		customType: SKILLS_STATE_ENTRY,
		data,
	};
}

test("visibility follows the branch selection and defaults newly discovered names to enabled", () => {
	const alpha = makeSkill("alpha");
	const beta = makeSkill("beta");
	const gamma = makeSkill("gamma");
	const manual = makeSkill("manual", true);
	const branch = [
		selection({ version: 1, knownNames: ["alpha", "beta", "manual", "removed"], enabledNames: ["alpha", "removed"] }),
		selection({ version: 1, knownNames: "invalid", enabledNames: [] }),
	];
	const visible = (entries: SessionEntry[], skills: Skill[]) => [...enabledModelSkillNames(entries, skills)];

	assert.deepEqual(visible(branch, [alpha, beta, manual, gamma]), ["alpha", "gamma"]);
	assert.deepEqual(visible(branch, [alpha]), ["alpha"]);
	assert.deepEqual(
		visible(branch, [alpha, beta]),
		["alpha"],
		"a temporary inventory change cannot erase a saved preference",
	);
	assert.deepEqual(visible([], [alpha, beta, manual]), ["alpha", "beta"]);
	const switched = [...branch, selection({ version: 1, knownNames: ["alpha", "beta"], enabledNames: ["beta"] })];
	assert.deepEqual(visible(switched, [alpha, beta]), ["beta"]);
	assert.deepEqual(visible(branch, [alpha, beta]), ["alpha"], "navigation requires no in-memory restore");
});

test("malformed or unsupported selections do not hide skills", () => {
	const alpha = makeSkill("alpha");
	for (const data of [
		undefined,
		{ version: 2, knownNames: ["alpha"], enabledNames: [] },
		{ version: 1, knownNames: ["alpha"], enabledNames: [false] },
	]) {
		assert.deepEqual([...enabledModelSkillNames([selection(data)], [alpha])], ["alpha"]);
	}
});

test("the skills extension owns its command, not a second prompt renderer or runtime selection", () => {
	const commands: string[] = [];
	const pi = {
		registerCommand(name: string) {
			commands.push(name);
		},
		on() {
			assert.fail("skill visibility must be consumed by the prompt renderer, not a lifecycle hook");
		},
	} as unknown as ExtensionAPI;
	skillsExtension(pi);
	assert.deepEqual(commands, ["skills"]);
});

test("/skills persists a toggle for the prompt renderer and refuses changes after the first user message", async () => {
	const skills = [makeSkill("alpha"), makeSkill("beta")];
	const branch: SessionEntry[] = [];
	const notices: string[] = [];
	let command: RegisteredCommand | undefined;
	let choices = ["beta", "Done"];
	const pi = {
		registerCommand(_name: string, registered: RegisteredCommand) {
			command = registered;
		},
		getActiveTools: () => ["read"],
		appendEntry(customType: string, data: unknown) {
			assert.equal(customType, SKILLS_STATE_ENTRY);
			branch.push(selection(data));
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "rpc",
		hasUI: true,
		getSystemPromptOptions: () => ({ skills, selectedTools: ["read"] }),
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (_title: string, options: string[]) => {
				const choice = choices.shift();
				assert.ok(choice !== undefined);
				return options.find((option) => option.startsWith(choice));
			},
		},
	} as unknown as ExtensionCommandContext;
	skillsExtension(pi);
	assert.ok(command !== undefined);
	await command.handler("", ctx);
	assert.deepEqual([...enabledModelSkillNames(branch, skills)], ["alpha"]);
	assert.equal(branch.length, 1);

	branch.push({
		type: "message",
		id: "user",
		parentId: "selection",
		timestamp: "2026-10-05T00:00:00Z",
		message: { role: "user", content: "start", timestamp: 0 },
	});
	choices = ["beta", "Done"];
	await command.handler("", ctx);
	assert.equal(branch.length, 2, "a locked session must not persist a new selection");
	assert.deepEqual([...enabledModelSkillNames(branch, skills)], ["alpha"]);
	assert.ok(notices.some((notice) => notice.includes("locked")));

	branch.length = 0;
	choices = ["Done"];
	await command.handler("", ctx);
	assert.deepEqual(
		[...enabledModelSkillNames(branch, skills)],
		["alpha", "beta"],
		"a new branch cannot inherit a runtime mirror",
	);
});
