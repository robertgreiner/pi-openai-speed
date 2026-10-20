import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { alignStats, createSpeedFooter, homePath } from "./footer.ts";

function harness() {
  let leaf = "first";
  let thinking: "xhigh" | "high" = "xhigh";
  let auto = true;
  let reads = 0;
  let disposals = 0;
  let renders = 0;
  let onBranch: (() => void) | undefined;
  const entries: any[] = [
    { type: "message", message: { role: "assistant", usage: { input: 100, output: 200, cacheRead: 900, cacheWrite: 0, cost: { total: 0.25 } } } },
    { type: "compaction", usage: { input: 20, output: 30, cost: { total: 0.05 } } },
    { type: "usage", usage: { input: 5, output: 10, cost: { total: 0.02 } } },
    { type: "message", message: { role: "toolResult", usage: { input: 1, output: 2, cost: { total: 0.01 } } } },
  ];
  const statuses = new Map<string, string>();
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 1_000_000, reasoning: true },
    sessionManager: {
      getSessionId: () => "test",
      getLeafId: () => leaf,
      getCwd: () => "/tmp/世界/project",
      getSessionName: () => "session",
      getEntries: () => { reads++; return entries; },
    },
    modelRegistry: { isUsingOAuth: () => true },
    getContextUsage: () => ({ percent: 12.5, contextWindow: 1_000_000, tokens: 125_000 }),
  } as unknown as ExtensionContext;
  const pi = {
    getThinkingLevel: () => thinking,
    getSettings: () => ({ compaction: { enabled: auto } }),
  } as Pick<ExtensionAPI, "getThinkingLevel" | "getSettings">;
  const data: ReadonlyFooterDataProvider = {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => statuses,
    onBranchChange: (fn) => { onBranch = fn; return () => { disposals++; }; },
  };
  const theme = { fg: (_color: string, text: string) => `\x1b[38;5;244m${text}\x1b[39m` } as Theme;
  const footer = createSpeedFooter(ctx, pi, { requestRender: () => { renders++; } }, theme, data, () => "ultrafast");
  return {
    footer, statuses, entries, ctx,
    plain: (width: number) => footer.render(width).map(stripTerminalSequences),
    moveLeaf: () => { leaf += "x"; },
    thinking: () => { thinking = "high"; },
    disableAuto: () => { auto = false; },
    branch: () => onBranch?.(),
    counters: () => ({ reads, disposals, renders }),
  };
}

test("speed shares the model/effort row; usage, branch, context, and subscription survive", () => {
  const h = harness();
  const lines = h.plain(160);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /世界\/project \(main\) • session/);
  assert.match(lines[1], /gpt-6-astra • xhigh • ultrafast$/);
  assert.match(lines[1], /↑126 ↓242 R900 CH90.0% \$0.330 \(sub\) 12.5%\/1.0M \(auto\)/);
  assert.doesNotMatch(lines.join("\n"), /speed:|\(requested\)/);
  h.thinking(); h.disableAuto();
  assert.match(h.plain(160)[1], /gpt-6-astra • high • ultrafast$/);
  assert.doesNotMatch(h.plain(160)[1], /\(auto\)/);
});

test("all terminal widths are bounded, including ANSI styles and wide Unicode", () => {
  const h = harness();
  h.statuses.set("other", "other extension 世界 世界 世界");
  for (let width = 1; width <= 180; width++) {
    for (const line of h.footer.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }
  assert.deepEqual(h.footer.render(0), []);
  assert.equal(h.plain(35).length, 3);
  assert.match(h.plain(35)[1], /gpt-6-astra • xhigh • ultrafast$/);
});

test("other extensions retain their status row, but speed never duplicates it", () => {
  const h = harness();
  h.statuses.set("z", "last\nstatus"); h.statuses.set("a", "first");
  h.statuses.set("openai-speed", "speed:ultrafast (requested)");
  assert.equal(h.plain(160)[2], "first last status");
});

test("cache avoids rescanning history each frame and branch watcher is disposed", () => {
  const h = harness(); h.footer.render(160); h.footer.render(80);
  assert.equal(h.counters().reads, 1);
  h.moveLeaf(); h.footer.render(80);
  assert.equal(h.counters().reads, 2);
  h.footer.invalidate(); h.footer.render(80);
  assert.equal(h.counters().reads, 3);
  h.branch(); assert.equal(h.counters().renders, 1);
  h.footer.dispose(); assert.equal(h.counters().disposals, 1);
});

test("path shortening uses path boundaries; alignment keeps the right label intact", () => {
  assert.equal(homePath("/home/person/work", "/home/person"), "~/work");
  assert.equal(homePath("/home/person", "/home/person"), "~");
  assert.equal(homePath("/home/person-two/work", "/home/person"), "/home/person-two/work");
  assert.equal(homePath("/home/person/work", undefined), "/home/person/work");
  assert.equal(stripTerminalSequences(alignStats("many many many stats", "model • fast", 16)), "m…  model • fast");
});
