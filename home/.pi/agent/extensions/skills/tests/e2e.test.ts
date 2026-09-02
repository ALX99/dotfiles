import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";

import skillsExtension from "../index.ts";

test("Pi session integration toggles discovery, locks it, and keeps native skill expansion", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-skills-e2e-"));
	try {
		const skillsRoot = join(root, "skills");
		await mkdir(join(skillsRoot, "alpha"), { recursive: true });
		await mkdir(join(skillsRoot, "beta"), { recursive: true });
		await mkdir(join(skillsRoot, "manual"), { recursive: true });
		await writeFile(
			join(skillsRoot, "alpha", "SKILL.md"),
			"---\nname: alpha\ndescription: Alpha discovery skill\n---\nAlpha instructions.\n",
		);
		await writeFile(
			join(skillsRoot, "beta", "SKILL.md"),
			"---\nname: beta\ndescription: Beta discovery skill\n---\nBeta instructions.\n",
		);
		await writeFile(
			join(skillsRoot, "manual", "SKILL.md"),
			"---\nname: manual\ndescription: Manual skill\ndisable-model-invocation: true\n---\nManual instructions.\n",
		);

		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory(root);
		const faux = fauxProvider({ provider: "pi-skills-e2e", api: "pi-skills-e2e-api" });
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager,
			additionalSkillPaths: [skillsRoot],
			extensionFactories: [skillsExtension],
		});
		await resourceLoader.reload();

		const systemPrompts: string[] = [];
		const userMessages: string[] = [];
		const responses: FauxResponseFactory[] = [
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("first response");
			},
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				userMessages.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("second response");
			},
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				userMessages.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("third response");
			},
		];
		faux.setResponses(responses);
		const selections: string[] = ["beta", "Done"];
		const notifications: string[] = [];
		const ui = {
			select: async (_title: string, _options: string[]) => selections.shift(),
			notify: (message: string) => notifications.push(message),
		} as unknown as ExtensionUIContext;

		const { session } = await createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			modelRuntime,
			model: faux.getModel(),
			resourceLoader,
			settingsManager,
			sessionManager,
		});
		await session.bindExtensions({ mode: "rpc", uiContext: ui });

		await session.prompt("/skills");
		await session.reload();
		await session.prompt("hello");
		assert.equal(systemPrompts.length, 1);
		assert.match(systemPrompts[0]!, /<name>alpha<\/name>/u);
		assert.doesNotMatch(systemPrompts[0]!, /<name>beta<\/name>/u);
		assert.doesNotMatch(systemPrompts[0]!, /<name>manual<\/name>/u);

		selections.push("beta", "Done");
		await session.prompt("/skills");
		assert.ok(notifications.some((message) => message.includes("locked")));

		await session.prompt("/skill:beta");
		assert.equal(systemPrompts.length, 2);
		assert.doesNotMatch(systemPrompts[1]!, /<name>beta<\/name>/u);
		assert.ok(userMessages[0]?.includes('<skill name=\\"beta\\"'));
		assert.ok(userMessages[0]?.includes("Beta instructions."));

		await session.prompt("/skill:manual");
		assert.equal(systemPrompts.length, 3);
		assert.doesNotMatch(systemPrompts[2]!, /<name>beta<\/name>/u);
		assert.ok(userMessages[1]?.includes('<skill name=\\"manual\\"'));
		assert.ok(userMessages[1]?.includes("Manual instructions."));
		session.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
