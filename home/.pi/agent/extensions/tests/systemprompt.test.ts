import * as assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";

import systemPromptExtension, {
	SystemPromptViewer,
	attributeGuideline,
	buildSystemPrompt,
	cwdPath,
	guidelineOwners,
	hostInformation,
	tildePath,
	type HostInformation,
} from "../systemprompt.ts";

type Entry = Record<string, unknown>;

const targets: string[] = [];

// The markdown theme used by the viewer reads global theme state.
initTheme("stellar");

test.after(() => {
	void Promise.all(targets.map((target) => rm(dirname(target), { recursive: true, force: true })));
});

const HOST: HostInformation = {
	system: "Darwin",
	release: "25.6.0",
	version: "Darwin Kernel Version 25.6.0: Fri Jul 31 19:11:03 PDT 2026",
	machine: "arm64",
};

function skill(overrides: Partial<Skill> & Pick<Skill, "name">): Skill {
	return {
		description: `${overrides.name} description.`,
		filePath: `/skills/${overrides.name}/SKILL.md`,
		baseDir: `/skills/${overrides.name}`,
		sourceInfo: { path: `/skills/${overrides.name}`, source: "user", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
		...overrides,
	};
}

function options(overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
	return {
		cwd: "/workspace/project",
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		...overrides,
	};
}

function build(overrides: Partial<BuildSystemPromptOptions> = {}): string {
	return buildSystemPrompt(options(overrides), HOST);
}

function section(prompt: string, heading: string): string | undefined {
	const start = prompt.split("\n").findIndex((line) => line === heading);
	if (start === -1) return undefined;
	const rest = prompt.split("\n").slice(start + 1);
	const end = rest.findIndex((line) => line === "");
	return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("the prompt assembles every section in the documented order", () => {
	const prompt = build({
		appendSystemPrompt: "APPENDED INSTRUCTIONS",
		contextFiles: [{ path: "/workspace/project/AGENTS.md", content: "Repo rules." }],
		skills: [skill({ name: "commit" })],
	});

	assert.match(
		prompt,
		/^You are an expert coding assistant that interacts with a computer\. Use the tools available to you to achieve the goal efficiently\./,
	);

	const order = [
		"Available tools:",
		"Guidelines:",
		"Skills:",
		"System Information",
		"APPENDED INSTRUCTIONS",
		"<project_context>",
	];
	const positions = order.map((marker) => prompt.indexOf(marker));
	assert.ok(
		positions.every((position) => position !== -1),
		`every section is present: ${JSON.stringify(order.map((marker, index) => [marker, positions[index]]))}`,
	);
	assert.deepEqual(
		positions.toSorted((a, b) => a - b),
		positions,
		"sections appear in order",
	);
});

test("a user-supplied custom prompt replaces the role statement only", () => {
	const prompt = build({ customPrompt: "You are a terse shell operator." });

	assert.match(prompt, /^You are a terse shell operator\.\n\nAvailable tools:/);
	assert.doesNotMatch(prompt, /expert coding assistant/);
});

test("a blank custom prompt falls back to the role statement", () => {
	assert.match(build({ customPrompt: "   " }), /^You are an expert coding assistant/);
});

test("host information matches mini-swe-agent's uname template", () => {
	assert.equal(
		section(build(), "System Information"),
		"- Host: Darwin 25.6.0 Darwin Kernel Version 25.6.0: Fri Jul 31 19:11:03 PDT 2026 arm64\n- Working directory: /workspace/project",
	);
});

test("host information reads the real host when none is injected", () => {
	const information = hostInformation();
	assert.ok(information.system.length > 0);
	assert.ok(information.release.length > 0);
	assert.ok(information.version.length > 0);
	assert.ok(information.machine.length > 0);
});

test("tildePath shortens only paths under home", () => {
	assert.equal(tildePath("/home/dozy", "/home/dozy"), "~");
	assert.equal(tildePath("/home/dozy/dotfiles/AGENTS.md", "/home/dozy"), "~/dotfiles/AGENTS.md");
	assert.equal(tildePath("/home/dozynski/file", "/home/dozy"), "/home/dozynski/file");
	assert.equal(tildePath("/workspace/project", "/home/dozy"), "/workspace/project");
});

test("cwdPath shortens paths under the working directory and leaves the rest to tildePath", () => {
	assert.equal(cwdPath("/workspace/project", "/workspace/project", "/home/dozy"), ".");
	assert.equal(
		cwdPath("/workspace/project/.agents/skills/go/SKILL.md", "/workspace/project", "/home/dozy"),
		".agents/skills/go/SKILL.md",
	);
	// A sibling directory that merely shares the prefix is not under the working directory.
	assert.equal(
		cwdPath("/workspace/project-other/AGENTS.md", "/workspace/project", "/home/dozy"),
		"/workspace/project-other/AGENTS.md",
	);
	assert.equal(cwdPath("/home/dozy/file", "/workspace/project", "/home/dozy"), "~/file");
});

test("paths under home render as ~ in every section the renderer owns", () => {
	const home = homedir();
	const prompt = build({
		cwd: join(home, "dotfiles"),
		skills: [skill({ name: "commit", filePath: join(home, ".pi/agent/skills/commit/SKILL.md") })],
		contextFiles: [{ path: join(home, "dotfiles/AGENTS.md"), content: "Repo rules." }],
	});

	assert.match(prompt, /^- Working directory: ~\/dotfiles$/m);
	assert.match(prompt, /→ `~\/\.pi\/agent\/skills\/commit\/SKILL\.md`/);
	assert.match(prompt, /<project_instructions path="~\/dotfiles\/AGENTS\.md">/);
	assert.ok(!prompt.includes(home), "no absolute home path survives in the prompt");
});

test("tools come from the injected snippets and skip tools without one", () => {
	const prompt = build({
		selectedTools: ["read", "edit", "mystery"],
		toolSnippets: { read: "Read file contents", edit: "Make file edits" },
	});

	assert.equal(section(prompt, "Available tools:"), "- read: Read file contents\n- edit: Make file edits");
});

test("the bash snippet names rg and fd in place of Pi's grep and find", () => {
	const prompt = build({
		selectedTools: ["bash"],
		toolSnippets: { bash: "Execute bash commands (ls, grep, find, etc.)" },
	});

	assert.equal(section(prompt, "Available tools:"), "- bash: Execute bash commands (ls, rg, fd, etc.)");
});

test("an empty tool set renders as none rather than a dangling heading", () => {
	const prompt = build({ selectedTools: [], toolSnippets: {} });

	assert.equal(section(prompt, "Available tools:"), "(none)");
});

test("guidelines render in order, skipping blanks and duplicates", () => {
	const prompt = build({ promptGuidelines: ["Only tools rule", "  ", "Only tools rule", "Second rule"] });

	assert.deepEqual(section(prompt, "Guidelines:")?.split("\n"), [
		"- The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it.",
		"- Only tools rule",
		"- Second rule",
		"- read: Paths beginning with `~/` are supported; use them instead of guessing an absolute home directory.",
		"- Use Conventional Commits when committing.",
	]);
});

test("the ADHD guideline leads the list without any tool selection", () => {
	assert.deepEqual(
		section(build({ selectedTools: [], toolSnippets: {}, promptGuidelines: [] }), "Guidelines:")?.split("\n"),
		["- The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it."],
	);
});

test("guideline owners come from the declaration order of the active tools", () => {
	const owners = guidelineOwners({
		getActiveTools: () => ["read", "bash"],
		getAllTools: () => [
			{ name: "read", promptGuidelines: ["Use read to examine files", "Shared rule"] },
			{ name: "bash", promptGuidelines: ["Shared rule"] },
			{ name: "spawn_agent", promptGuidelines: ["Unreachable rule"] },
		],
	});

	assert.deepEqual(
		[...owners],
		[
			["Use read to examine files", "read"],
			["Shared rule", "read"],
		],
	);
});

test("a guideline that never names its tool is attributed to the tool that owns it", () => {
	const owners = new Map([
		["Live-agent capacity is 10 root children total.", "spawn_agent"],
		["Use edit for precise changes", "edit"],
		["Keep edits[].oldText as small as possible", "edit"],
	]);

	assert.equal(
		attributeGuideline("Live-agent capacity is 10 root children total.", owners),
		"spawn_agent: Live-agent capacity is 10 root children total.",
	);
	// Rules that already name their tool stay as written rather than repeating it.
	assert.equal(attributeGuideline("Use edit for precise changes", owners), "Use edit for precise changes");
	assert.equal(
		attributeGuideline("Keep edits[].oldText as small as possible", owners),
		"Keep edits[].oldText as small as possible",
	);
	// An unattributed rule is still better off unlabeled than mislabeled.
	assert.equal(attributeGuideline("Be concise in your responses", owners), "Be concise in your responses");
	assert.equal(
		attributeGuideline("Live-agent capacity is 10 root children total."),
		"Live-agent capacity is 10 root children total.",
	);
});

test("Pi's PI_* environment variable guideline is dropped", () => {
	const prompt = build({
		promptGuidelines: [
			"You can inspect PI_* environment variables for current model and session details.",
			"Only tools rule",
		],
	});

	assert.deepEqual(section(prompt, "Guidelines:")?.split("\n"), [
		"- The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it.",
		"- Only tools rule",
		"- read: Paths beginning with `~/` are supported; use them instead of guessing an absolute home directory.",
		"- Use Conventional Commits when committing.",
	]);
});

test("dropping the PI_* guideline alone leaves only the renderer's own rules", () => {
	const prompt = build({
		promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
	});

	assert.deepEqual(section(prompt, "Guidelines:")?.split("\n"), [
		"- The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it.",
		"- read: Paths beginning with `~/` are supported; use them instead of guessing an absolute home directory.",
		"- Use Conventional Commits when committing.",
	]);
});

test("the two fixed lines Pi always adds are not re-emitted", () => {
	const prompt = build({ selectedTools: ["bash"], promptGuidelines: ["Only tools rule"] });

	assert.doesNotMatch(prompt, /Be concise in your responses/);
	assert.doesNotMatch(prompt, /Show file paths clearly when working with files/);
});

test("a contributor may still supply either fixed line itself", () => {
	const prompt = build({ promptGuidelines: ["Be concise in your responses"] });

	assert.deepEqual(section(prompt, "Guidelines:")?.split("\n"), [
		"- The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it.",
		"- Be concise in your responses",
		"- read: Paths beginning with `~/` are supported; use them instead of guessing an absolute home directory.",
		"- Use Conventional Commits when committing.",
	]);
});

test("project context carries every file in one wrapper", () => {
	const prompt = build({
		contextFiles: [
			{ path: "/a/AGENTS.md", content: "First rules." },
			{ path: "/b/CLAUDE.md", content: "Second rules." },
		],
	});

	assert.match(
		prompt,
		/<project_context>\n<project_instructions path="\/a\/AGENTS\.md">\nFirst rules\.\n<\/project_instructions>\n\n<project_instructions path="\/b\/CLAUDE\.md">\nSecond rules\.\n<\/project_instructions>\n<\/project_context>/,
	);
});

test("the project context block disappears when no files are loaded", () => {
	assert.doesNotMatch(build(), /<project_context>/);
	assert.doesNotMatch(build({ contextFiles: [] }), /<project_context>/);
});

test("skills render as one line per skill with the read instruction", () => {
	const prompt = build({ skills: [skill({ name: "commit" }), skill({ name: "go-code" })] });

	assert.match(prompt, /Use the list below to identify relevant skills\./);
	assert.match(prompt, /^\* `commit` — commit description\. → `\/skills\/commit\/SKILL\.md`$/m);
	assert.match(prompt, /^\* `go-code` — go-code description\. → `\/skills\/go-code\/SKILL\.md`$/m);
});

test("skills under the working directory render relative to it", () => {
	const home = homedir();
	const cwd = join(home, "projects/reeve");
	const prompt = build({
		cwd,
		skills: [
			skill({ name: "reeve", filePath: join(cwd, ".agents/skills/reeve/SKILL.md") }),
			skill({ name: "commit", filePath: join(home, ".pi/agent/skills/commit/SKILL.md") }),
		],
	});

	assert.match(prompt, /→ `\.agents\/skills\/reeve\/SKILL\.md`/);
	assert.match(prompt, /→ `~\/\.pi\/agent\/skills\/commit\/SKILL\.md`/);
	assert.ok(!prompt.includes(home), "no absolute home path survives in the prompt");
});

test("the read guideline documents home-relative paths", () => {
	assert.match(
		build(),
		/^- read: Paths beginning with `~\/` are supported; use them instead of guessing an absolute home directory\.$/m,
	);
	assert.doesNotMatch(build({ selectedTools: ["bash"] }), /Paths beginning with `~\//);
});

test("the commit guideline appears only when bash can make a commit", () => {
	assert.match(build(), /^- Use Conventional Commits when committing\.$/m);
	assert.doesNotMatch(build({ selectedTools: ["read"] }), /Conventional Commits/);
});

test("multi-line skill descriptions collapse to a single bullet", () => {
	const prompt = build({
		skills: [skill({ name: "humanizer", description: "First line.\n  Second   line.\n\nThird line." })],
	});

	assert.match(
		prompt,
		/^\* `humanizer` — First line\. Second line\. Third line\. → `\/skills\/humanizer\/SKILL\.md`$/m,
	);
});

test("skills that opted out of model invocation stay hidden", () => {
	const prompt = build({
		skills: [skill({ name: "visible" }), skill({ name: "hidden", disableModelInvocation: true })],
	});

	assert.match(prompt, /`visible`/);
	assert.doesNotMatch(prompt, /`hidden`/);
});

test("the skills section disappears without a file-reading tool", () => {
	const prompt = build({
		selectedTools: ["grep"],
		toolSnippets: { grep: "Grep contents" },
		skills: [skill({ name: "commit" })],
	});

	assert.match(prompt, /Available tools:/);
	assert.doesNotMatch(prompt, /^Skills:$/m);
});

test("bash alone is enough to advertise skills", () => {
	const prompt = build({ selectedTools: ["bash"], skills: [skill({ name: "commit" })] });

	assert.match(prompt, /^Skills:$/m);
});

test("the skills section collapses when nothing is loaded", () => {
	assert.doesNotMatch(build(), /^Skills:$/m);
	assert.doesNotMatch(build({ skills: [] }), /^Skills:$/m);
});

test("appended instructions are omitted when blank", () => {
	assert.doesNotMatch(build(), /APPENDED/);
	assert.doesNotMatch(build({ appendSystemPrompt: "   " }), /APPENDED/);

	const prompt = build({ appendSystemPrompt: "# Working principles\n\nBe careful." });
	assert.match(prompt, /^# Working principles\n\nBe careful\.$/m);
});

test("a fully populated prompt has no empty sections or doubled separators", () => {
	const prompt = build({
		appendSystemPrompt: "Appended.",
		contextFiles: [{ path: "/a/AGENTS.md", content: "Rules." }],
		skills: [skill({ name: "commit" })],
	});

	assert.doesNotMatch(prompt, /\n{3,}/);
	assert.doesNotMatch(prompt, /\n\n$/);
});

interface HarnessOptions {
	activeTools?: string[];
	initialBranch?: Entry[];
	/** Tool definitions as Pi would report them, including their own prompt guidelines. */
	tools?: Array<{ name: string; promptGuidelines?: string[] }>;
}

function createHarness(config: HarnessOptions = {}) {
	let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
	const pi = {
		registerCommand() {},
		on(name: string, registered: (event: unknown, ctx: unknown) => unknown) {
			if (name === "before_agent_start") handler = registered;
		},
		getActiveTools: () => [...(config.activeTools ?? ["read", "bash"])],
		getAllTools: () => config.tools ?? [],
	};
	const branch: Entry[] = config.initialBranch ?? [];
	const ctx = { sessionManager: { getBranch: () => branch } };
	systemPromptExtension(pi as never);

	return async (eventOptions: BuildSystemPromptOptions = options()) => {
		assert.ok(handler, "the extension registers a before_agent_start handler");
		const result = (await handler({ type: "before_agent_start", systemPromptOptions: eventOptions }, ctx)) as
			| { systemPrompt?: string }
			| undefined;
		return result?.systemPrompt;
	};
}

test("the extension replaces Pi's prompt", async () => {
	const run = createHarness();
	const prompt = await run();

	assert.ok(prompt);
	assert.match(prompt, /^You are an expert coding assistant that interacts with a computer\./);
});

test("the extension honors a custom system prompt from Pi's options", async () => {
	const run = createHarness();
	const prompt = await run(options({ customPrompt: "You are a terse shell operator." }));

	assert.match(prompt ?? "", /^You are a terse shell operator\.\n\nAvailable tools:/);
	assert.doesNotMatch(prompt ?? "", /expert coding assistant/);
});

test("the extension uses live active tools rather than the event's possibly stale list", async () => {
	// Pi only rebuilds its prompt options when tools change, so the event can still name tools
	// that a mode has since disabled.
	const run = createHarness({ activeTools: ["bash"] });
	const prompt = await run(
		options({
			selectedTools: ["read", "bash", "edit", "grep", "spawn_agent"],
			toolSnippets: {
				read: "Read file contents",
				bash: "Execute bash commands (ls, grep, find, etc.)",
				edit: "Make file edits",
				grep: "Grep contents",
				spawn_agent: "Spawn",
			},
		}),
	);

	assert.equal(section(prompt ?? "", "Available tools:"), "- bash: Execute bash commands (ls, rg, fd, etc.)");
});

test("the prompt renders the live tools' guidelines, attributed to their owner", async () => {
	const run = createHarness({
		activeTools: ["bash", "spawn_agent"],
		tools: [
			{ name: "bash", promptGuidelines: ["Use bash for file operations"] },
			{ name: "spawn_agent", promptGuidelines: ["Live-agent capacity is 10 root children total."] },
			// Registered but inactive, so its guideline cannot reach the prompt at all.
			{ name: "edit", promptGuidelines: ["Use edit for precise changes"] },
		],
	});
	const prompt = await run(
		options({
			selectedTools: ["bash", "spawn_agent"],
			promptGuidelines: [
				"Live-agent capacity is 10 root children total.",
				"Use edit for precise changes",
				"Use bash for file operations",
			],
		}),
	);

	assert.deepEqual(section(prompt ?? "", "Guidelines:")?.split("\n"), [
		"- The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it.",
		"- Use bash for file operations",
		"- spawn_agent: Live-agent capacity is 10 root children total.",
		"- Use Conventional Commits when committing.",
	]);
});

test("a tool disabled during this event drops its guidelines with it", async () => {
	// Minimal mode narrows the selection in this same event, after Pi captured the options, so the
	// options still carry both the tool and the guidelines that belong to it.
	const hint = "Live subagent models: fast → provider/cheap; you are running provider/strong.";
	const run = createHarness({
		activeTools: ["bash", "read", "edit"],
		tools: [
			{ name: "bash", promptGuidelines: ["Use bash for file operations"] },
			{ name: "spawn_agent", promptGuidelines: ["Live-agent capacity is 10 root children total.", hint] },
		],
	});
	const prompt = await run(
		options({
			selectedTools: ["bash", "read", "edit", "spawn_agent"],
			promptGuidelines: ["Live-agent capacity is 10 root children total.", hint, "Use bash for file operations"],
		}),
	);

	assert.deepEqual(section(prompt ?? "", "Guidelines:")?.split("\n"), [
		"- The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it.",
		"- Use bash for file operations",
		"- read: Paths beginning with `~/` are supported; use them instead of guessing an absolute home directory.",
		"- Use Conventional Commits when committing.",
	]);
});

test("minimal mode state no longer suppresses the replacement prompt", async () => {
	const run = createHarness({
		activeTools: ["bash"],
		initialBranch: [
			{
				type: "custom",
				customType: "minimal-mode-state",
				data: { version: 1, enabled: true, previousTools: ["read", "bash"] },
			},
		],
	});
	const prompt = await run(options({ selectedTools: ["bash"], toolSnippets: { bash: "Execute bash commands" } }));

	assert.match(prompt ?? "", /^You are an expert coding assistant that interacts with a computer\./);
	assert.equal(section(prompt ?? "", "Available tools:"), "- bash: Execute bash commands (ls, rg, fd, etc.)");
	assert.doesNotMatch(prompt ?? "", /exactly one bash tool call/);
});

interface CommandHarnessOptions {
	activeTools?: string[];
	hasUI?: boolean;
}

function createCommandHarness(config: CommandHarnessOptions = {}) {
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	const notifications: string[] = [];
	const previews: Array<{ title: string; text: string }> = [];
	const pi = {
		registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) {
			commands.set(name, command);
		},
		on() {},
		getActiveTools: () => [...(config.activeTools ?? ["read", "bash"])],
		getAllTools: () => [],
	};
	const ctx = {
		hasUI: config.hasUI ?? true,
		mode: "tui",
		cwd: "/workspace/project",
		sessionManager: { getBranch: () => [] },
		getSystemPromptOptions: () => options({ cwd: "/workspace/project", selectedTools: ["read", "bash"] }),
		ui: {
			notify: (message: string) => notifications.push(message),
			custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) => {
				const tui = { terminal: { rows: 24 }, requestRender: () => {} };
				const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
				const component = factory(tui, theme, undefined, () => {}) as { render(width: number): string[] };
				const lines = component.render(100);
				previews.push({ title: lines[0]?.trim() ?? "", text: lines.join("\n") });
				return undefined;
			},
		},
	};
	systemPromptExtension(pi as never);

	return {
		notifications,
		previews,
		async run(args: string) {
			const command = commands.get("systemprompt");
			assert.ok(command, "the systemprompt command is registered");
			await command.handler(args, ctx);
		},
	};
}

test("the command opens the rendered prompt in a read-only viewer", async () => {
	const harness = createCommandHarness();
	await harness.run("");

	assert.equal(harness.previews.length, 1);
	assert.match(harness.previews[0]?.title ?? "", /System prompt \(\d+ chars\)/);
	assert.match(harness.previews[0]?.text ?? "", /You are an expert coding assistant that interacts with a computer\./);
	assert.match(harness.previews[0]?.text ?? "", /enter esc close/);
});

test("the viewer never writes to the message composer", async () => {
	const harness = createCommandHarness();
	await harness.run("");

	// Regression: `ui.editor` prefills the chat input, which would send the prompt as a message.
	assert.equal("editor" in (harness as Record<string, unknown>), false);
});

test("passing a path writes the prompt instead of opening the editor", async () => {
	const harness = createCommandHarness();
	const target = join(tmpdir(), `pi-systemprompt-${process.pid}-${Date.now()}`, "prompt.txt");
	targets.push(target);

	await harness.run(target);

	assert.equal(harness.previews.length, 0);
	assert.match(harness.notifications.at(-1) ?? "", /Wrote \d+ chars/);
	assert.match(await readFile(target, "utf8"), /^You are an expert coding assistant that interacts with a computer\./);
});

test("a tilde path resolves under the home directory", async () => {
	const harness = createCommandHarness();
	await harness.run("~/nonexistent-dir-for-test");

	assert.match(harness.notifications.at(-1) ?? "", /nonexistent-dir-for-test/);
	assert.doesNotMatch(harness.notifications.at(-1) ?? "", /~\/nonexistent/);
});

test("without a UI the command reports the prompt size instead of opening an editor", async () => {
	const harness = createCommandHarness({ hasUI: false });
	await harness.run("");

	assert.equal(harness.previews.length, 0);
	assert.match(harness.notifications.at(-1) ?? "", /Current system prompt: \d+ chars/);
});

function createViewer(prompt: string, rows = 20) {
	let renders = 0;
	let closed = 0;
	const tui = {
		terminal: { rows },
		requestRender: () => {
			renders += 1;
		},
	};
	const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
	const viewer = new SystemPromptViewer({ label: "10 chars", prompt }, tui as never, theme, () => {
		closed += 1;
	});

	return {
		viewer,
		renders: () => renders,
		closed: () => closed,
		render: (width = 100) => viewer.render(width),
		footer: (width = 100) => viewer.render(width).at(-1) ?? "",
	};
}

test("the viewer shows a titled viewport plus a scroll footer", () => {
	const harness = createViewer("line one\n\nline two\n\nline three");
	const lines = harness.render();

	assert.equal(lines[0]?.trim(), "System prompt (10 chars)");
	assert.match(harness.footer(), /^ lines 1-\d+ of \d+ · /);
});

test("the viewer never exceeds the terminal height", () => {
	const long = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n\n");
	const lines = createViewer(long, 24).render();

	assert.ok(lines.length <= 24, `expected at most 24 lines, got ${lines.length}`);
	assert.match(lines.at(-1) ?? "", /of \d+ ·/);
});

test("page, home, and end keys move the viewport and request a render", () => {
	const long = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n\n");
	const harness = createViewer(long, 24);

	assert.match(harness.footer(), /lines 1-/);

	harness.viewer.handleInput("\u001b[6~"); // page down
	assert.match(harness.footer(), /lines 2[0-9]-/);
	assert.ok(harness.renders() > 0, "scrolling requests a render");

	harness.viewer.handleInput("\u001b[5~"); // page up
	assert.match(harness.footer(), /lines 1-/);

	harness.viewer.handleInput("\u001b[F"); // end
	const atEnd = harness.footer();
	assert.match(atEnd, /of \d+ ·/);
	harness.viewer.handleInput("\u001b[H"); // home
	assert.match(harness.footer(), /lines 1-/);
});

test("the viewport stops at the last page rather than scrolling past it", () => {
	const long = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n\n");
	const harness = createViewer(long, 24);

	harness.viewer.handleInput("\u001b[F");
	const total = Number(/of (\d+) ·/.exec(harness.footer())?.[1]);
	const end = Number(/-(\d+) of/.exec(harness.footer())?.[1]);
	assert.equal(end, total);

	harness.viewer.handleInput("\u001b[6~"); // page down again must not overshoot
	assert.equal(Number(/-(\d+) of/.exec(harness.footer())?.[1]), total);
});

test("enter and escape dismiss the viewer", () => {
	const enter = createViewer("text");
	enter.viewer.handleInput("\r");
	assert.equal(enter.closed(), 1);

	const escape = createViewer("text");
	escape.viewer.handleInput("\u001b");
	assert.equal(escape.closed(), 1);
});

test("unrelated keys neither close nor scroll the viewer", () => {
	const long = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n\n");
	const harness = createViewer(long, 24);
	const before = harness.footer();

	harness.viewer.handleInput("x");
	harness.viewer.handleInput("q");

	assert.equal(harness.closed(), 0);
	assert.equal(harness.footer(), before);
	assert.equal(harness.renders(), 0);
});

test("tool-delivered guidance survives this replacement, unlike an appended prompt block", () => {
	// The subagents extension publishes its capability hint as a spawn_agent guideline for exactly
	// this reason: a replacement prompt that drops appendSystemPrompt recipients still renders
	// per-tool guidelines, because the host rebuilds them from the live tool registry.
	const hint = "Live subagent models: fast → provider/cheap; you are running provider/strong.";
	const prompt = build({ promptGuidelines: ["Only tools rule", hint] });

	assert.match(prompt, /- Only tools rule/);
	assert.ok(prompt.includes(`- ${hint}`), "the hint appears as its own guideline bullet");
});

test("guidance disappears with its tool when a mode disables it", () => {
	// Minimal mode activates bash alone, so spawn_agent's guidelines are not rendered at all.
	const hint = "Live subagent models: fast → provider/cheap; you are running provider/strong.";
	const withTool = build({ selectedTools: ["bash", "spawn_agent"], promptGuidelines: [hint] });
	const withoutTool = build({ selectedTools: ["bash"], promptGuidelines: [] });

	assert.ok(withTool.includes(hint));
	assert.equal(withoutTool.includes(hint), false);
});

function skillsStateEntry(enabledNames: string[], knownNames = ["commit", "go-code"]): Entry {
	return { type: "custom", customType: "pi.skills.visibility", data: { version: 1, knownNames, enabledNames } };
}

test("skill visibility comes from the branch, not from the prompt options", async () => {
	const run = createHarness({ initialBranch: [skillsStateEntry(["commit"])] });
	const prompt = await run(
		options({ selectedTools: ["read", "bash"], skills: [skill({ name: "commit" }), skill({ name: "go-code" })] }),
	);

	assert.match(prompt ?? "", /`commit`/);
	assert.doesNotMatch(prompt ?? "", /`go-code`/, "a disabled skill must not be advertised");
});

test("a skill added after the selection was recorded stays enabled", async () => {
	const run = createHarness({ initialBranch: [skillsStateEntry([], ["commit"])] });
	const prompt = await run(
		options({ selectedTools: ["read", "bash"], skills: [skill({ name: "commit" }), skill({ name: "brand-new" })] }),
	);

	assert.doesNotMatch(prompt ?? "", /`commit`/);
	assert.match(prompt ?? "", /`brand-new`/, "unknown skills default to enabled");
});

test("a branch with no recorded selection advertises every model-visible skill", async () => {
	const run = createHarness();
	const prompt = await run(
		options({
			selectedTools: ["read", "bash"],
			skills: [skill({ name: "commit" }), skill({ name: "hidden", disableModelInvocation: true })],
		}),
	);

	assert.match(prompt ?? "", /`commit`/);
	assert.doesNotMatch(prompt ?? "", /`hidden`/);
});

test("filtering skills cannot resurrect a section hidden by tool availability", async () => {
	// Live active tools win over the event's list, so the harness must reflect the mode.
	const run = createHarness({ activeTools: ["grep"], initialBranch: [skillsStateEntry(["commit"])] });
	const prompt = await run(
		options({
			selectedTools: ["grep"],
			toolSnippets: { grep: "Grep contents" },
			skills: [skill({ name: "commit" })],
		}),
	);

	assert.doesNotMatch(prompt ?? "", /^Skills:$/m);
});
