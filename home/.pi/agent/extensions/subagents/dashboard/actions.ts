import type { AgentStatus, AgentSummary } from "../agent-types.ts";

export type DashboardOperation =
	| { readonly kind: "steer"; readonly agentId: string }
	| { readonly kind: "followUp"; readonly agentId: string }
	| { readonly kind: "interrupt"; readonly agentId: string }
	| { readonly kind: "close"; readonly agentId: string }
	| { readonly kind: "jump"; readonly agentId: string }
	| { readonly kind: "dismiss" };

export interface AllowedDashboardActions {
	readonly steer: boolean;
	readonly followUp: boolean;
	readonly interrupt: boolean;
	readonly close: boolean;
	readonly jump: boolean;
}

export function allowedDashboardActions(summary: AgentSummary): AllowedDashboardActions {
	const active = isActiveStatus(summary.status);
	return {
		steer: active,
		followUp: isFollowUpStatus(summary.status),
		interrupt: active,
		close: summary.status !== "closed",
		jump: !active && Boolean(summary.session_file),
	};
}

export function operationForKey(key: string, summary: AgentSummary): DashboardOperation | undefined {
	const allowed = allowedDashboardActions(summary);
	const agentId = summary.agent_id;
	if (key === "s" && allowed.steer) return { kind: "steer", agentId };
	if (key === "f" && allowed.followUp) return { kind: "followUp", agentId };
	if (key === "x" && allowed.interrupt) return { kind: "interrupt", agentId };
	if (key === "d" && allowed.close) return { kind: "close", agentId };
	if (key === "j" && allowed.jump) return { kind: "jump", agentId };
	return undefined;
}

export function isActiveStatus(status: AgentStatus): boolean {
	return status === "starting" || status === "running";
}

function isFollowUpStatus(status: AgentStatus): boolean {
	return status === "idle" || status === "failed" || status === "aborted";
}
