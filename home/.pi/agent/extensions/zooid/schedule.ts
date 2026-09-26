import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ScheduleContext = Pick<ExtensionContext, "hasUI" | "isIdle" | "ui">;

function notify(ctx: ScheduleContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function messageCount(count: number): string {
	return `${count} scheduled message${count === 1 ? "" : "s"}`;
}

export default function schedule(pi: ExtensionAPI): void {
	const messages: string[] = [];
	let awaitingSettlement = false;

	function sendNext(ctx: ScheduleContext): "sent" | "waiting" | "failed" {
		if (awaitingSettlement || messages.length === 0 || !ctx.isIdle()) return "waiting";

		const message = messages.shift()!;
		try {
			pi.sendUserMessage(message, { expandPromptTemplates: true });
			awaitingSettlement = true;
			return "sent";
		} catch (error) {
			messages.unshift(message);
			const detail = error instanceof Error ? error.message : String(error);
			notify(ctx, `Could not send the scheduled message: ${detail}`, "error");
			return "failed";
		}
	}

	pi.registerCommand("sch", {
		description: "Schedule a message to send after the agent finishes, or show the schedule with /sch",
		handler: async (args, ctx) => {
			const message = args.trim();
			if (message === "") {
				const active = awaitingSettlement ? "One scheduled message is being handled." : "";
				const pending =
					messages.length === 0 ? "No scheduled messages are waiting." : `${messageCount(messages.length)} waiting.`;
				notify(ctx, [active, pending].filter(Boolean).join(" "));
				return;
			}

			messages.push(message);
			const result = sendNext(ctx);
			if (result === "sent") {
				const waiting = messages.length === 0 ? "" : ` ${messageCount(messages.length)} remain queued.`;
				notify(ctx, `Agent is idle; sent the scheduled message.${waiting}`);
			} else if (result === "waiting") {
				notify(ctx, `Scheduled message. ${messageCount(messages.length)} waiting.`);
			}
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		awaitingSettlement = false;
		sendNext(ctx);
	});

	pi.on("session_start", () => {
		messages.length = 0;
		awaitingSettlement = false;
	});

	pi.on("session_shutdown", () => {
		messages.length = 0;
		awaitingSettlement = false;
	});
}
