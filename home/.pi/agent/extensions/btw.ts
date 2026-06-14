import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function buildBtwPrompt(question: string): string {
  return `Side question / BTW: ${question}

Treat this as a lightweight side conversation:
- Answer the side question without derailing or broadening the main task.
- Do not make durable code/config changes unless the user explicitly asks in this side question.
- Prefer read-only inspection. If broad reconnaissance is needed and the subagent tool is available, use the scout subagent once.
- Keep the response concise and call out any uncertainty or follow-up needed.`;
}

export default function(pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Ask a lightweight side question without derailing the main task",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <side question>", "warning");
        return;
      }

      const prompt = buildBtwPrompt(question);
      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("BTW queued as a follow-up side question.", "info");
      }
    },
  });
}
