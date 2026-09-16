import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	SettingsManager,
	type BashToolDetails,
	type EditToolDetails,
	type ExtensionAPI,
	type ReadToolDetails,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { runPromise } from "../_shared/effect-runtime.ts";
import { createToolStatus, renderToolStatus, type ToolStatusState } from "../_shared/tool-status.ts";
import { changeFailure, changeHeader, colorChange } from "../_shared/change-render.ts";

interface EditState extends ToolStatusState {
	summary?: string;
}

export function createCompactEdit(statusFor = renderToolStatus) {
	const builtin = createEditToolDefinition(process.cwd());
	const definition: ToolDefinition<typeof builtin.parameters, EditToolDetails | undefined, EditState> = {
		...builtin,
		renderShell: "self",
		renderCall(args, theme, context) {
			return changeHeader(
				statusFor(theme, context),
				`edit ${args.path ?? "…"}`,
				() => context.state.summary ?? "",
				theme,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const diff = result.details?.diff;
			const lines = diff?.split("\n") ?? [];
			// Pi's display diff prefixes changed lines with +/- and their line number.
			const added = lines.filter((line) => line.startsWith("+")).length;
			const removed = lines.filter((line) => line.startsWith("-")).length;
			context.state.summary = context.isError
				? "failed"
				: isPartial
					? "applying"
					: diff === undefined
						? "done"
						: `+${added} −${removed}`;
			if (context.isError) return changeFailure(output, expanded, theme);
			if (!expanded) return new Container();
			return new Text(diff === undefined ? output : colorChange(diff, theme), 0, 0);
		},
	};
	return definition;
}

export function createCompactRead(statusFor = renderToolStatus) {
	const builtin = createReadToolDefinition(process.cwd());
	const definition: ToolDefinition<typeof builtin.parameters, ReadToolDetails | undefined, EditState> = {
		...builtin,
		renderShell: "self",
		renderCall(args, theme, context) {
			// These are the requested bounds, not a claim about how many lines were returned.
			const bounds = [
				args.offset === undefined ? "" : `from ${args.offset}`,
				args.limit === undefined ? "" : `limit ${args.limit}`,
			];
			return changeHeader(
				statusFor(theme, context),
				`read ${args.path ?? "…"}`,
				() => [...bounds, context.state.summary].filter(Boolean).join(" · "),
				theme,
			);
		},
		renderResult(result, options, theme, context) {
			const truncation = result.details?.truncation;
			context.state.summary = context.isError
				? "failed"
				: options.isPartial
					? "reading"
					: truncation?.firstLineExceedsLimit
						? "line exceeds read limit"
						: truncation?.truncated
							? "truncated"
							: result.content.some((part) => part.type === "image")
								? "image"
								: "";
			if (context.isError) {
				const output = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				return changeFailure(output, options.expanded, theme);
			}
			// Retain native syntax highlighting and continuation notices. Pi owns image components.
			return options.expanded
				? builtin.renderResult!(result, options, theme, { ...context, lastComponent: undefined })
				: new Container();
		},
	};
	return definition;
}

interface CompactBashState {
	summary?: string;
	frame?: number;
}

function plain(text: string): string {
	return stripTerminalSequences(text)
		.replaceAll(/[^\P{Cc}\n\t]/gu, "")
		.replaceAll("\t", "    ");
}

export default function compactBash(pi: ExtensionAPI): void {
	const statusFor = createToolStatus(pi);
	pi.registerTool(createCompactEdit(statusFor));
	pi.registerTool(createCompactRead(statusFor));

	const builtin = createBashToolDefinition(process.cwd());
	const definition: ToolDefinition<typeof builtin.parameters, BashToolDetails | undefined, CompactBashState> = {
		...builtin,
		renderShell: "self",
		async execute(id, args, signal, onUpdate, ctx) {
			// Keep Pi's shell settings and current working directory when delegating.
			const settings = await runPromise(
				Effect.sync(() =>
					SettingsManager.create(ctx.cwd, undefined, {
						projectTrusted: ctx.isProjectTrusted(),
					}),
				),
			);
			const shellPath = settings.getShellPath();
			const commandPrefix = settings.getShellCommandPrefix();
			return createBashToolDefinition(ctx.cwd, {
				...(shellPath !== undefined && { shellPath }),
				...(commandPrefix !== undefined && { commandPrefix }),
			}).execute(id, args, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const state = context.state;
			const command = plain(args.command ?? "");
			const status = statusFor(theme, context);
			return {
				invalidate() {},
				render(width) {
					// Pi calls renderCall before renderResult; read the shared summary at paint time.
					const suffix = state.summary ? theme.fg("dim", ` · ${state.summary}`) : "";
					const title = (text: string) => theme.fg("toolTitle", theme.bold(text));
					if (context.expanded) {
						return new Text(`${status} ${title(`$ ${command}`)}${suffix}`, 0, 0).render(width);
					}
					const prefix = `${status} ${title("$ ")}`;
					const budget = width - visibleWidth(prefix) - visibleWidth(suffix);
					const compact = command.replaceAll(/\s+/gu, " ").trim();
					if (budget < 4) return [truncateToWidth(prefix + title(compact), width)];
					return [prefix + title(truncateToWidth(compact, budget)) + suffix];
				},
			};
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const state = context.state;
			const output = plain(
				result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
			).trimEnd();
			const lines = output === "" || output === "(no output)" ? [] : output.split("\n");
			const details = result.details;
			const count = details?.truncation?.totalLines ?? lines.length;
			state.summary = isPartial
				? "running"
				: context.isError
					? "failed"
					: count === 0
						? "no output"
						: `${count} ${count === 1 ? "line" : "lines"}`;
			if (details?.truncation?.truncated) state.summary += " · truncated";
			if (expanded) return output ? new Text(theme.fg("toolOutput", output), 0, 0) : new Container();
			if (!context.isError) return new Container();
			// The tail includes Pi's exit/timeout/abort diagnostic, not just command output.
			const excerpt = lines.filter((line) => line.trim() !== "").slice(-3);
			return {
				invalidate() {},
				render: (width) => excerpt.map((line) => truncateToWidth(theme.fg("error", `  ${line}`), width)),
			};
		},
	};
	pi.registerTool(definition);
}
