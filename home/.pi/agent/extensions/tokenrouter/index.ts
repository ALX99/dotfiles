import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerProvider("tokenrouter", {
    name: "TokenRouter",
    baseUrl: "https://api.tokenrouter.com/v1",
    apiKey: "$TOKENROUTER_API_KEY",
    api: "openai-completions",
    authHeader: true,

    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },

    models: [
      {
        id: "MiniMax-M3",
        name: "MiniMax M3",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 16_384,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    ],
  });
}
