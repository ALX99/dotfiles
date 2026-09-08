/**
 * Keeps Pi's terminal title and, when present, its herdr pane label in sync.
 *
 * Pi overwrites its title while starting and when session information changes,
 * so terminal updates are delayed briefly. The pane label has no competing Pi
 * writer and is updated immediately.
 */

import { spawn } from "node:child_process";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toError } from "./_shared/errors.ts";

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

export default function (pi: ExtensionAPI) {
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

	pi.on("session_start", (_event, ctx) => {
		mood = MOODS[Math.floor(Math.random() * MOODS.length)]!;
		labeler?.apply(titleFor(mood));
		schedule(ctx, TITLE_STARTUP_DELAY_MS);
	});
	pi.on("session_info_changed", (_event, ctx) => schedule(ctx, TITLE_UPDATE_DELAY_MS));
	pi.on("turn_start", (_event, ctx) => {
		cancelPending();
		apply(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cancelPending();
		setTitle(ctx, "");
		labeler?.clear();
	});
}
