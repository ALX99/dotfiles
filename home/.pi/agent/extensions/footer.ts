/**
 * Footer Extension — Full custom footer replacement.
 *
 * Shows on the left:  cwd, git branch, model + thinking level, context bar
 * Shows on the right: extension statuses, session tokens, latest cache hit rate, session length
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

function parseTimestamp(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getSessionStartedAt(ctx: ExtensionContext): number {
  const headerStartedAt = parseTimestamp(ctx.sessionManager.getHeader()?.timestamp);
  if (headerStartedAt !== undefined) return headerStartedAt;

  for (const entry of ctx.sessionManager.getBranch()) {
    const entryStartedAt = parseTimestamp(entry.timestamp);
    if (entryStartedAt !== undefined) return entryStartedAt;
  }

  return Date.now();
}

function formatSessionLength(startedAt: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;

  if (hours < 1) return `${minutes}m`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days < 1) return `${hours}h`;

  return `${days}d${remainingHours}h`;
}

/* ─── thinking level color ramp ─── */

// Pi ships per-level theme colors. Map thinking level → theme color so
// minimal reads cool/dim and xhigh reads hot, using the theme's palette.
const THINKING_COLOR: Record<string, "thinkingMinimal" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh"> = {
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
};

/* ─── context bar ─── */

export function renderContextBar(usage: { tokens: number | null; contextWindow: number; percent: number | null }, theme: ExtensionContext["ui"]["theme"]): string {
  if (usage.tokens === null || usage.percent === null) {
    return theme.fg("dim", "[░░░░░░░░░░]--%");
  }

  const width = 10;
  const filled = Math.min(width, Math.max(0, Math.round((usage.percent / 100) * width)));
  const empty = width - filled;

  let color: "accent" | "warning" | "error";
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
  // Cache tokens between renders — recomputed on turn_end (O(1)), not on
  // every render. invalidate() resets the counter to rebuild from scratch
  // (used by session_compact and explicit refresh paths).
  const sessionStartedAt = getSessionStartedAt(ctx);
  let cachedTokens = "";
  let lastBranchLen = 0;
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

  // Build once at attach time, then keep current via turn_end deltas.
  rebuildTokens();

  pi.on("turn_end", () => {
    rebuildTokens();
    requestRender?.();
  });

  ctx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender();
    const unsubBranch = footerData.onBranchChange(requestRender);
    const renderInterval = setInterval(requestRender, 60_000);

    return {
      dispose() {
        clearInterval(renderInterval);
        unsubBranch();
      },
      invalidate() { rebuildTokens(); },
      render(width: number): string[] {
        recheckTokens();

        /* left: cwd, branch, model, context bar */
        const leftParts: string[] = [];
        leftParts.push(theme.fg("muted", shortenCwd(ctx.cwd)));

        const branchName = footerData.getGitBranch();
        if (branchName) {
          leftParts.push(theme.fg("dim", "(") + theme.fg("accent", branchName) + theme.fg("dim", ")"));
        }

        const model = ctx.model;
        if (model) {
          let modelText = theme.fg("text", model.id) + theme.fg("dim", "(") + theme.fg("muted", model.provider) + theme.fg("dim", ")");
          const thinking = pi.getThinkingLevel();
          if (thinking) {
            const color = thinking === "off" ? "muted" : THINKING_COLOR[thinking];
            if (color) modelText += theme.fg(color, ` · ${thinking}`);
          }
          leftParts.push(modelText);
        }

        const left = leftParts.join("  ");

        /* right: extension statuses, session tokens, context bar */
        const statuses = footerData.getExtensionStatuses();
        const statusParts: string[] = [];
        for (const [, text] of statuses) {
          statusParts.push(text);
        }

        const rightParts: string[] = [];
        if (statusParts.length > 0) {
          rightParts.push(statusParts.join("  "));
        }

        rightParts.push(cachedTokens);

        const ctxUsage = ctx.getContextUsage();
        if (ctxUsage) {
          rightParts.push(renderContextBar(ctxUsage, theme));
        }

        rightParts.push(formatSessionLength(sessionStartedAt));

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
  let latestCacheHitRate: number | undefined;

  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant" && e.message.usage) {
      const usage = e.message.usage;
      input += usage.input ?? 0;
      output += usage.output ?? 0;

      const latestPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      latestCacheHitRate = latestPromptTokens > 0 ? ((usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
    }
  }

  // Always show CH (with ??.?% placeholder when unknown) so the right-side
  // width is stable and the layout doesn't shift as cache data appears.
  const sep = ctx.ui.theme.fg("dim", "/");
  const chStr = latestCacheHitRate !== undefined ? `${latestCacheHitRate.toFixed(1)}%` : "??.?%";
  return `${ctx.ui.theme.fg("accent", "↑")}${fmt(input)}${sep}${ctx.ui.theme.fg("accent", "↓")}${fmt(output)}${sep}${ctx.ui.theme.fg("accent", "CH")}${chStr}`;
}
