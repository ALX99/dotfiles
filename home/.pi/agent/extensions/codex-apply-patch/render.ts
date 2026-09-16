import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { changeFailure, changeHeader, colorChange, plainChangeText } from "../_shared/change-render.ts";
import { renderToolStatus, type ToolStatusState } from "../_shared/tool-status.ts";
import type { ApplyPatchToolDetails } from "./types.ts";

const parameters = Type.Object({ patch: Type.String() });

/** Presentation only: Codex remains the validator; partial/malformed input stays expandable. */
function patchSummary(patch: string) {
	const files: string[] = [];
	let added = 0;
	let removed = 0;
	let deletes = 0;
	for (const line of patch.split("\n")) {
		const header = /^\*\*\* (Add|Update|Delete) File: (.*)$/.exec(line);
		if (header) {
			const operation = header[1] === "Add" ? "A" : header[1] === "Delete" ? "D" : "M";
			files.push(`${operation} ${header[2]}`);
			if (operation === "D") deletes++;
		} else if (line.startsWith("*** Move to: ")) {
			files.push(`  → ${line.slice(13)}`);
		} else if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const operations = files.filter((file) => !file.startsWith("  →"));
	const subject = operations.length === 1 ? operations[0]?.slice(2) : `${operations.length} files`;
	return {
		files,
		summary: `${subject} · patch lines +${added} −${removed}${deletes ? " · deletion lines unknown" : ""}`,
	};
}

export function patchRenderers(
	statusFor = renderToolStatus,
): Pick<
	ToolDefinition<typeof parameters, ApplyPatchToolDetails, ToolStatusState>,
	"renderCall" | "renderResult" | "renderShell"
> {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const patch = plainChangeText(args.patch ?? "");
			const { files, summary } = patchSummary(patch);
			const container = new Container();
			container.addChild(
				changeHeader(statusFor(theme, context), "patch", () => (context.isError ? "failed" : summary), theme),
			);
			if (context.expanded) {
				container.addChild(new Text(theme.fg("dim", "Patch input (not an applied-file diff)"), 0, 0));
				if (files.length) container.addChild(new Text(files.join("\n"), 0, 0));
				container.addChild(new Text(colorChange(patch, theme), 0, 0));
			}
			return container;
		},
		renderResult(result, { expanded }, theme, context) {
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (context.isError) return changeFailure(output, expanded, theme);
			return expanded ? new Text(theme.fg("toolOutput", plainChangeText(output)), 0, 0) : new Container();
		},
	};
}
