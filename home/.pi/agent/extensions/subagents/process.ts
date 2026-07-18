/** Compatibility facade for child context, invocation, and run folding. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { parseJson } from "../_shared/json.ts";
import { parseAgentEvent } from "./event-schema.ts";
import { OutputSpool } from "./output-spool.ts";
import { foldAgentEvent, type MutableRunState } from "./run-state.ts";

export {
	argsPreview,
	foldAgentEvent,
	initRunState as initDetails,
	snapshotRunState,
	type InitRunDetailsParams,
	type MutableRunState,
	type NestedRunDetails,
	type NestedRunStatus,
	type ReadonlyNestedRunDetails,
	type RunDetails,
	type ReadonlyRunDetails,
	type RunStatus,
	type RunUsage,
} from "./run-state.ts";

export const CHILD_CONTEXT_ENV = "PI_SUBAGENT_CONTEXT";
export const MAX_DELEGATION_DEPTH = 2;

const ChildExecutionContextSchema = z.strictObject({
	treeId: z.string().trim().min(1),
	depth: z.number().int().min(1).max(MAX_DELEGATION_DEPTH),
	agent: z.string().trim().min(1),
	profile: z.string().trim().min(1),
	delegationCredits: z.number().int().min(0),
});

export type ChildExecutionContext = Readonly<z.infer<typeof ChildExecutionContextSchema>>;

export function parseChildExecutionContext(value = process.env[CHILD_CONTEXT_ENV]): ChildExecutionContext | undefined {
	if (value === undefined) return undefined;
	const json = parseJson(value, CHILD_CONTEXT_ENV);
	if (!json.ok) throw new Error(`Invalid ${json.diagnostic.message}.`, { cause: json.diagnostic.cause });
	const parsed = ChildExecutionContextSchema.safeParse(json.value);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid ${CHILD_CONTEXT_ENV}: ${issues}.`);
	}
	return Object.freeze(parsed.data);
}

export function serializeChildExecutionContext(context: ChildExecutionContext): string {
	return JSON.stringify(ChildExecutionContextSchema.parse(context));
}

export async function writeTempPrompt(
	agentName: string,
	systemPrompt: string,
): Promise<{ readonly dir: string; readonly path: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeName}.md`);
	try {
		await fs.promises.writeFile(filePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
		return { dir, path: filePath };
	} catch (error) {
		await fs.promises.rm(dir, { recursive: true, force: true });
		throw error;
	}
}

/** Legacy line adapter used by tests and older callers. New transport callers
 * pass parsed AgentEvent values directly to foldAgentEvent(). */
export async function ingestLine(
	line: string,
	details: MutableRunState,
	output = legacyOutputs.get(details) ?? new OutputSpool(),
): Promise<void> {
	legacyOutputs.set(details, output);
	if (!line.trim()) return;
	const json = parseJson(line, "subagent event");
	if (!json.ok) return;
	const parsed = parseAgentEvent(json.value);
	if (parsed.kind !== "event") return;
	await foldAgentEvent(parsed.event, details, output);
}

const legacyOutputs = new WeakMap<MutableRunState, OutputSpool>();

/** Pick the runtime: re-exec the current script if it is a real file, else pi. */
export function getPiInvocation(args: readonly string[]): { readonly command: string; readonly args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.exec(execName);
	if (!isGenericRuntime) return { command: process.execPath, args: [...args] };
	return { command: "pi", args: [...args] };
}
