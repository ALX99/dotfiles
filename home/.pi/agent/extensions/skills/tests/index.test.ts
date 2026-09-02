import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	formatSkillsForPrompt,
	loadSkillsFromDir,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	type Skill,
	createSyntheticSourceInfo,
} from "@earendil-works/pi-coding-agent";

import skillsExtension, { getEnabledModelSkills, rewriteSkillPrompt } from "../index.ts";

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

test("rewriteSkillPrompt filters only Pi's native discovery section", () => {
	const alpha = makeSkill("alpha");
	const beta = makeSkill("beta");
	const manual = makeSkill("manual", true);
	const skills = [alpha, beta, manual];
	const nativeSection = formatSkillsForPrompt(skills);
	const event = {
		type: "before_agent_start",
		prompt: "hello",
		systemPrompt: `prefix${nativeSection}suffix`,
		systemPromptOptions: { cwd: "/tmp", selectedTools: ["read"], skills },
	} as BeforeAgentStartEvent;

	const rewritten = rewriteSkillPrompt(event, new Set(["alpha"]));
	assert.ok(rewritten);
	assert.match(rewritten, /<name>alpha<\/name>/u);
	assert.doesNotMatch(rewritten, /<name>beta<\/name>/u);
	assert.doesNotMatch(rewritten, /<name>manual<\/name>/u);
	assert.equal(rewriteSkillPrompt(event, new Set(["alpha", "beta"])), undefined);
	assert.equal(
		getEnabledModelSkills(skills, new Set(["alpha", "manual"]))
			.map(({ name }) => name)
			.join(","),
		"alpha",
	);

	const noReadEvent = {
		...event,
		systemPromptOptions: { cwd: "/tmp", selectedTools: ["bash"], skills },
	} as BeforeAgentStartEvent;
	assert.equal(rewriteSkillPrompt(noReadEvent, new Set()), undefined);
});

test("/skills persists toggles, rewrites the next prompt, and locks after a user message", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-skills-command-"));
	try {
		await mkdir(join(root, "alpha"));
		await mkdir(join(root, "beta"));
		await writeFile(join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body\n");
		await writeFile(join(root, "beta", "SKILL.md"), "---\nname: beta\ndescription: Beta skill\n---\nBeta body\n");
		const skills = loadSkillsFromDir({ dir: root, source: "test" }).skills;
		const branch: SessionEntry[] = [];
		const notifications: string[] = [];
		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
		const pi = {
			on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
				handlers.set(event, handler);
			},
			registerCommand(
				name: string,
				command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) {
				commands.set(name, command);
			},
			getActiveTools: () => ["read", "bash"],
			appendEntry(customType: string, data: unknown) {
				branch.push({
					type: "custom",
					id: `custom-${branch.length}`,
					parentId: branch.length === 0 ? null : branch[branch.length - 1]!.id,
					timestamp: new Date().toISOString(),
					customType,
					data,
				});
			},
		} as unknown as ExtensionAPI;
		skillsExtension(pi);
		const selectQueue: string[] = ["beta", "Done"];
		const ctx = {
			cwd: root,
			mode: "rpc",
			hasUI: true,
			sessionManager: { getBranch: () => branch },
			ui: {
				select: async () => selectQueue.shift(),
				notify: (message: string) => notifications.push(message),
			},
			getSystemPromptOptions: () => ({ cwd: root, selectedTools: ["read"], skills }),
		} as unknown as ExtensionCommandContext;

		await handlers.get("session_start")!({} as never, ctx);
		await commands.get("skills")!.handler("", ctx);
		const persisted = branch.at(-1);
		assert.equal(persisted?.type, "custom");
		assert.deepEqual((persisted as Extract<SessionEntry, { type: "custom" }>).data, {
			version: 1,
			knownNames: ["alpha", "beta"],
			enabledNames: ["alpha"],
		});

		const nativeSection = formatSkillsForPrompt(skills);
		const before = handlers.get("before_agent_start")!(
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: `prefix${nativeSection}suffix`,
				systemPromptOptions: { cwd: root, selectedTools: ["read"], skills },
			} as never,
			ctx,
		);
		assert.ok(before && typeof before === "object");
		assert.match((before as { systemPrompt: string }).systemPrompt, /<name>alpha<\/name>/u);
		assert.doesNotMatch((before as { systemPrompt: string }).systemPrompt, /<name>beta<\/name>/u);

		branch.push({
			type: "message",
			id: "user-1",
			parentId: branch.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			message: { role: "user" } as never,
		});
		selectQueue.push("beta", "Done");
		await commands.get("skills")!.handler("", ctx);
		assert.ok(notifications.some((message) => message.includes("locked")));
		assert.equal(branch.at(-1)?.type, "message");
		assert.deepEqual(
			(branch.filter((entry) => entry.type === "custom").at(-1) as Extract<SessionEntry, { type: "custom" }>).data,
			persisted && persisted.type === "custom" ? persisted.data : undefined,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
