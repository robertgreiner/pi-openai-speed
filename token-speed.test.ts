import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import tokenSpeed, { finishTokens, tokenLabel, type TokenTiming } from "./token-speed.ts";

const timing: TokenTiming = { provider: "test-provider", model: "test-model", startedAt: 0, firstTextAt: 1000, lastTextAt: 3000, stage: "streaming" };
function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", api: "openai-responses", provider: timing.provider, model: timing.model,
    content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "private text" }],
    usage: { input: 50, output: 120, reasoning: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 170, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0, ...overrides,
  };
}

function harness() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  const samples: unknown[] = [];
  let time = 0;
  let status: string | undefined;
  const ctx = {
    model: { provider: timing.provider, id: timing.model },
    ui: { setStatus: (_key: string, value: string | undefined) => { status = value; }, notify: (text: string) => notifications.push(text) },
    sessionManager: { getBranch: () => entries },
  };
  const pi = {
    on: (event: string, fn: Function) => handlers.set(event, fn),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    events: { emit: (event: string, data: unknown) => { assert.equal(event, "token-speed:sample"); samples.push(data); } },
  };
  tokenSpeed(pi as any, () => time);
  const call = (event: string, data: unknown = {}) => handlers.get(event)!(data, ctx);
  return {
    call, ctx, entries, samples, notifications, status: () => status,
    at: (t: number) => { time = t; },
    delta: (t: number, type = "text_delta", delta = "private") => {
      time = t;
      call("message_update", { message: message(), assistantMessageEvent: { type, delta } });
    },
    command: (args: string) => commands.get("tokens").handler(args, ctx),
  };
}

test("normalized provider usage measures text separately from total output and latency", () => {
  const sample = finishTokens(timing, message(), 4000)!;
  assert.equal(sample.textTokensPerSecond, 50);
  assert.equal(sample.totalTokensPerSecond, 30);
  assert.equal(sample.visibleTokens, 100);
  assert.equal(sample.firstTextSeconds, 1);
  assert.equal(tokenLabel(sample), "↓ 50.0 tok/s");
  assert.doesNotMatch(JSON.stringify(sample), /private/);
});

test("missing or invalid reasoning usage, tool calls and truncation use explicitly labelled total throughput", () => {
  const base = message();
  const cases = [
    message({ usage: { ...base.usage, reasoning: undefined } }),
    message({ usage: { ...base.usage, reasoning: -1 } }),
    message({ usage: { ...base.usage, reasoning: 121 } }),
    message({ usage: { ...base.usage, reasoning: NaN } }),
    message({ content: [...base.content, { type: "toolCall", id: "private-id", name: "read", arguments: {} }], stopReason: "toolUse" }),
    message({ stopReason: "length" }),
  ];
  for (const m of cases) {
    const sample = finishTokens(timing, m, 4000)!;
    assert.equal(sample.textTokensPerSecond, undefined);
    assert.equal(tokenLabel(sample), "↓ 30.0 tok/s total");
  }
  const noReasoning = finishTokens(timing, message({ usage: { ...base.usage, reasoning: 0 } }), 4000)!;
  assert.equal(noReasoning.textTokensPerSecond, 60);
});

test("single-chunk and no-text responses never get a fabricated text rate", () => {
  for (const t of [{ ...timing, lastTextAt: timing.firstTextAt }, { ...timing, firstTextAt: undefined, lastTextAt: undefined }]) {
    assert.equal(finishTokens(t, message(), 4000)!.textTokensPerSecond, undefined);
  }
  const thinkingOnly = message({ content: [{ type: "thinking", thinking: "private" }] });
  assert.equal(finishTokens(timing, thinkingOnly, 4000)!.textTokensPerSecond, undefined);
});

