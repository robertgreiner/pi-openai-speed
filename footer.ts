import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { record, type Speed } from "./metrics.ts";

const oneLine = (text: string) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(n < 10000000 ? 1 : 0)}M`;
}

export function homePath(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const suffix = relative(resolve(home), resolve(cwd));
  if (suffix === "") return "~";
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix) ? `~${sep}${suffix}` : cwd;
}

/** Prefer keeping model, thinking, and speed together over long cumulative stats. */
export function alignStats(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const budget = width - visibleWidth(right) - 2;
  if (budget <= 0) return truncateToWidth(right, width, "…");
  const shortened = truncateToWidth(left, budget, "…");
  return shortened + " ".repeat(width - visibleWidth(shortened) - visibleWidth(right)) + right;
}

/** Public custom-footer API only: no patching Pi classes or changing model metadata. */
export function createSpeedFooter(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel" | "getSettings">,
  tui: Pick<TUI, "requestRender">,
  theme: Theme,
  data: ReadonlyFooterDataProvider,
  getSpeed: () => Speed,
) {
  let cachedKey: string | undefined;
  let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHit: number | undefined;
  let context: ReturnType<ExtensionContext["getContextUsage"]>;
  const unsubscribe = data.onBranchChange(() => tui.requestRender());

  function refresh() {
    const model = ctx.model;
    const key = JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), model?.provider, model?.id, model?.contextWindow]);
    if (key === cachedKey) return;
    cachedKey = key;
    totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    cacheHit = undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      let usage: Record<string, unknown> | undefined;
      if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
        usage = record(entry.message.usage);
        if (entry.message.role === "assistant" && usage) {
          const prompt = Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
          cacheHit = prompt > 0 ? Number(usage.cacheRead ?? 0) / prompt * 100 : undefined;
        }
      } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
        usage = record(entry.usage);
      }
      if (!usage) continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value)) totals[key] += value;
      }
      const cost = record(usage.cost)?.total;
      if (typeof cost === "number" && Number.isFinite(cost)) totals.cost += cost;
    }
    context = ctx.getContextUsage();
  }

  return {
    dispose: unsubscribe,
    invalidate() { cachedKey = undefined; },
    render(width: number): string[] {
      if (width <= 0) return [];
      refresh();
      const model = ctx.model;
      const dim = (text: string) => theme.fg("dim", text);
      let location = homePath(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
      const branch = data.getGitBranch();
      if (branch) location += ` (${branch})`;
      const name = ctx.sessionManager.getSessionName();
      if (name) location += ` • ${name}`;

      const stats: string[] = [];
      for (const [key, prefix] of [["input", "↑"], ["output", "↓"], ["cacheRead", "R"], ["cacheWrite", "W"]] as const) {
        if (totals[key]) stats.push(`${prefix}${formatTokens(totals[key])}`);
      }
      if ((totals.cacheRead || totals.cacheWrite) && cacheHit !== undefined) stats.push(`CH${cacheHit.toFixed(1)}%`);
      const subscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
      if (totals.cost || subscription) stats.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
      const percent = context?.percent;
      const usage = `${percent === null ? "?" : (percent ?? 0).toFixed(1) + "%"}/${formatTokens(context?.contextWindow ?? model?.contextWindow ?? 0)}`;
      const auto = pi.getSettings().compaction?.enabled !== false ? " (auto)" : "";
      stats.push(usage + auto);
      const left = stats.map((part, i) => i === stats.length - 1 && (percent ?? 0) > 70
        ? theme.fg((percent ?? 0) > 90 ? "error" : "warning", part) : dim(part)).join(" ");

      const thinking = model?.reasoning ? ` • ${pi.getThinkingLevel() === "off" ? "thinking off" : pi.getThinkingLevel()}` : "";
      let right = `${model?.id ?? "no-model"}${thinking} • ${getSpeed()}`;
      const statuses = data.getExtensionStatuses();
      const tokenStatus = oneLine(statuses.get("token-speed") ?? "");
      const inlineTokens = tokenStatus.length > 0 && visibleWidth(`${right} • ${tokenStatus}`) <= width;
      if (inlineTokens) right += ` • ${tokenStatus}`;
      const provider = model && data.getAvailableProviderCount() > 1 ? `(${model.provider}) ` : "";
      if (visibleWidth(left) + 2 + visibleWidth(provider + right) <= width) right = provider + right;
      const otherStatuses = [...statuses]
        .filter(([key]) => key !== "openai-speed" && !(inlineTokens && key === "token-speed"))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => oneLine(text))
        .filter((text) => visibleWidth(text) > 0);
      // Reuse spare space beside the location, without crowding model/usage stats
      // or truncating the location just to accommodate an optional status.
      const locationText = oneLine(location);
      const inlineStatuses: string[] = [], overflowStatuses: string[] = [];
      for (const text of otherStatuses) {
        const combined = [...inlineStatuses, text].join(" • ");
        if (visibleWidth(locationText) + 2 + visibleWidth(combined) <= width) inlineStatuses.push(text);
        else overflowStatuses.push(text);
      }
      const locationLine = inlineStatuses.length
        ? alignStats(dim(locationText), dim(inlineStatuses.join(" • ")), width)
        : truncateToWidth(dim(locationText), width, "…");
      const lines = [locationLine, alignStats(left, dim(right), width)];
      // Apply the current theme at render time, not when the status was stored.
      // Explicit warning/error colors supplied by another extension remain intact.
      if (overflowStatuses.length) lines.push(truncateToWidth(dim(overflowStatuses.join(" ")), width, "…"));
      return lines;
    },
  };
}
