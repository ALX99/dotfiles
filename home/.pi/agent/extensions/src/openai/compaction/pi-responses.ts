import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

// Pi's jiti alias replaces the pi-ai root with compat.js, including subpath prefixes.
// Find the installed package through Node, then load its exported modules by absolute URL.
const packagePath = findPackageJSON("@earendil-works/pi-ai", import.meta.url);
if (packagePath === undefined) throw new Error("Could not locate Pi's Responses serializers.");
const packageUrl = pathToFileURL(packagePath);
const responses: typeof import("@earendil-works/pi-ai/api/openai-responses-shared") = await import(
	new URL("./dist/api/openai-responses-shared.js", packageUrl).href
);
const sampling: typeof import("@earendil-works/pi-ai/api/constrained-sampling") = await import(
	new URL("./dist/api/constrained-sampling.js", packageUrl).href
);
const transcript: typeof import("@earendil-works/pi-ai/utils/transcript") = await import(
	new URL("./dist/utils/transcript.js", packageUrl).href
);

export const { convertResponsesMessages, convertResponsesTools } = responses;
export const { createGrammarToolInputProperties } = sampling;
export const { getDeclaredTools, normalizeContext } = transcript;
