import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface AgentActivity {
	startAgent(): void;
	stopAgent(): void;
	startPrompt(): void;
	stopPrompt(): void;
	reset(): void;
}

export interface AgentActivityOptions {
	readonly settleEvent: "agent_end" | "agent_settled";
	readonly onActiveChange: (active: boolean) => void;
}

/** Track agent work while suspending activity indicators during UI prompts. */
export function createAgentActivity(onActiveChange: (active: boolean) => void): AgentActivity {
	let agentActive = false;
	let promptActive = false;
	let active = false;

	const sync = (): void => {
		const next = agentActive && !promptActive;
		if (next === active) return;
		active = next;
		onActiveChange(next);
	};

	return {
		startAgent() {
			agentActive = true;
			sync();
		},
		stopAgent() {
			agentActive = false;
			sync();
		},
		startPrompt() {
			promptActive = true;
			sync();
		},
		stopPrompt() {
			promptActive = false;
			sync();
		},
		reset() {
			agentActive = false;
			promptActive = false;
			sync();
		},
	};
}

/** Register one lifecycle owner for indicators that follow agent activity. */
export function registerAgentActivity(pi: ExtensionAPI, options: AgentActivityOptions): void {
	const activity = createAgentActivity(options.onActiveChange);
	pi.on("session_start", () => activity.reset());
	pi.on("session_shutdown", () => activity.reset());
	pi.on("agent_start", () => activity.startAgent());
	if (options.settleEvent === "agent_end") {
		pi.on("agent_end", () => activity.stopAgent());
	} else {
		pi.on("agent_settled", () => activity.stopAgent());
	}
	pi.on("ui_prompt_start", () => activity.startPrompt());
	pi.on("ui_prompt_end", () => activity.stopPrompt());
}
