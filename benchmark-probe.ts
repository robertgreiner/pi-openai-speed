import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const file = process.env.PI_SPEED_BENCHMARK_REPORT;
  if (!file) throw new Error("PI_SPEED_BENCHMARK_REPORT is required");
  const save = (kind: string, data: unknown) => appendFileSync(file, JSON.stringify({ kind, data }) + "\n", { mode: 0o600 });
  pi.on("before_provider_request", (event) => {
    const p = event.payload as any;
    save("request", { model: p.model, service_tier: p.service_tier, reasoning: p.reasoning });
  });
  pi.on("after_provider_response", (event) => save("http", { status: event.status }));
  const unsubscribe = pi.events.on("openai-speed:sample", (sample) => save("sample", sample));
  pi.on("session_shutdown", () => unsubscribe());
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") save("assistant", {
      stopReason: event.message.stopReason,
      errorMessage: event.message.errorMessage,
      usage: event.message.usage,
    });
  });
}
