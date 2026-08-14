import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CommandResult = {
	readonly code: number | null;
	readonly stderr: string;
	readonly stdout: string;
};

type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>;

type WorktreeCommandContext = {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly sessionManager: {
		getSessionFile(): string | undefined;
	};
	readonly ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
	shutdown(): void;
};

type WorktreeTarget = {
	readonly paneId: string;
	readonly workspaceId: string;
};

function notify(ctx: WorktreeCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function commandFailure(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exited with status ${result.code ?? "unknown"}`;
}

function parseWorktreeTarget(output: string): WorktreeTarget | undefined {
	let response: unknown;
	try {
		response = JSON.parse(output);
	} catch {
		return undefined;
	}

	if (response === null || typeof response !== "object") return undefined;
	const result = (response as { result?: unknown }).result;
	if (result === null || typeof result !== "object") return undefined;

	const workspace = (result as { workspace?: unknown }).workspace;
	const rootPane = (result as { root_pane?: unknown }).root_pane;
	if (workspace === null || typeof workspace !== "object" || rootPane === null || typeof rootPane !== "object") {
		return undefined;
	}

	const workspaceId = (workspace as { workspace_id?: unknown }).workspace_id;
	const paneId = (rootPane as { pane_id?: unknown }).pane_id;
	if (typeof workspaceId !== "string" || typeof paneId !== "string") return undefined;

	return { workspaceId, paneId };
}

export function quoteShellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function moveSessionToWorktree(
	name: string,
	ctx: WorktreeCommandContext,
	run: RunCommand,
	herdrEnabled: boolean,
): Promise<void> {
	const branch = name.trim();
	if (!herdrEnabled) {
		notify(ctx, "/wt requires Pi to run inside Herdr.", "error");
		return;
	}

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile === undefined) {
		notify(ctx, "/wt cannot move an ephemeral Pi session.", "error");
		return;
	}

	const createArgs = ["worktree", "create", "--cwd", ctx.cwd];
	if (branch) createArgs.push("--branch", branch, "--label", branch);
	createArgs.push("--no-focus");

	const created = await run("herdr", createArgs);
	if (created.code !== 0) {
		notify(ctx, `Herdr could not create a worktree: ${commandFailure(created)}`, "error");
		return;
	}

	const target = parseWorktreeTarget(created.stdout);
	if (target === undefined) {
		notify(ctx, "Herdr returned no worktree workspace.", "error");
		return;
	}

	const started = await run("herdr", ["pane", "run", target.paneId, `pi --session ${quoteShellArgument(sessionFile)}`]);
	if (started.code !== 0) {
		notify(ctx, `Herdr could not start Pi in the worktree: ${commandFailure(started)}`, "error");
		return;
	}

	const focused = await run("herdr", ["workspace", "focus", target.workspaceId]);
	if (focused.code !== 0) {
		notify(ctx, `Pi started in the worktree, but Herdr could not focus it: ${commandFailure(focused)}`, "warning");
		return;
	}

	notify(ctx, branch ? `Moved Pi to Herdr worktree ${branch}.` : "Moved Pi to a Herdr-generated worktree.", "info");
	ctx.shutdown();
}

export default function worktreeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("wt", {
		description: "Create a Herdr worktree and continue this Pi session there; name is optional",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			try {
				await moveSessionToWorktree(
					args,
					ctx,
					(command, commandArgs) => pi.exec(command, [...commandArgs]),
					process.env.HERDR_ENV === "1",
				);
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Herdr worktree failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		},
	});
}
