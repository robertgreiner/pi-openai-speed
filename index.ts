/** Astra service-tier controls for Pi 1.3.0. See README.md for caveats and usage. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { observe, record, type Measurement, type Speed, type SpeedSample } from "./metrics.ts";
import { createSpeedFooter } from "./footer.ts";

const ENTRY = "openai-speed-state";
const STATUS = "openai-speed";
const SPEEDS: Speed[] = ["normal", "fast", "ultrafast"];

export function parseSpeed(value: unknown): Speed | undefined {
  return typeof value === "string" && SPEEDS.includes(value as Speed) ? value as Speed : undefined;
}

export function supported(model: { provider: string; id: string; api: string } | undefined): boolean {
  return model?.id === "gpt-6-astra" && (
    (model.provider === "openai-codex" && model.api === "openai-codex-responses") ||
    (model.provider === "openai" && model.api === "openai-responses")
  );
}

export function wireTier(speed: Speed, provider: string): string {
  return speed === "normal" ? "default" : speed === "fast" && provider === "openai-codex" ? "priority" : speed;
}

export default function openaiSpeed(pi: ExtensionAPI) {
  let speed: Speed = "normal";
  let explicitlySelected = false;
  let measurement: Measurement | undefined;
  let lastSample: SpeedSample | undefined;
  let footerInstalled = false;

  pi.registerFlag("speed", { type: "string", description: "Astra service tier: normal, fast, ultrafast (separate from thinking)" });

  function updateStatus(ctx: ExtensionContext) {
    const active = supported(ctx.model) && explicitlySelected;
    if (ctx.mode !== "tui") {
      ctx.ui.setStatus(STATUS, active ? `speed:${speed} (requested)` : undefined);
      return;
    }
    // TUI: keep the requested mode beside model/effort, not on a separate status row.
    ctx.ui.setStatus(STATUS, undefined);
    if (active) {
      ctx.ui.setFooter((tui, theme, data) => createSpeedFooter(ctx, pi, tui, theme, data, () => speed));
      footerInstalled = true;
    } else if (footerInstalled) {
      ctx.ui.setFooter(undefined);
      footerInstalled = false;
    }
  }

  function restore(ctx: ExtensionContext) {
    speed = "normal";
    explicitlySelected = false;
    measurement = undefined;
    lastSample = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const saved = parseSpeed(record(entry.data)?.speed);
      if (saved) {
        speed = saved;
        explicitlySelected = true;
      }
    }
    updateStatus(ctx);
  }

  function select(next: Speed, ctx: ExtensionContext) {
    speed = next;
    explicitlySelected = true;
    lastSample = undefined;
    pi.appendEntry(ENTRY, { speed });
    updateStatus(ctx);
  }

  pi.on("session_start", (event, ctx) => {
    restore(ctx);
    // Persist the flag so a later /speed change wins across /reload and resume.
    if (event.reason !== "startup") return;
    const flag = pi.getFlag("speed");
    if (flag === undefined) return;
    const parsed = parseSpeed(flag);
    if (!parsed) {
      speed = "normal";
      explicitlySelected = false;
      updateStatus(ctx);
      ctx.ui.notify("Invalid --speed. Use normal, fast, or ultrafast; no tier override applied.", "error");
      return;
    }
    select(parsed, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (footerInstalled) ctx.ui.setFooter(undefined);
    footerInstalled = false;
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => {
    measurement = undefined;
    lastSample = undefined;
    updateStatus(ctx);
  });

  pi.registerCommand("speed", {
    description: "Astra speed: normal | fast | ultrafast | status; no argument opens a picker",
    getArgumentCompletions: (prefix) => [...SPEEDS, "status"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      let requested = args.trim().toLowerCase();
      if (requested === "status") {
        const sample = lastSample;
        const lines = [
          `Astra speed: ${explicitlySelected ? speed : "normal (no override)"}${supported(ctx.model) ? "" : " — inactive for this model"}.`,
          "Thinking is unchanged. Faster tiers may consume more allowance; Pi's dollar estimate is not tier-aware here.",
        ];
        if (sample) {
          lines.push(`Last request: ${sample.requestedTier}; server reported: ${sample.reportedTier ?? "not supplied"}; ${sample.status}.`);
          if (sample.visibleTokensPerSecond !== undefined) lines.push(`Text: ${sample.visibleTokensPerSecond.toFixed(1)} tok/s; first text: ${sample.firstTextSeconds?.toFixed(2)}s; total: ${sample.elapsedSeconds.toFixed(2)}s.`);
          if (sample.provider === "openai-codex") lines.push("Codex's reported tier can stay 'default' for faster requests; execution/billing tier is unconfirmed.");
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (!requested && ctx.hasUI) {
        const labels = ["normal — standard tier", "fast — higher usage", "ultrafast — highest usage"];
        const chosen = await ctx.ui.select("Astra speed (does not change thinking)", labels);
        if (!chosen) return;
        requested = SPEEDS[labels.indexOf(chosen)] ?? "";
      }
      const parsed = parseSpeed(requested);
      if (!parsed) {
        ctx.ui.notify("Usage: /speed normal|fast|ultrafast|status", "warning");
        return;
      }
      if (!supported(ctx.model)) {
        ctx.ui.notify("Select openai-codex/gpt-6-astra or openai/gpt-6-astra first.", "warning");
        return;
      }
      // Never change paid routing partway through an active agent/tool loop.
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current response to finish before changing speed.", "warning");
        return;
      }
      select(parsed, ctx);
      ctx.ui.notify(`Astra: ${speed} requested. Thinking unchanged.${speed === "normal" ? "" : " Higher usage/cost applies; Pi's cost estimate may undercount."}`, "info");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    measurement = undefined;
    lastSample = undefined;
    const payload = record(event.payload);
    const model = ctx.model;
    // This event lacks a model field: require both the selected model and wire model to match.
    if (!model || !supported(model) || !payload || payload.model !== model.id) return;
    const tier = explicitlySelected ? wireTier(speed, model.provider) : payload.service_tier;
    const reasoning = record(payload.reasoning);
    measurement = {
      speed,
      requestedTier: typeof tier === "string" ? tier : "omitted",
      model: model.id,
      provider: model.provider,
      reasoningEffort: typeof reasoning?.effort === "string" ? reasoning.effort : undefined,
      startedAt: performance.now(),
    };
    // Override at the payload boundary: streamSimple drops a bare serviceTier option in Pi 1.3.0.
    if (explicitlySelected) return { ...payload, service_tier: tier };
  });

  pi.on("provider_stream_event", (event) => {
    if (!measurement || event.provider !== measurement.provider || event.model !== measurement.model) return;
    const sample = observe(measurement, event.data, performance.now());
    if (!sample) return;
    lastSample = sample;
    measurement = undefined;
    // Optional benchmark observers receive only sanitized timing/token metadata.
    pi.events.emit("openai-speed:sample", sample);
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") measurement = undefined;
  });
}
