/**
 * Keeps Pi's terminal title and, when present, its herdr pane label in sync.
 *
 * Pi overwrites its title while starting and when session information changes,
 * so terminal updates are delayed briefly. The pane label has no competing Pi
 * writer and is updated immediately.
 */

import { spawn } from "node:child_process";
import {
	VERSION,
	type ExtensionContext,
	type SessionInfoChangedEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { toError } from "../support/errors.ts";

export const TITLE_STARTUP_DELAY_MS = 500;
export const TITLE_UPDATE_DELAY_MS = 50;

export const MOODS: readonly string[] = [
	"(•̀ω•́)",
	"(≧◡≦)",
	"ᕕ( ᐛ )ᕗ",
	"(╯°□°)╯",
	"☆(•̀ω•́)☆",
	"(˘ω˘)",
	"(¬‿¬)",
	"(◡‿◡)",
	"(‐ω‐)",
	"(·ω·)",
	"(￣o￣)",
	"(－‿－)",
	"(:˘ω˘:)",
	"(˘‿˘)",
	"(∪ω∪)",
	"(o˘◡˘o)",
	"(☆ω☆)",
	"(✿◠‿◠)",
	"(◕‿◕)",
	"(ʘ‿ʘ)",
	"(─‿‿─)",
	"(≧ω≦)",
	"(￣▽￣)",
	"(⊙_⊙)",
	"(°o°)",
	"(◣_◢)",
	"(╥_╥)",
	"(T_T)",
	"(^_^)",
	"(>_<)",
	"(<_<)",
	"(¬_¬)",
	"(ಠ_ಠ)",
	"(ಥ_ಥ)",
	"(@_@)",
	"(*_*)",
	"(=^･ω･^=)",
	"(･∀･)",
	"(●∀●)",
	"(｀・ω・´)",
	"w(°ｏ°)w",
	"∑(O_O;)",
	"ʕ•ᴥ•ʔ",
	"(ᵔᴥᵔ)",
	"\\(•̀ᴗ•́)/",
	"~(•̀ᴗ•́)~",
	"★(•̀ω•́)★",
	"♪(•̀ω•́)♪",
	"✧(•̀ω•́)✧",
	"¯\\_(ツ)_/¯",
];

type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: { readonly stdio: "ignore" },
) => { once(event: "error", listener: (error: Error) => void): unknown };

function titleFor(mood: string): string {
	return `π ${mood} v${VERSION}`;
}

function setTitle(ctx: ExtensionContext, value: string): void {
	if (ctx.mode === "tui") process.stdout.write(`\x1b]2;${value}\x07`);
	else ctx.ui.setTitle(value);
}

/**
 * Clears the title as the process's very last write.
 *
 * Pi's own teardown sets the title it started with *after* the shutdown handlers run, so a clear
 * written from here is overwritten within the same tick and the old title is what survives. An exit
 * handler runs after all of that, which is the only point where the clear cannot be undone.
 */
function clearTitle(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return ctx.ui.setTitle("");
	process.once("exit", () => process.stdout.write("\x1b]2;\x07"));
}

export function createHerdrLabeler(
	paneId: string,
	bin: string,
	spawnProcess: SpawnProcess,
	onError: (error: Error) => void,
): { apply(label: string): void; clear(): void } {
	const rename = (...args: string[]): void => {
		try {
			spawnProcess(bin, ["pane", "rename", paneId, ...args], { stdio: "ignore" }).once("error", (error) =>
				onError(error ?? new Error("herdr pane rename emitted an error without details")),
			);
		} catch (error) {
			onError(toError(error));
		}
	};

	return {
		apply: (label) => rename(label),
		clear: () => rename("--clear"),
	};
}

export interface TitleEvents {
	readonly sessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => void;
	readonly sessionInfoChanged: (event: SessionInfoChangedEvent, ctx: ExtensionContext) => void;
	readonly turnStart: (event: TurnStartEvent, ctx: ExtensionContext) => void;
	readonly sessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => void;
}

export default function (): TitleEvents {
	const paneId = process.env.HERDR_PANE_ID;
	const labeler = paneId
		? createHerdrLabeler(paneId, process.env.HERDR_BIN_PATH ?? "herdr", spawn, (error) =>
				process.emitWarning(error, { type: "TitleError" }),
			)
		: undefined;
	let mood: string | undefined;
	let pending: NodeJS.Timeout | undefined;

	const cancelPending = (): void => {
		if (pending) clearTimeout(pending);
		pending = undefined;
	};
	const apply = (ctx: ExtensionContext): void => {
		if (mood) setTitle(ctx, titleFor(mood));
	};
	const schedule = (ctx: ExtensionContext, delay: number): void => {
		cancelPending();
		pending = setTimeout(() => {
			pending = undefined;
			apply(ctx);
		}, delay);
		pending.unref();
	};

	const sessionStart: TitleEvents["sessionStart"] = (_event, ctx) => {
		mood = MOODS[Math.floor(Math.random() * MOODS.length)]!;
		labeler?.apply(titleFor(mood));
		schedule(ctx, TITLE_STARTUP_DELAY_MS);
	};
	const sessionInfoChanged: TitleEvents["sessionInfoChanged"] = (_event, ctx) => schedule(ctx, TITLE_UPDATE_DELAY_MS);
	const turnStart: TitleEvents["turnStart"] = (_event, ctx) => {
		cancelPending();
		apply(ctx);
	};
	const sessionShutdown: TitleEvents["sessionShutdown"] = (_event, ctx) => {
		cancelPending();
		clearTitle(ctx);
		labeler?.clear();
	};

	return { sessionStart, sessionInfoChanged, turnStart, sessionShutdown };
}
