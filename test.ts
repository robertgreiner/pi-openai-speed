import assert from "node:assert/strict";
import test from "node:test";
import extension, { parseSpeed, supported, wireTier } from "./index.ts";
import { observe, type Measurement } from "./metrics.ts";

const astra = { provider: "openai-codex", id: "gpt-6-astra", api: "openai-codex-responses" };
function harness(flag?: string) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  const emitted: unknown[] = [];
  let status: string | undefined;
  let footer: unknown;
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag: () => {},
    getFlag: () => flag,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    events: { emit: (_name: string, data: unknown) => emitted.push(data) },
  };
  const ctx = {
    model: { ...astra }, mode: "print", hasUI: false, isIdle: () => true,
    ui: {
      setStatus: (_key: string, value: string | undefined) => { status = value; },
      setFooter: (factory: unknown) => { footer = factory; },
      notify: (message: string) => notifications.push(message),
    },
    sessionManager: { getBranch: () => entries },
  };
  extension(pi as any);
  const call = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  return { ctx, entries, notifications, emitted, call, command: commands.get("speed").handler, status: () => status, footer: () => footer };
}

test("wire values and strict scope", () => {
  assert.equal(wireTier("normal", "openai-codex"), "default");
  assert.equal(wireTier("fast", "openai-codex"), "priority");
  assert.equal(wireTier("fast", "openai"), "fast");
  assert.equal(wireTier("ultrafast", "openai-codex"), "ultrafast");
  assert.equal(parseSpeed("invalid"), undefined);
  assert.equal(supported(astra), true);
  assert.equal(supported({ ...astra, provider: "anthropic" }), false);
  assert.equal(supported({ ...astra, id: "gpt-6-sol" }), false);
});

test("no override until selected; request changes only service_tier", async () => {
  const h = harness(); h.call("session_start", { reason: "startup" });
  const payload = { model: astra.id, reasoning: { effort: "xhigh" }, tools: [{ name: "read" }], input: [], store: false };
  assert.equal(h.call("before_provider_request", { payload }), undefined);
  await h.command("ultrafast", h.ctx);
  assert.deepEqual(h.call("before_provider_request", { payload }), { ...payload, service_tier: "ultrafast" });
  assert.equal((payload as any).service_tier, undefined);
  assert.match(h.status()!, /requested/);
  assert.equal(h.call("before_provider_request", { payload: { ...payload, model: "another-model" } }), undefined);
  h.ctx.model.provider = "another-provider";
  assert.equal(h.call("before_provider_request", { payload }), undefined);
});

test("CLI setting persists; reload does not undo a later command; branches restore", async () => {
  const h = harness("ultrafast"); h.call("session_start", { reason: "startup" });
  assert.match(h.status()!, /ultrafast/);
  await h.command("fast", h.ctx);
  h.call("session_start", { reason: "reload" });
  assert.match(h.status()!, /fast/);
  assert.doesNotMatch(h.status()!, /ultrafast/);
  h.entries.pop(); h.call("session_tree");
  assert.match(h.status()!, /ultrafast/);
  h.entries.length = 0; h.call("session_start", { reason: "new" });
  assert.equal(h.status(), undefined);
});

test("invalid selection and active turns do not change state; normal resets tier", async () => {
  const h = harness("fast"); h.call("session_start", { reason: "startup" });
  await h.command("bogus", h.ctx);
  assert.equal(h.entries.length, 1);
  h.ctx.isIdle = () => false;
  await h.command("ultrafast", h.ctx);
  assert.equal(h.entries.length, 1);
  h.ctx.isIdle = () => true;
  await h.command("normal", h.ctx);
  assert.equal(h.call("before_provider_request", { payload: { model: astra.id, service_tier: "ultrafast" } }).service_tier, "default");
});

test("TUI uses an inline footer only for supported models and restores it on shutdown", async () => {
  const h = harness(); h.ctx.mode = "tui";
  h.call("session_start", { reason: "startup" });
  assert.equal(h.footer(), undefined);
  await h.command("ultrafast", h.ctx);
  assert.equal(typeof h.footer(), "function");
  assert.equal(h.status(), undefined);
  h.ctx.model.id = "other-model";
  h.call("model_select");
  assert.equal(h.footer(), undefined);
  h.ctx.model.id = astra.id;
  h.call("model_select");
  assert.equal(typeof h.footer(), "function");
  h.call("session_shutdown");
  assert.equal(h.footer(), undefined);
});

function measurement(): Measurement {
  return { speed: "ultrafast", requestedTier: "ultrafast", provider: astra.provider, model: astra.id, startedAt: 0 };
}
function completed(output: unknown[] = [{ type: "reasoning" }, { type: "message" }]) {
  return {
    type: "response.completed", response: {
      status: "completed", service_tier: "default", output,
      usage: { input_tokens: 50, output_tokens: 120, output_tokens_details: { reasoning_tokens: 20 }, input_tokens_details: { cached_tokens: 0 } },
    },
  };
}

test("throughput uses usage tokens minus hidden reasoning, not chunks; preserves raw tier", () => {
  const m = measurement();
  observe(m, { type: "response.output_text.delta", delta: "first" }, 1000);
  observe(m, { type: "response.output_text.delta", delta: "last" }, 3000);
  const sample = observe(m, completed(), 4000)!;
  assert.equal(sample.visibleTokens, 100);
  assert.equal(sample.visibleTokensPerSecond, 50);
  assert.equal(sample.outputTokensPerSecond, 30);
  assert.equal(sample.firstTextSeconds, 1);
  assert.equal(sample.reportedTier, "default");
  assert.equal(sample.requestedTier, "ultrafast");
  assert.equal(JSON.stringify(sample).includes("first" + '"'), false);
});

test("no false text rate for tools, missing reasoning counts, incomplete or single-chunk streams", () => {
  const m = measurement();
  observe(m, { type: "response.output_text.delta", delta: "one" }, 1000);
  assert.equal(observe(m, completed(), 2000)!.visibleTokensPerSecond, undefined);
  observe(m, { type: "response.output_text.delta", delta: "two" }, 2000);
  assert.equal(observe(m, completed([{ type: "function_call" }]), 3000)!.visibleTokensPerSecond, undefined);
  const missing = completed(); delete (missing.response.usage as any).output_tokens_details;
  assert.equal(observe(m, missing, 3000)!.visibleTokensPerSecond, undefined);
  const partial = completed(); partial.response.status = "incomplete"; partial.type = "response.incomplete";
  assert.equal(observe(m, partial, 3000)!.visibleTokensPerSecond, undefined);
});

test("measurement event is sanitized and emitted once", () => {
  const h = harness("ultrafast"); h.call("session_start", { reason: "startup" });
  h.call("before_provider_request", { payload: { model: astra.id, reasoning: { effort: "xhigh" }, input: ["private"] } });
  h.call("provider_stream_event", { ...astra, model: astra.id, data: completed() });
  h.call("provider_stream_event", { ...astra, model: astra.id, data: completed() });
  assert.equal(h.emitted.length, 1);
  assert.equal(JSON.stringify(h.emitted).includes("private"), false);
});
