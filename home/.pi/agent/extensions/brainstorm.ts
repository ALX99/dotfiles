/**
 * Brainstorm Mode
 *
 * Lightweight developer/CEO collaboration mode:
 * - The agent acts as a senior developer / technical lead.
 * - The user acts as CEO/product owner.
 * - The conversation can go back and forth until direction is clear.
 * - /brainstorm-recommend asks for a token-budgeted implementation recommendation.
 * - /brainstorm-finalize asks the current agent to write and save an implementation plan.
 * - /brainstorm-implement starts a fresh implementation session from the saved plan.
 * - No hidden planner calls, no automatic implementation session.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type BrainstormPhase = "idle" | "brainstorm";

const FINALIZED_PLAN_ENTRY = "brainstorm-finalized-plan";
const FINALIZED_PLAN_HEADINGS = [
  "## Goal",
  "## Context",
  "## Assumptions",
  "## Stop / Ask Conditions",
  "## File Map",
  "## Implementation Plan",
  "## Final Verification",
  "## Completion Report",
];

const BRAINSTORM_CONTEXT = `[BRAINSTORM MODE ACTIVE]
You are acting as a senior developer / technical lead. The user is the CEO/product owner.

Primary job:
Help turn rough business/product direction into a practical technical direction through back-and-forth discussion.

Operating principles:
- Treat the user as the decision-maker for product/business trade-offs.
- You own technical judgment: feasibility, simplicity, maintainability, risks, and implementation shape.
- Be direct. Push back on vague goals, overengineering, risky shortcuts, or weak assumptions.
- Prefer the smallest coherent slice that delivers value.
- Do not create durable specs, plans, or implementation handoff documents unless explicitly asked.
- Do not start implementation or make durable code/config changes unless the user explicitly asks you to.
- Reversible experiments are allowed only after stating purpose, files affected, expected learning, and rollback plan.

Tool use:
- Use tools to understand reality before making technical claims.
- Token discipline matters: default to direct reasoning from established context when confidence is adequate.
- If the subagent tool is available, use scout only when broad read-only reconnaissance would materially improve the recommendation.
- If the subagent tool is available, use reviewer only when correctness risk, future compatibility, or deviation from current structure/standard patterns justifies the spend.
- Do not run a multi-agent pipeline; use at most one focused subagent call for a recommendation turn unless the user explicitly asks otherwise.
- Use direct reads for focused follow-up after scout/reviewer returns compressed findings.
- Read-only commands, git status/diff, tests, and targeted diagnostics are encouraged when they improve the recommendation.
- If tool output contradicts assumptions, update the recommendation.

Conversation style:
- Keep responses concise: usually 3-6 bullets.
- Ask at most one question at a time, and only when it blocks a meaningful recommendation.
- If ambiguity is not blocking, state a reasonable assumption and proceed.
- Recommend one path by default. Mention alternatives only when they materially affect the CEO decision.
- Separate business decisions from technical decisions when useful.
- Avoid generic questionnaires and long checklists.

Useful response shapes:
- Recommendation: what I would do, why, trade-offs, next decision.
- Pushback: what is risky, why it matters, safer alternative.
- Understanding check: goal, constraints, likely approach, open decision.
- Implementation readiness: files/areas likely touched, risks, verification approach.`;

interface BrainstormState {
  phase: BrainstormPhase;
  awaitingFinalizedPlan: boolean;
  finalizedPlan?: string;
  finalizedPlanTimestamp?: number;
}

interface FinalizedPlanEntry {
  type: string;
  customType?: string;
  data?: {
    plan?: unknown;
    timestamp?: unknown;
  };
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMissingPlanHeadings(plan: string): string[] {
  return FINALIZED_PLAN_HEADINGS.filter((heading) => !new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m").test(plan));
}

function getLastAssistantText(messages: readonly AgentMessage[]): string | undefined {
  const message = [...messages].reverse().find(isAssistantMessage);
  if (!message) return undefined;

  const text = getTextContent(message).trim();
  return text || undefined;
}

export default function(pi: ExtensionAPI) {
  const state: BrainstormState = {
    phase: "idle",
    awaitingFinalizedPlan: false,
  };

  function updateStatus(ctx: ExtensionContext): void {
    const label = state.phase === "brainstorm" ? ctx.ui.theme.fg("warning", "brainstorm") : undefined;
    ctx.ui.setStatus("brainstorm", label);
  }

  function enterBrainstorm(ctx: ExtensionContext, topic: string): void {
    state.phase = "brainstorm";
    updateStatus(ctx);
    ctx.ui.notify("Brainstorm mode enabled.", "info");
    pi.sendUserMessage(`Brainstorm topic: ${topic}`);
  }

  function exitBrainstorm(ctx?: ExtensionContext): void {
    state.phase = "idle";
    state.awaitingFinalizedPlan = false;
    if (ctx) updateStatus(ctx);
  }

  function restoreFinalizedPlan(ctx: ExtensionContext): void {
    const entry = ctx.sessionManager
      .getEntries()
      .filter((entry): entry is FinalizedPlanEntry => {
        const maybeEntry = entry as FinalizedPlanEntry;
        return maybeEntry.type === "custom" && maybeEntry.customType === FINALIZED_PLAN_ENTRY;
      })
      .pop();

    if (typeof entry?.data?.plan === "string") {
      state.finalizedPlan = entry.data.plan;
      state.finalizedPlanTimestamp = typeof entry.data.timestamp === "number" ? entry.data.timestamp : undefined;
    }
  }

  pi.registerFlag("brainstorm", {
    description: "Start brainstorm mode",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("brainstorm", {
    description: "Start brainstorm mode: developer/CEO back-and-forth without automatic implementation",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      let topic = args.trim();

      if (state.phase === "brainstorm") {
        if (topic) {
          pi.sendUserMessage(`Brainstorm update: ${topic}`);
          return;
        }
        ctx.ui.notify("Brainstorm mode is already active. Use /brainstorm-done <next prompt> to exit.", "warning");
        return;
      }

      if (!topic && ctx.hasUI) {
        const input = await ctx.ui.input("What do you want to brainstorm?", "Describe the topic...");
        topic = input?.trim() ?? "";
      }

      if (!topic) {
        ctx.ui.notify("Usage: /brainstorm <topic>", "error");
        return;
      }

      enterBrainstorm(ctx, topic);
    },
  });

  pi.registerCommand("brainstorm-recommend", {
    description: "Recommend the next implementation direction with optional scout/reviewer escalation",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      if (state.phase !== "brainstorm") {
        ctx.ui.notify("Brainstorm mode is not active. Start with /brainstorm <topic>.", "error");
        return;
      }

      const instructions = args.trim();
      pi.sendUserMessage(`Recommend the next implementation direction from our brainstorm conversation.${instructions ? `\n\nAdditional CEO instructions:\n${instructions}` : ""}

Token-budgeted escalation rules:
- Normal low-risk flow should complete without subagent calls.
- Use scout only when current context is too weak and broad read-only reconnaissance would materially change the recommendation.
- Use reviewer only when existing context is sufficient but correctness risk, future compatibility, or deviation from current structure/standard patterns is meaningful.
- Use at most one subagent call in this turn. If both scout and reviewer seem useful, prefer scout first and list reviewer as a later optional check.
- Do not create or request planner/architect/risk/fix agents. Do not implement anything yet.

Output exactly:

## Recommendation
One concise recommendation and why.

## Confidence
High, Medium, or Low — one sentence explaining why.

## Scout
Needed: yes/no. If yes, say whether you invoked scout or why it should be the next step.

## Reviewer
Needed: yes/no. If yes, say whether you invoked reviewer or why it should be the next step.

## Token Spend Rationale
One sentence explaining why escalation spend is or is not justified.

## Next Action
One concrete next step.`);
    },
  });

  pi.registerCommand("brainstorm-finalize", {
    description: "Create an implementation plan from the brainstorm conversation",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      if (state.phase !== "brainstorm") {
        ctx.ui.notify("Brainstorm mode is not active. Start with /brainstorm <topic>.", "error");
        return;
      }

      const instructions = args.trim();
      state.awaitingFinalizedPlan = true;
      pi.sendUserMessage(`Create an implementation plan from our brainstorm conversation.${instructions ? `\n\nAdditional CEO instructions:\n${instructions}` : ""}

Rules:
- Base the plan only on what we discussed and any code findings already established.
- Do not implement anything yet.
- Do not invent missing code details; add an explicit inspection or scout step instead.
- Keep the plan minimal, practical, and suitable for a fresh coding agent.
- Include reviewer only as an optional focused check when correctness risk, future compatibility, or structural deviation justifies the token spend.
- Include stop/ask conditions for decisions that should not be guessed.

Output exactly:

## Goal
One sentence.

## Context
Bullets with relevant CEO decisions, constraints, code findings, non-goals, and trade-offs.

## Assumptions
Bullets. Use "None" if none.

## Stop / Ask Conditions
Bullets for ambiguity that should pause implementation.

## File Map
- Modify/Create/Test/Inspect: path when known — expected responsibility or question to answer.

## Implementation Plan
Numbered concrete tasks with verification for each task when practical.

## Final Verification
Commands/checks to run and expected result.

## Completion Report
What the implementor should report back.`);
    },
  });

  pi.registerCommand("brainstorm-implement", {
    description: "Start a fresh implementation session from the finalized brainstorm plan",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      restoreFinalizedPlan(ctx);

      if (!state.finalizedPlan) {
        ctx.ui.notify("No finalized brainstorm plan found. Run /brainstorm-finalize first.", "error");
        return;
      }

      const instructions = args.trim();
      const parentSession = ctx.sessionManager.getSessionFile();
      const kickoff = `Implement this finalized brainstorm plan in this fresh session.

Rules:
- Treat the plan below as the source of truth.
- Do not revisit brainstorm decisions unless implementation is blocked.
- Keep changes scoped to the plan.
- Stop and ask if a Stop / Ask Condition is hit.${instructions ? `\n- Additional implementation instruction: ${instructions}` : ""}

Finalized plan:

${state.finalizedPlan}`;

      const result = await ctx.newSession({
        parentSession,
        withSession: async (ctx) => {
          await ctx.sendUserMessage(kickoff);
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Brainstorm implementation handoff was cancelled.", "warning");
      }
    },
  });

  pi.registerCommand("brainstorm-done", {
    description: "Exit brainstorm mode, optionally sending a normal follow-up prompt",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const nextPrompt = args.trim();
      exitBrainstorm(ctx);
      ctx.ui.notify("Brainstorm mode disabled.", "info");

      if (nextPrompt) {
        pi.sendUserMessage(nextPrompt);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreFinalizedPlan(ctx);

    if (pi.getFlag("brainstorm") === true && state.phase === "idle") {
      state.phase = "brainstorm";
    }
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.awaitingFinalizedPlan) return;
    state.awaitingFinalizedPlan = false;

    const plan = getLastAssistantText(event.messages as readonly AgentMessage[]);
    if (!plan) {
      ctx.ui.notify("Brainstorm finalize did not produce an assistant plan. Run /brainstorm-finalize again.", "error");
      return;
    }

    const missingHeadings = getMissingPlanHeadings(plan);
    if (missingHeadings.length > 0) {
      ctx.ui.notify(`Brainstorm plan was not saved; missing headings: ${missingHeadings.join(", ")}`, "error");
      return;
    }

    state.finalizedPlan = plan;
    state.finalizedPlanTimestamp = Date.now();
    pi.appendEntry(FINALIZED_PLAN_ENTRY, {
      plan,
      timestamp: state.finalizedPlanTimestamp,
    });
    ctx.ui.notify("Brainstorm finalized plan saved. Use /brainstorm-implement to start a fresh implementation session.", "info");
  });

  pi.on("session_shutdown", async () => {
    exitBrainstorm();
  });

  pi.on("context", async (event) => {
    if (state.phase !== "idle") return;

    return {
      messages: event.messages.filter((message) => {
        const maybeCustom = message as { customType?: string };
        return maybeCustom.customType !== "brainstorm-context";
      }),
    };
  });

  pi.on("before_agent_start", async () => {
    if (state.phase !== "brainstorm") return;

    return {
      message: {
        customType: "brainstorm-context",
        content: BRAINSTORM_CONTEXT,
        display: false,
      },
    };
  });
}
