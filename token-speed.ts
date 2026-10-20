/** Standalone, provider-neutral throughput display. Never modifies a model request. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const TOKEN_SPEED_STATUS = "token-speed";
const ENTRY = "token-speed-state";

export interface TokenTiming {
  provider: string;
  model: string;
  startedAt: number;
  firstTextAt?: number;
  lastTextAt?: number;
  stage: "waiting" | "thinking" | "streaming";
}

export interface TokenSample {
  provider: string;
  model: string;
  outputTokens: number;
  reasoningTokens?: number;
  visibleTokens?: number;
  elapsedSeconds: number;
  firstTextSeconds?: number;
  textSeconds?: number;
  textTokensPerSecond?: number;
  totalTokensPerSecond: number;
}

export function finishTokens(timing: TokenTiming, message: AssistantMessage, now: number): TokenSample | undefined {
  if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") return;
  const output = message.usage.output;
  const elapsed = (now - timing.startedAt) / 1000;
  if (!Number.isFinite(output) || output <= 0 || !Number.isFinite(elapsed) || elapsed <= 0) return;
  const reasoning = message.usage.reasoning;
  const hasBreakdown = reasoning !== undefined && Number.isFinite(reasoning) && reasoning >= 0 && reasoning <= output;
  const textOnly = message.content.some((part) => part.type === "text")
    && message.content.every((part) => part.type === "text" || part.type === "thinking");
  const visibleTokens = hasBreakdown && textOnly ? output - reasoning : undefined;
  const textSeconds = timing.firstTextAt !== undefined && timing.lastTextAt !== undefined
    ? (timing.lastTextAt - timing.firstTextAt) / 1000 : undefined;
  return {
    provider: message.provider,
    model: message.model,
    outputTokens: output,
    reasoningTokens: hasBreakdown ? reasoning : undefined,
    visibleTokens,
    elapsedSeconds: elapsed,
    firstTextSeconds: timing.firstTextAt === undefined ? undefined : (timing.firstTextAt - timing.startedAt) / 1000,
    textSeconds,
    // Length-limited responses still have trustworthy total usage, but don't claim a complete text sample.
    textTokensPerSecond: message.stopReason === "stop" && visibleTokens !== undefined && visibleTokens > 0
      && textSeconds !== undefined && textSeconds > 0 ? visibleTokens / textSeconds : undefined,
    totalTokensPerSecond: output / elapsed,
  };
}

export function tokenLabel(sample: TokenSample): string {
  return sample.textTokensPerSecond !== undefined
    ? `↓ ${sample.textTokensPerSecond.toFixed(1)} tok/s`
    : `↓ ${sample.totalTokensPerSecond.toFixed(1)} tok/s total`;
}

export default function tokenSpeed(pi: ExtensionAPI, now = () => performance.now()) {
  let enabled = true;
  let active: TokenTiming | undefined;
  let last: TokenSample | undefined;

  function clear(ctx: ExtensionContext) {
    active = undefined;
    last = undefined;
    ctx.ui.setStatus(TOKEN_SPEED_STATUS, undefined);
  }

  function restore(ctx: ExtensionContext) {
    clear(ctx);
    enabled = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data = entry.data as { enabled?: unknown } | undefined;
      if (typeof data?.enabled === "boolean") enabled = data.enabled;
    }
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => clear(ctx));
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));

  pi.on("before_provider_request", (_event, ctx) => {
    clear(ctx);
    if (!enabled || !ctx.model) return;
    active = { provider: ctx.model.provider, model: ctx.model.id, startedAt: now(), stage: "waiting" };
    ctx.ui.setStatus(TOKEN_SPEED_STATUS, "↓ waiting…");
  });

  pi.on("message_update", (event, ctx) => {
    if (!active || event.message.role !== "assistant"
      || event.message.provider !== active.provider || event.message.model !== active.model) return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" && update.delta.length > 0) {
      const at = now();
      active.firstTextAt ??= at;
      active.lastTextAt = at;
      if (active.stage !== "streaming") {
        active.stage = "streaming";
        ctx.ui.setStatus(TOKEN_SPEED_STATUS, "↓ streaming…");
      }
    } else if (update.type === "thinking_delta" && active.stage === "waiting") {
      active.stage = "thinking";
      ctx.ui.setStatus(TOKEN_SPEED_STATUS, "↓ thinking…");
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (!active || message.role !== "assistant" || message.provider !== active.provider || message.model !== active.model) return;
    last = finishTokens(active, message, now());
    active = undefined;
    if (last) {
      ctx.ui.setStatus(TOKEN_SPEED_STATUS, tokenLabel(last));
      // Sanitized numeric metadata only. No text, prompts, IDs, headers, or credentials.
      pi.events.emit("token-speed:sample", last);
    } else {
      ctx.ui.setStatus(TOKEN_SPEED_STATUS, undefined);
    }
  });

  // Also clear the placeholder if an operation fails before emitting a final assistant message.
  pi.on("agent_end", (_event, ctx) => {
    if (active) clear(ctx);
  });

  pi.registerCommand("tokens", {
    description: "Token throughput display: on | off | status (default)",
    getArgumentCompletions: (prefix) => ["on", "off", "status"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase() || "status";
      if (arg === "on" || arg === "off") {
        enabled = arg === "on";
        clear(ctx);
        pi.appendEntry(ENTRY, { enabled });
        ctx.ui.notify(`Token throughput ${enabled ? "enabled for the next request" : "hidden"}.`, "info");
        return;
      }
      if (arg !== "status") {
        ctx.ui.notify("Usage: /tokens on|off|status", "warning");
        return;
      }
      const lines = [`Token throughput display: ${enabled ? "on" : "off"}.`];
      if (last) {
        lines.push(`${last.provider}/${last.model}: ${last.outputTokens} output tokens${last.reasoningTokens === undefined ? "" : ` (${last.reasoningTokens} reasoning)`}.`);
        if (last.textTokensPerSecond !== undefined) lines.push(`Visible text: ${last.textTokensPerSecond.toFixed(1)} tok/s over ${last.textSeconds!.toFixed(2)}s of streaming.`);
        lines.push(`Total: ${last.totalTokensPerSecond.toFixed(1)} output tok/s over ${last.elapsedSeconds.toFixed(2)}s (includes startup and reasoning).`);
        if (last.firstTextSeconds !== undefined) lines.push(`First text: ${last.firstTextSeconds.toFixed(2)}s.`);
      } else {
        lines.push(active ? `Request is ${active.stage}; waiting for final token usage.` : "No measured response yet.");
      }
      lines.push("Counts come from provider usage, not chunks or character estimates. Rates are client-observed; tool execution time is excluded.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
