import type {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	ReadToolDetails,
	ToolDefinition,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createToolStatus, renderToolStatus, runningSince, type ToolStatusState } from "../_shared/tool-status.ts";
import { changeFailure, changeHeader, colorChange, withToolDuration } from "../_shared/change-render.ts";

interface EditState extends ToolStatusState {
	summary?: string;
}

export function createCompactEdit(statusFor = renderToolStatus) {
	const definition: Pick<
		ToolDefinition<ReturnType<typeof createEditToolDefinition>["parameters"], EditToolDetails | undefined, EditState>,
		keyof ToolRenderers
	> = {
		renderShell: "self",
		renderCall(args, theme, context) {
			return changeHeader(
				statusFor(theme, context),
				`edit ${args.path ?? "…"}`,
				() => context.state.summary ?? "",
				theme,
				context.state,
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
	// Pi's renderer registry erases the parameter schema; this resolver is bound to edit calls.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return definition as unknown as ToolRenderers;
}

export function createCompactRead(native: ToolRenderers | undefined, statusFor = renderToolStatus) {
	const definition: Pick<
		ToolDefinition<ReturnType<typeof createReadToolDefinition>["parameters"], ReadToolDetails | undefined, EditState>,
		keyof ToolRenderers
	> = {
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
				context.state,
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
			if (!options.expanded) return new Container();
			if (native?.renderResult)
				return native.renderResult(result, options, theme, { ...context, lastComponent: undefined });
			return new Text(
				result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
				0,
				0,
			);
		},
	};
	// The resolver selects this typed renderer only for read calls.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return definition as unknown as ToolRenderers;
}

interface CompactBashState extends ToolStatusState {
	summary?: string;
}

function plain(text: string): string {
	return stripTerminalSequences(text)
		.replaceAll(/[^\P{Cc}\n\t]/gu, "")
		.replaceAll("\t", "    ");
}

export function createCompactBash(statusFor = renderToolStatus) {
	const definition: Pick<
		ToolDefinition<
			ReturnType<typeof createBashToolDefinition>["parameters"],
			BashToolDetails | undefined,
			CompactBashState
		>,
		keyof ToolRenderers
	> = {
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state;
			const command = plain(args.command ?? "");
			const status = statusFor(theme, context);
			return withToolDuration(
				{
					invalidate() {},
					render(width) {
						// Pi calls renderCall before renderResult; read the shared summary at paint time.
						const elapsed = context.isPartial ? runningSince(state) : undefined;
						const summary = state.summary ? `${state.summary}${elapsed === undefined ? "" : ` ${elapsed}`}` : undefined;
						const suffix = summary ? theme.fg("dim", ` · ${summary}`) : "";
						const title = (text: string) => theme.fg("toolTitle", theme.bold(text));
						if (context.expanded) {
							return new Text(`${status} ${title(`$ ${command}`)}${suffix}`, 0, 0).render(width);
						}
						const prefix = `${status} ${title("$ ")}`;
						const budget = width - visibleWidth(prefix) - visibleWidth(suffix);
						const compactCommand = command.replaceAll(/\s+/gu, " ").trim();
						if (budget < 4) return [truncateToWidth(prefix + title(compactCommand), width)];
						return [prefix + title(truncateToWidth(compactCommand, budget)) + suffix];
					},
				},
				state,
				theme,
			);
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
	// The resolver selects this typed renderer only for bash calls.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return definition as unknown as ToolRenderers;
}

export default function compact(pi: ExtensionAPI): void {
	const statusFor = createToolStatus(pi, ["bash", "edit", "read"]);
	pi.registerToolRenderer((name, next) => {
		switch (name) {
			case "bash":
				return createCompactBash(statusFor);
			case "edit":
				return createCompactEdit(statusFor);
			case "read":
				return createCompactRead(next(), statusFor);
			default:
				return next();
		}
	});
}
