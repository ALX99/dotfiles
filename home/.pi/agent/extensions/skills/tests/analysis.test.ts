import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

import { runPromise } from "../../_shared/effect-runtime.ts";
import { countDiagnostics, formatNativeSkillBlock, inspectSkills, summarizeSkillTokens } from "../analysis.ts";

test("inspectSkills reports Pi metadata compatibility and token estimates", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-skills-analysis-"));
	try {
		await mkdir(join(root, "good"));
		await writeFile(
			join(root, "good", "SKILL.md"),
			"---\nname: good\ndescription: A useful skill\nallowed-tools: read bash\n---\n\nUse the skill.\n",
		);
		await mkdir(join(root, "manual"));
		await writeFile(
			join(root, "manual", "SKILL.md"),
			"---\nname: manual\ndescription: An explicitly loaded skill\ndisable-model-invocation: true\n---\n\nLoad me directly.\n",
		);
		await mkdir(join(root, "bad--name"));
		await writeFile(
			join(root, "bad--name", "SKILL.md"),
			`---\nname: bad--name\ndescription: ${"x".repeat(1025)}\nallowed-tools: read edit\n---\n\nNeeds review.\n`,
		);

		const loaded = loadSkillsFromDir({ dir: root, source: "test" });
		assert.equal(loaded.skills.length, 3);
		const analyses = await runPromise(inspectSkills(loaded.skills, ["read", "bash"]));
		const good = analyses.find(({ skill }) => skill.name === "good");
		const manual = analyses.find(({ skill }) => skill.name === "manual");
		const bad = analyses.find(({ skill }) => skill.name === "bad--name");
		assert.ok(good);
		assert.ok(manual);
		assert.ok(bad);
		assert.equal(good.body, "Use the skill.");
		assert.equal(manual.body, "Load me directly.");
		assert.ok(good.descriptorTokens > 0);
		assert.ok(good.bodyTokens > 0);
		assert.ok(good.nativeLoadTokens > good.bodyTokens);
		assert.ok(manual.diagnostics.some(({ message }) => message.includes("manual-only")));
		assert.ok(bad.diagnostics.some(({ message }) => message.includes("exceeds 1024")));
		assert.ok(bad.diagnostics.some(({ message }) => message.includes("consecutive hyphens")));
		assert.ok(bad.diagnostics.some(({ message }) => message.includes("allowed-tools not active: edit")));

		const counts = countDiagnostics(analyses);
		assert.equal(counts.errors, 0);
		assert.ok(counts.warnings >= 3);
		const tokens = summarizeSkillTokens(analyses, new Set(["good", "manual"]), true);
		assert.ok(tokens.activeDescriptorTokens > 0);
		assert.equal(tokens.activeBodyTokens, good.bodyTokens);
		assert.ok(tokens.allBodyTokens >= tokens.activeBodyTokens);
		assert.ok(tokens.allNativeLoadTokens >= tokens.activeNativeLoadTokens);
		assert.match(formatNativeSkillBlock(good.skill, good.body), /<skill name="good"/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("inspectSkills reports unreadable skill files without throwing", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-skills-missing-"));
	try {
		await mkdir(join(root, "skill"));
		const filePath = join(root, "skill", "SKILL.md");
		await writeFile(filePath, "---\nname: skill\ndescription: Test\n---\nBody\n");
		const loaded = loadSkillsFromDir({ dir: root, source: "test" });
		const skill = loaded.skills[0];
		assert.ok(skill);
		await rm(filePath);
		const [analysis] = await runPromise(inspectSkills([skill], []));
		assert.ok(analysis);
		assert.ok(
			analysis.diagnostics.some(({ severity, message }) => severity === "error" && message.includes("Could not read")),
		);
		assert.equal(analysis.body, "");
		assert.ok(!analysis.diagnostics.some(({ message }) => message.includes("body is empty")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
