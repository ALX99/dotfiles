import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ScheduleContext = Pick<ExtensionContext, "hasUI" | "isIdle" | "ui">;

const UNITS = [
	{ suffix: "d", ms: 86_400_000 },
	{ suffix: "h", ms: 3_600_000 },
	{ suffix: "m", ms: 60_000 },
	{ suffix: "s", ms: 1_000 },
] as const;

const SEGMENT = new RegExp(`\\d+(${UNITS.map((unit) => unit.suffix).join("|")})`, "gu");

/** A leading token of digits followed by letters is a delay the user meant, even when it is malformed. */
const DELAY_SHAPED = /^\d+[a-z]+$/iu;

/** setTimeout fires immediately past this, so longer waits are re-armed one chunk at a time. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Starts an undelayed message verbatim, so a message may start with a delay-shaped token. */
const MESSAGE_ESCAPE = "--";

export interface ScheduleRequest {
	/** Empty when the command was invoked without a message, which reports the schedule instead. */
	readonly message: string;
	/** Undefined delivers as soon as the agent finishes. */
	readonly delayMs: number | undefined;
}

interface QueuedMessage {
	readonly message: string;
	readonly readyAt: number;
}

/** Parses `1h30m20s`, `3m`, `2s`, or `1h` into milliseconds, or undefined when the text is not a delay. */
export function parseDelay(text: string): number | undefined {
	let consumed = 0;
	let total = 0;
	for (const segment of text.matchAll(SEGMENT)) {
		if (segment.index !== consumed) return undefined;
		consumed += segment[0].length;
		const unit = UNITS.find((candidate) => segment[0].endsWith(candidate.suffix));
		if (unit === undefined) return undefined;
		total += Number(segment[0].slice(0, -unit.suffix.length)) * unit.ms;
	}
	return consumed === text.length && total > 0 ? total : undefined;
}

/** Renders a remaining delay the way it is written in a command, such as `1h 2m 5s`. */
export function formatDelay(ms: number): string {
	let seconds = Math.max(0, Math.ceil(ms / 1_000));
	const parts: string[] = [];
	for (const unit of UNITS) {
		const count = Math.floor(seconds / (unit.ms / 1_000));
		if (count === 0) continue;
		parts.push(`${count}${unit.suffix}`);
		seconds -= count * (unit.ms / 1_000);
	}
	return parts.join(" ") || "0s";
}

/** Splits an optional leading delay off the message. Throws with a user-facing message on a malformed delay. */
export function parseScheduleArgs(args: string): ScheduleRequest {
	const text = args.trim();
	if (text.startsWith(MESSAGE_ESCAPE)) {
		return { message: text.slice(MESSAGE_ESCAPE.length).trim(), delayMs: undefined };
	}

	const [first = "", ...rest] = text.split(/\s+/u);
	if (!DELAY_SHAPED.test(first)) return { message: text, delayMs: undefined };

	const delayMs = parseDelay(first);
	if (delayMs === undefined) {
		throw new Error(`"${first}" is not a delay. Write it as 1h30m20s, 3m, 2s, or 1h.`);
	}
	const message = rest.join(" ").trim();
	if (message === "") throw new Error("Add the message to send after the delay.");
	return { message, delayMs };
}

function notify(ctx: ScheduleContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function messageCount(count: number): string {
	return `${count} scheduled message${count === 1 ? "" : "s"}`;
}

export default function schedule(pi: ExtensionAPI): void {
	const queue: QueuedMessage[] = [];
	let awaitingSettlement = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clearTimer(): void {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	}

	/**
	 * Sends the head of the queue once it is due and the agent is idle, keeping FIFO order:
	 * a later message never overtakes an earlier one that is still waiting for its delay.
	 */
	function sendNext(ctx: ScheduleContext): "sent" | "waiting" | "failed" {
		const head = queue[0];
		if (awaitingSettlement || head === undefined || !ctx.isIdle() || head.readyAt > Date.now()) return "waiting";

		queue.shift();
		try {
			pi.sendUserMessage(head.message, { expandPromptTemplates: true });
			awaitingSettlement = true;
			return "sent";
		} catch (error) {
			queue.unshift(head);
			const detail = error instanceof Error ? error.message : String(error);
			notify(ctx, `Could not send the scheduled message: ${detail}`, "error");
			return "failed";
		}
	}

	function armTimer(ctx: ScheduleContext): void {
		clearTimer();
		if (awaitingSettlement) return;
		const head = queue[0];
		if (head === undefined) return;
		const remaining = head.readyAt - Date.now();
		// An already-due head goes out now, or on the next settlement when the agent is busy.
		if (remaining <= 0) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				pump(ctx);
			},
			Math.min(remaining, MAX_TIMEOUT_MS),
		);
	}

	function pump(ctx: ScheduleContext): "sent" | "waiting" | "failed" {
		const result = sendNext(ctx);
		armTimer(ctx);
		return result;
	}

	function status(ctx: ScheduleContext): void {
		const active = awaitingSettlement ? "One scheduled message is being handled." : "";
		if (queue.length === 0) {
			notify(ctx, [active, "No scheduled messages are waiting."].filter(Boolean).join(" "));
			return;
		}
		const remaining = (queue[0]?.readyAt ?? 0) - Date.now();
		const when = remaining > 0 ? `, next in ${formatDelay(remaining)}` : "";
		notify(ctx, [active, `${messageCount(queue.length)} waiting${when}.`].filter(Boolean).join(" "));
	}

	pi.registerCommand("sch", {
		description:
			"Schedule a message for when the agent finishes, or after a delay as in /sch 5m check the deploy; /sch alone shows the schedule",
		handler: async (args, ctx) => {
			let request: ScheduleRequest;
			try {
				request = parseScheduleArgs(args);
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
				return;
			}

			if (request.message === "") {
				status(ctx);
				return;
			}

			queue.push({ message: request.message, readyAt: Date.now() + (request.delayMs ?? 0) });
			const result = pump(ctx);
			if (result === "sent") {
				const waiting = queue.length === 0 ? "" : ` ${messageCount(queue.length)} remain queued.`;
				notify(ctx, `Agent is idle; sent the scheduled message.${waiting}`);
			} else if (result === "waiting") {
				const delay = request.delayMs === undefined ? "" : ` in ${formatDelay(request.delayMs)}`;
				notify(ctx, `Scheduled message${delay}. ${messageCount(queue.length)} waiting.`);
			}
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		awaitingSettlement = false;
		pump(ctx);
	});

	pi.on("session_start", () => {
		clearTimer();
		queue.length = 0;
		awaitingSettlement = false;
	});

	pi.on("session_shutdown", () => {
		clearTimer();
		queue.length = 0;
		awaitingSettlement = false;
	});
}
