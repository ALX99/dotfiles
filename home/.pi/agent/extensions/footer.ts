/**
 * Footer Extension — Full custom footer replacement.
 *
 * Shows on the left:  other extension statuses, cwd, git branch
 * Shows on the right: (provider) model, thinking level, context bar, session tokens, latest cache hit rate
 *
 * Right-aligned with space padding so stats stay flush to the terminal edge.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

/* ─── formatting ─── */

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function shortenCwd(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? cwd.replace(home, "~") : cwd;
}

/* ─── context bar ─── */

function renderContextBar(usage: { tokens: number | null; contextWindow: number; percent: number | null }, theme: ExtensionContext["ui"]["theme"]): string {
  if (usage.tokens === null || usage.percent === null) {
    return theme.fg("dim", "[░░░░░░░░░░]--%");
  }

  const width = 10;
  const filled = Math.round((usage.percent / 100) * width);
  const empty = width - filled;

  let color: string;
  if (usage.percent < 50) color = "accent";
  else if (usage.percent < 80) color = "warning";
  else color = "error";

  const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
  return `[${bar}]${theme.fg(color, `${Math.round(usage.percent)}%`)}`;
}

/* ─── footer ─── */

export default function(pi: ExtensionAPI) {
  let requestRender: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    requestRender = setupFooter(ctx, pi);
    requestRender();
  });

  pi.on("model_select", () => {
    requestRender?.();
  });
}

function setupFooter(ctx: ExtensionContext, pi: ExtensionAPI): () => void {
  // Cache tokens between renders — only recompute when the session grows.
  let cachedTokens = buildSessionTokens(ctx);
  let lastBranchLen = ctx.sessionManager.getBranch().length;
  let requestRender: (() => void) | undefined;

  function rebuildTokens() {
    cachedTokens = buildSessionTokens(ctx);
    lastBranchLen = ctx.sessionManager.getBranch().length;
  }

  function recheckTokens() {
    if (ctx.sessionManager.getBranch().length !== lastBranchLen) {
      rebuildTokens();
    }
  }

  ctx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender();
    const unsubBranch = footerData.onBranchChange(requestRender);

    return {
      dispose: unsubBranch,
      invalidate() { rebuildTokens(); },
      render(width: number): string[] {
        recheckTokens();

        /* left: other extension statuses + cwd + (branch) */
        const statuses = footerData.getExtensionStatuses();
        let left = theme.fg("dim", shortenCwd(ctx.cwd));

        const branchName = footerData.getGitBranch();
        if (branchName) {
          left += theme.fg("dim", ` (${branchName})`);
        }

        const statusParts: string[] = [];
        for (const [, text] of statuses) {
          statusParts.push(text);
        }
        if (statusParts.length > 0) {
          left = statusParts.join("  ") + "  " + left;
        }

        /* right: model  ctx-bar  reasoning  session-tokens */
        const rightParts: string[] = [];

        const model = ctx.model;
        if (model) {
          rightParts.push(theme.fg("dim", `(${model.provider}) ${model.id}`));
        }

        const ctxUsage = ctx.getContextUsage();
        if (ctxUsage) {
          rightParts.push(renderContextBar(ctxUsage, theme));
        }

        const thinking = pi.getThinkingLevel();
        if (thinking && thinking !== "off") {
          rightParts.push(theme.fg("warning", thinking));
        }

        rightParts.push(cachedTokens);

        const right = rightParts.join("  ");
        const pad = width - visibleWidth(left) - visibleWidth(right);
        if (pad > 0) {
          return [truncateToWidth(left + " ".repeat(pad) + right, width)];
        }
        return [truncateToWidth(left + " " + right, width)];
      },
    };
  });

  return () => requestRender?.();
}

function buildSessionTokens(ctx: ExtensionContext): string {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let latestCacheHitRate: number | undefined;

  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant" && e.message.usage) {
      const usage = e.message.usage;
      input += usage.input ?? 0;
      output += usage.output ?? 0;
      cacheRead += usage.cacheRead ?? 0;
      cacheWrite += usage.cacheWrite ?? 0;

      const latestPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      latestCacheHitRate = latestPromptTokens > 0 ? ((usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
    }
  }

  const sep = ctx.ui.theme.fg("dim", "/");
  let tokens = `${ctx.ui.theme.fg("accent", "↑")}${fmt(input)}${sep}${ctx.ui.theme.fg("accent", "↓")}${fmt(output)}`;
  if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
    tokens += `${sep}${ctx.ui.theme.fg("accent", "CH")}${latestCacheHitRate.toFixed(1)}%`;
  }
  return tokens;
}
