/**
 * Diagnostic: captures and logs rate-limit headers from provider responses.
 * Check pi's stderr output after a few prompts to see the headers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Only log for providers that actually send rate-limit headers. */
const WATCHED_PROVIDERS = new Set(["codex", "openai", "anthropic"]);

export default function(pi: ExtensionAPI) {
  pi.on("after_provider_response", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (!provider || !WATCHED_PROVIDERS.has(provider)) return;

    const headers = event.headers ?? {};
    const rateHeaders: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("ratelimit") ||
        lower.includes("rate-limit") ||
        lower.includes("rate_limit") ||
        lower.startsWith("anthropic-") ||
        lower.startsWith("x-ratelimit")
      ) {
        rateHeaders[key] = value;
      }
    }

    if (Object.keys(rateHeaders).length > 0) {
      process.stderr.write(`\n[RATE-LIMIT-DEBUG] provider=${provider} status=${event.status}\n`);
      for (const [k, v] of Object.entries(rateHeaders)) {
        process.stderr.write(`  ${k}: ${v}\n`);
      }
    } else {
      process.stderr.write(
        `\n[RATE-LIMIT-DEBUG] provider=${provider} status=${event.status} — no rate-limit headers found. All headers:\n`,
      );
      for (const [k, v] of Object.entries(headers)) {
        process.stderr.write(`  ${k}: ${v}\n`);
      }
    }
  });
}
