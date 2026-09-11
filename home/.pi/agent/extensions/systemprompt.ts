import * as os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, type TUI } from "@earendil-works/pi-tui";

import { enabledModelSkillNames } from "./skills/index.ts";

/** Host fields matching mini-swe-agent's `platform.uname()` template variables. */
export interface HostInformation {
	system: string;
	release: string;
	version: string;
	machine: string;
}

export function hostInformation(): HostInformation {
	return { system: os.type(), release: os.release(), version: os.version(), machine: os.machine() };
}

/** Prompt paths read better relative to home, which the host line reports for the same machine. */
export function tildePath(path: string, home: string = os.homedir()): string {
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const ROLE_LINE =
	"You are an expert coding assistant that interacts with a computer. Use the tools available to you to achieve the goal efficiently.";

const SKILL_INSTRUCTIONS =
	"Use the list below to identify relevant skills. Read a skill's `SKILL.md` only when its instructions are needed for the current task. Multiple skills may apply. Resolve paths referenced by a skill relative to the directory containing its `SKILL.md`.";

const READ_PATH_GUIDELINE =
	"read: Paths beginning with `~/` are supported; use them instead of guessing an absolute home directory.";

const CONVENTIONAL_COMMITS_GUIDELINE = "Use Conventional Commits when committing.";

/**
 * Pi's built-in bash snippet names the search tools the model would otherwise reach for in a shell.
 * This host installs ripgrep and fd, so the catalog names those instead. Keys win over the snippet
 * Pi derives from the live tool definition.
 */
const TOOL_SNIPPET_OVERRIDES: Record<string, string> = {
	bash: "Execute bash commands (ls, rg, fd, etc.)",
};

function toolBlock(options: BuildSystemPromptOptions): string {
	const snippets = options.toolSnippets ?? {};
	const lines = (options.selectedTools ?? []).flatMap((name) => {
		const snippet = TOOL_SNIPPET_OVERRIDES[name] ?? snippets[name];
		return snippet === undefined || snippet.length === 0 ? [] : [`- ${name}: ${snippet}`];
	});
	return `Available tools:\n${lines.length > 0 ? lines.join("\n") : "(none)"}`;
}

/**
 * Pi's shell tools contribute this guideline alongside the PI_* variables they export for bash.
 * The variables stay; only the per-prompt reminder is dropped.
 */
const SUPPRESSED_GUIDELINES = new Set([
	"You can inspect PI_* environment variables for current model and session details.",
]);

/** The slice of the host tool registry that guideline attribution needs. */
export interface GuidelineToolSource {
	getActiveTools(): string[];
	getAllTools(): Array<{ name: string; promptGuidelines?: readonly string[] }>;
}

/**
 * Maps every guideline to the active tool that declared it. Pi flattens the per-tool guidelines into
 * one list, so a rule that never names its tool is otherwise indistinguishable from a global rule.
 * The insertion order also reproduces the list Pi builds for the same selection, so the map is the
 * live guideline list as well as the attribution source.
 */
export function guidelineOwners(pi: GuidelineToolSource): ReadonlyMap<string, string> {
	const definitions = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const owners = new Map<string, string>();
	for (const name of pi.getActiveTools()) {
		for (const guideline of definitions.get(name)?.promptGuidelines ?? []) {
			const trimmed = guideline.trim();
			// Pi keeps the first declaration of a duplicated guideline, so the owner does too.
			if (trimmed.length > 0 && !owners.has(trimmed)) owners.set(trimmed, name);
		}
	}
	return owners;
}

/**
 * Names the owning tool unless the rule already names it, so rules that read as global get
 * attributed while rules like "Use edit for precise changes" do not repeat themselves.
 */
export function attributeGuideline(guideline: string, owners?: ReadonlyMap<string, string>): string {
	const tool = owners?.get(guideline);
	if (tool === undefined || namesTool(guideline, tool)) return guideline;
	return `${tool}: ${guideline}`;
}

/** A tool name counts as named when it appears as a whole word, plurals and inflections included. */
function namesTool(guideline: string, tool: string): boolean {
	return new RegExp(`\\b${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*`, "i").test(guideline);
}

/** Pi already stripped blanks and duplicates before handing the per-tool guidelines over. */
function guidelineBlock(options: BuildSystemPromptOptions, owners?: ReadonlyMap<string, string>): string {
	// The user's standing communication preference, so it leads the list whatever tools are active.
	const guidelines = new Set([
		"The reader has ADHD. Output not just brief information, but shape it so an ADHD brain can act on it.",
		...(options.promptGuidelines ?? []).map((guideline) => guideline.trim()),
	]);
	if ((options.selectedTools ?? []).includes("read")) guidelines.add(READ_PATH_GUIDELINE);
	// Commits go through bash, so the rule is dead weight without it.
	if ((options.selectedTools ?? []).includes("bash")) guidelines.add(CONVENTIONAL_COMMITS_GUIDELINE);
	const lines = [...guidelines]
		.filter((guideline) => guideline.length > 0 && !SUPPRESSED_GUIDELINES.has(guideline))
		.map((guideline) => `- ${attributeGuideline(guideline, owners)}`);
	return `Guidelines:\n${lines.length > 0 ? lines.join("\n") : "(none)"}`;
}

function contextBlock(contextFiles: BuildSystemPromptOptions["contextFiles"]): string {
	if (contextFiles === undefined || contextFiles.length === 0) return "";
	const instructions = contextFiles
		.map(
			(file) =>
				`<project_instructions path="${tildePath(file.path)}">\n${file.content.trim()}\n</project_instructions>`,
		)
		.join("\n\n");
	return `<project_context>\n${instructions}\n</project_context>`;
}

/**
 * A skill list is only useful when the model can open the files it points at. Pi applies the same
 * gate, and both skip skills that opted out of model invocation.
 */
function skillBlock(options: BuildSystemPromptOptions, enabledNames?: ReadonlySet<string>): string {
	const tools = options.selectedTools ?? [];
	if (!tools.includes("read") && !tools.includes("bash")) return "";
	const entries = (options.skills ?? [])
		.filter((skill) => !skill.disableModelInvocation && (enabledNames === undefined || enabledNames.has(skill.name)))
		.map(
			(skill) =>
				`* \`${skill.name}\` — ${skill.description.replace(/\s+/g, " ").trim()} → \`${tildePath(skill.filePath)}\``,
		);
	return entries.length === 0 ? "" : `Skills:\n\n${SKILL_INSTRUCTIONS}\n\n${entries.join("\n")}`;
}

/**
 * Renders the replacement prompt. A user-supplied custom prompt replaces the role statement only:
 * the other sections carry the live tools, guidelines, and skills this renderer owns, so they stay
 * even then.
 */
export function buildSystemPrompt(
	options: BuildSystemPromptOptions,
	host: HostInformation = hostInformation(),
	enabledSkills?: ReadonlySet<string>,
	owners?: ReadonlyMap<string, string>,
): string {
	const uname = [host.system, host.release, host.version, host.machine].join(" ");
	return [
		options.customPrompt?.trim() || ROLE_LINE,
		toolBlock(options),
		guidelineBlock(options, owners),
		skillBlock(options, enabledSkills),
		`System Information\n- Host: ${uname}\n- Working directory: ${tildePath(options.cwd)}`,
		options.appendSystemPrompt?.trim() ?? "",
		contextBlock(options.contextFiles),
	]
		.filter((section) => section.length > 0)
		.join("\n\n");
}

export default function systemPromptExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: currentPrompt(pi, ctx, event.systemPromptOptions),
	}));

	pi.registerCommand("systemprompt", {
		description: "Show the system prompt the next turn will send, or write it to a file via /systemprompt <path>",
		handler: async (args, ctx) => {
			const prompt = currentPrompt(pi, ctx, ctx.getSystemPromptOptions());
			const label = `${prompt.length} chars`;
			const target = resolveTarget(args.trim());
			if (target !== undefined) {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, prompt, "utf8");
				ctx.ui.notify(`Wrote ${label} to ${target}`, "info");
			} else if (!ctx.hasUI || ctx.mode !== "tui") {
				// Without the TUI there is no viewer, so report the size and point at the file option.
				ctx.ui.notify(`Current system prompt: ${label}. Pass a path to write it to a file.`, "info");
			} else {
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => new SystemPromptViewer({ label, prompt }, tui, theme, done),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
				);
			}
		},
	});
}