test("errors, aborts, absent usage and invalid timing do not produce samples", () => {
  for (const stopReason of ["error", "aborted", "pending"] as const) assert.equal(finishTokens(timing, message({ stopReason }), 4000), undefined);
  for (const output of [0, -1, NaN, Infinity]) assert.equal(finishTokens(timing, message({ usage: { ...message().usage, output } }), 4000), undefined);
  assert.equal(finishTokens(timing, message(), 0), undefined);
  assert.equal(finishTokens(timing, message(), -1), undefined);
});

test("standalone extension observes any model, preserves request payload and shows phases until final usage", () => {
  const h = harness(); h.call("session_start");
  const payload = { model: timing.model, service_tier: "anything", reasoning: { effort: "high" }, input: ["private"] };
  const copy = structuredClone(payload);
  assert.equal(h.call("before_provider_request", { payload }), undefined);
  assert.deepEqual(payload, copy);
  assert.equal(h.status(), "↓ waiting…");
  h.delta(500, "thinking_delta"); assert.equal(h.status(), "↓ thinking…");
  h.delta(1000); assert.equal(h.status(), "↓ streaming…");
  h.delta(3000); h.at(4000); h.call("message_end", { message: message() });
  assert.equal(h.status(), "↓ 50.0 tok/s");
  h.call("message_end", { message: message() }); h.call("agent_end");
  assert.equal(h.samples.length, 1);
  assert.equal(h.status(), "↓ 50.0 tok/s");
  assert.doesNotMatch(JSON.stringify(h.samples), /private/);
});

test("a retry replaces timing and a new request excludes prior tool execution time", () => {
  const h = harness();
  h.call("before_provider_request"); h.delta(500);
  h.at(1000); h.call("before_provider_request");
  h.delta(2000); h.delta(4000); h.at(5000); h.call("message_end", { message: message() });
  assert.equal((h.samples[0] as any).elapsedSeconds, 4);
  h.at(20000); h.call("before_provider_request");
  h.delta(21000); h.delta(23000); h.at(24000); h.call("message_end", { message: message() });
  assert.equal((h.samples[1] as any).elapsedSeconds, 4);
  assert.equal(h.status(), "↓ 50.0 tok/s");
});

test("unrelated messages are ignored, empty deltas do not count, and failed requests clear placeholders", () => {
  const h = harness(); h.call("before_provider_request");
  h.delta(1000, "text_delta", ""); assert.equal(h.status(), "↓ waiting…");
  h.call("message_end", { message: { role: "user", content: "private" } });
  h.call("message_end", { message: message({ model: "other" }) });
  h.delta(3000); h.at(4000); h.call("message_end", { message: message() });
  assert.equal(h.status(), "↓ 30.0 tok/s total");
  h.call("before_provider_request"); h.at(5000); h.call("message_end", { message: message({ stopReason: "aborted" }) });
  assert.equal(h.status(), undefined);
  h.call("before_provider_request"); h.call("agent_end"); assert.equal(h.status(), undefined);
});

test("toggle persists on branch, restoring a branch or switching model drops stale measurements", async () => {
  const h = harness(); h.call("session_start");
  await h.command("off"); h.call("session_start"); h.call("before_provider_request");
  assert.equal(h.status(), undefined);
  h.entries.length = 0; h.call("session_tree"); h.call("before_provider_request");
  assert.equal(h.status(), "↓ waiting…");
  h.call("model_select"); assert.equal(h.status(), undefined);
  h.call("before_provider_request"); h.call("session_shutdown"); assert.equal(h.status(), undefined);
  await h.command("invalid"); assert.equal(h.entries.length, 0);
  await h.command("on"); assert.equal(h.entries.length, 1);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /No measured response yet/);
});

test("status explains both metrics without including response text", async () => {
  const h = harness(); h.call("before_provider_request");
  h.delta(1000); h.delta(3000); h.at(4000); h.call("message_end", { message: message() });
  await h.command("");
  const status = h.notifications.at(-1)!;
  assert.match(status, /Visible text: 50.0 tok\/s/);
  assert.match(status, /Total: 30.0 output tok\/s/);
  assert.match(status, /First text: 1.00s/);
  assert.doesNotMatch(status, /private/);
});
