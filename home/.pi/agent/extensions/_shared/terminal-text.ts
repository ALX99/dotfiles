import { truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(value: string): string[] {
	return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function replaceTerminalControls(value: string, tabWidth: number): string {
	let safe = "";
	for (const character of stripVTControlCharacters(value)) {
		const code = character.codePointAt(0) ?? 0;
		if (character === "\t") safe += " ".repeat(tabWidth);
		else if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) safe += " ";
		else safe += character;
	}
	return safe;
}

/** Sanitize one terminal row while preserving ordinary spaces. */
export function sanitizeTerminalLine(value: string, tabWidth = 4): string {
	return replaceTerminalControls(value, Math.max(0, tabWidth));
}

/** Sanitize untrusted terminal text and flatten it to one normalized row. */
export function sanitizeTerminalText(value: string): string {
	return replaceTerminalControls(value, 1).replace(/\s+/gu, " ").trim();
}

/** Sanitize a multiline terminal block while preserving its logical rows. */
export function sanitizeTerminalBlock(value: string, tabWidth = 4): string {
	return value
		.split(/\r\n|[\n\r\u2028\u2029]/u)
		.map((line) => sanitizeTerminalLine(line, tabWidth))
		.join("\n");
}

/** Clip plain text without splitting Unicode code points. */
export function clipText(value: string, maxCharacters: number, ellipsis = "…"): string {
	const characters = graphemes(value);
	const limit = Math.max(0, Math.floor(maxCharacters));
	if (characters.length <= limit) return value;
	if (limit === 0) return "";
	const suffix = graphemes(ellipsis);
	if (suffix.length >= limit) return suffix.slice(0, limit).join("");
	return `${characters.slice(0, limit - suffix.length).join("")}${ellipsis}`;
}

/** Flatten, sanitize, and clip untrusted text to terminal display width. */
export function clipTerminalText(value: string, maxWidth: number, ellipsis = "…"): string {
	const clipped = truncateToWidth(sanitizeTerminalText(value), Math.max(0, Math.floor(maxWidth)), ellipsis);
	return sanitizeTerminalLine(clipped);
}

/** Prefer a nearby word boundary while clipping normalized plain text. */
export function clipTextAtWord(value: string, maxCharacters: number): string {
	const oneLine = sanitizeTerminalText(value);
	if (graphemes(oneLine).length <= maxCharacters) return oneLine;
	const clipped = clipText(oneLine, maxCharacters, "");
	const space = clipped.lastIndexOf(" ");
	return `${space > maxCharacters * 0.5 ? clipped.slice(0, space) : clipped}…`;
}
