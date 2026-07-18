import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { parseJson } from "../_shared/json.ts";

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