// The overlay is sized to the full terminal, so the viewport claims every row it is given.
const VIEW_FIXED_LINES = 2;

/**
 * Renders the prompt as markdown in a fixed-height, scrollable viewport. The host slices an overlay
 * to `maxHeight` only after `render`, and Pi's `ScrollView` needs a layout pass the overlay path
 * never runs, so the component slices its own lines.
 */
export class SystemPromptViewer {
	private readonly body: Markdown;
	private readonly label: string;
	private readonly theme: Pick<Theme, "bold" | "fg">;
	private readonly tui: TUI;
	private readonly done: () => void;
	private offset = 0;
	private viewport = 1;

	constructor(view: { label: string; prompt: string }, tui: TUI, theme: Pick<Theme, "bold" | "fg">, done: () => void) {
		this.body = new Markdown(view.prompt, 1, 0, getMarkdownTheme());
		this.label = view.label;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	invalidate(): void {
		this.body.invalidate();
	}

	render(width: number): string[] {
		const bodyLines = this.body.render(width);
		const viewport = Math.max(1, this.tui.terminal.rows - VIEW_FIXED_LINES);
		this.viewport = viewport;
		this.offset = Math.max(0, Math.min(this.offset, bodyLines.length - viewport));
		const end = Math.min(this.offset + viewport, bodyLines.length);
		return [
			` ${this.theme.fg("accent", this.theme.bold(`System prompt (${this.label})`))}`,
			...bodyLines.slice(this.offset, end),
			this.theme.fg(
				"dim",
				` lines ${this.offset + 1}-${end} of ${bodyLines.length} · ↑↓ pgup pgdn home end scroll · enter esc close`,
			),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up)) this.offset -= 1;
		else if (matchesKey(data, Key.down)) this.offset += 1;
		else if (matchesKey(data, Key.pageUp)) this.offset -= this.viewport;
		else if (matchesKey(data, Key.pageDown)) this.offset += this.viewport;
		else if (matchesKey(data, Key.home)) this.offset = 0;
		else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
		else return;
		this.tui.requestRender();
	}
}

/**
 * The prompt the next turn will send, derived from live session state rather than the last turn.
 * Pi rebuilds its prompt options only when tools change, and it hands every handler the options it
 * captured before the chain ran, so a mode that narrows the selection during this event leaves them
 * naming tools the model cannot call. The selection and its guidelines are therefore read from the
 * live registry here. The rest of the options stay as given: the host exposes normalized tool
 * snippets only through them. `/skills` records its selection in session entries rather than in
 * those options, so it is read separately.
 */
function currentPrompt(pi: ExtensionAPI, ctx: ExtensionContext, options: BuildSystemPromptOptions): string {
	const owners = guidelineOwners(pi);
	const live: BuildSystemPromptOptions = {
		...options,
		selectedTools: pi.getActiveTools(),
		promptGuidelines: [...owners.keys()],
	};
	return buildSystemPrompt(live, hostInformation(), enabledModelSkillNames(ctx, live.skills ?? []), owners);
}

/** Accepts a relative path, an absolute path, or a `~`-rooted path. */
function resolveTarget(input: string): string | undefined {
	if (input.length === 0) return undefined;
	if (input === "~" || input.startsWith("~/")) return join(os.homedir(), input.slice(2));
	return input;
}
