import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: true,
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const cache = new Map<string, string>();
const CACHE_CAP = 256;

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const parsed = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(parsed, {
    USE_PROFILES: { html: true },
  });
  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
  cache.set(text, clean);
  return clean;
}
