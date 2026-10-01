import { Result } from "effect";
import { HarnessError, MAX_ACTIVE_PROCEDURES, MAX_GUIDANCE_CHARS, type ProcedureSchema } from "./schema.ts";

export interface ProcedureEntry {
	readonly id: string;
	readonly procedure: typeof ProcedureSchema.Type;
}

/** Context is rebuilt from the current pool, never appended to a durable session message. */
export function renderGuidance(procedures: readonly Pick<ProcedureEntry, "procedure">[]): string {
	if (procedures.length === 0) return "";
	return [
		"Repository-scoped procedural guidance. Recheck applicability against the current task; it does not override user instructions or permissions.",
		...procedures.map(
			({ procedure }) =>
				`${procedure.title}\nWhen: ${procedure.trigger}\nDo: ${procedure.action}\nVerify: ${procedure.verify}\nDo not apply when: ${procedure.avoid}`,
		),
	].join("\n\n");
}

export function validateProcedurePool(pool: readonly ProcedureEntry[]): Result.Result<void, HarnessError> {
	if (pool.length > MAX_ACTIVE_PROCEDURES)
		return Result.fail(
			new HarnessError({ message: `The bounded active pool allows at most ${MAX_ACTIVE_PROCEDURES} procedures` }),
		);
	if (renderGuidance(pool).length > MAX_GUIDANCE_CHARS)
		return Result.fail(
			new HarnessError({
				message: `The bounded active guidance allows at most ${MAX_GUIDANCE_CHARS} characters`,
			}),
		);
	if (new Set(pool.map((entry) => entry.id)).size !== pool.length)
		return Result.fail(new HarnessError({ message: "Procedure IDs must be unique" }));
	if (new Set(pool.map((entry) => entry.procedure.behavior)).size !== pool.length)
		return Result.fail(new HarnessError({ message: "An active pool allows only one procedure per behavior" }));
	return Result.succeed(undefined);
}

export function candidateProcedureIds(
	pool: readonly ProcedureEntry[],
	candidate: ProcedureEntry & { readonly replaces: string | null },
): Result.Result<readonly string[], HarnessError> {
	const matching = pool.find((entry) => entry.procedure.behavior === candidate.procedure.behavior);
	if ((matching?.id ?? null) !== candidate.replaces)
		return Result.fail(
			new HarnessError({ message: "Proposal must explicitly replace the active procedure for its behavior" }),
		);
	const next = [...pool.filter((entry) => entry.id !== candidate.replaces), candidate];
	return validateProcedurePool(next).pipe(Result.map(() => next.map((entry) => entry.id)));
}

/** Cosmetic titles do not make a rejected or active procedure a new hypothesis. */
export function sameProcedure(left: ProcedureEntry, right: ProcedureEntry): boolean {
	const keys = ["behavior", "trigger", "action", "verify", "avoid"] as const;
	return keys.every(
		(key) => normalizeProcedureText(left.procedure[key]) === normalizeProcedureText(right.procedure[key]),
	);
}

function normalizeProcedureText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ");
}
