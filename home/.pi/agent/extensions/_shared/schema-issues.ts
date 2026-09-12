import { Schema, SchemaIssue } from "effect";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Flatten a schema parse failure into `source: path: message` diagnostics.
 * Every failing leaf is reported, so a bad configuration can be corrected in one pass.
 */
export function formatSchemaFailure(source: string, failure: Schema.SchemaError): string[] {
	return formatIssues(failure.issue).issues.map((issue) => {
		const path = flattenPath(issue.path);
		return `${source}: ${path.length ? `${path.join(".")}: ` : ""}${issue.message}`;
	});
}

/** Standard Schema allows `{ key }` segments; schema paths are otherwise plain property keys. */
function flattenPath(path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined): PropertyKey[] {
	return (path ?? []).map((segment) => (typeof segment === "object" && segment !== null ? segment.key : segment));
}
