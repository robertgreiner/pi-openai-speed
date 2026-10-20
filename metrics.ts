// No prompts, response text, headers, credentials, or account IDs are retained.
export type Speed = "normal" | "fast" | "ultrafast";

export interface SpeedSample {
  speed: Speed;
  requestedTier: string;
  reportedTier?: string;
  model: string;
  provider: string;
  reasoningEffort?: string;
  status?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  visibleTokens?: number;
  firstTextSeconds?: number;
  elapsedSeconds: number;
  textStreamSeconds?: number;
  visibleTokensPerSecond?: number;
  outputTokensPerSecond?: number;
}

export interface Measurement {
  speed: Speed;
  requestedTier: string;
  model: string;
  provider: string;
  reasoningEffort?: string;
  startedAt: number;
  firstTextAt?: number;
  lastTextAt?: number;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Observe parsed SSE/WebSocket events. Count API tokens, never chunks or characters. */
export function observe(measurement: Measurement, data: unknown, now: number): SpeedSample | undefined {
  const event = record(data);
  if (!event) return;
  if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length > 0) {
    measurement.firstTextAt ??= now;
    measurement.lastTextAt = now;
  }
  if (!["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) return;
  const response = record(event.response);
  if (!response) return;
  const usage = record(response.usage);
  const outputTokens = count(usage?.output_tokens);
  const reasoningTokens = count(record(usage?.output_tokens_details)?.reasoning_tokens);
  const elapsedSeconds = (now - measurement.startedAt) / 1000;
  const textStreamSeconds = measurement.firstTextAt !== undefined && measurement.lastTextAt !== undefined
    ? (measurement.lastTextAt - measurement.firstTextAt) / 1000
    : undefined;
  // Tool-call output is also billed as output: don't mislabel those tokens as visible text.
  const textOnly = Array.isArray(response.output)
    && response.output.some((item) => record(item)?.type === "message")
    && response.output.every((item) => ["message", "reasoning"].includes(String(record(item)?.type)));
  const visibleTokens = textOnly && outputTokens !== undefined && reasoningTokens !== undefined
    ? Math.max(0, outputTokens - reasoningTokens)
    : undefined;
  const complete = response.status === "completed";
  return {
    speed: measurement.speed,
    requestedTier: measurement.requestedTier,
    reportedTier: typeof response.service_tier === "string" ? response.service_tier : undefined,
    model: measurement.model,
    provider: measurement.provider,
    reasoningEffort: measurement.reasoningEffort,
    status: typeof response.status === "string" ? response.status : String(event.type),
    inputTokens: count(usage?.input_tokens),
    cachedInputTokens: count(record(usage?.input_tokens_details)?.cached_tokens),
    outputTokens,
    reasoningTokens,
    visibleTokens,
    firstTextSeconds: measurement.firstTextAt === undefined ? undefined : (measurement.firstTextAt - measurement.startedAt) / 1000,
    elapsedSeconds,
    textStreamSeconds,
    // Approximate decode rate: first-to-last received text, excluding startup and hidden reasoning.
    visibleTokensPerSecond: complete && visibleTokens !== undefined && textStreamSeconds !== undefined && textStreamSeconds > 0
      ? visibleTokens / textStreamSeconds : undefined,
    outputTokensPerSecond: complete && outputTokens !== undefined && elapsedSeconds > 0
      ? outputTokens / elapsedSeconds : undefined,
  };
}
