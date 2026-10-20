# Pi OpenAI Speed

Normal, Fast, and Ultrafast controls for GPT-6 Astra in [Pi](https://pi.dev),
with client-observed token throughput and transparent service-tier reporting.

Tested with Pi 1.3.0 on 2026-10-20. No runtime dependencies outside Pi. Tier controls
only affect `openai-codex/gpt-6-astra` and `openai/gpt-6-astra`. The separate
**token throughput extension** observes any model without changing requests.

## Install

```sh
pi install git:github.com/robertgreiner/pi-openai-speed
```

Requires Pi 1.3.0 or later, an authenticated supported provider, and access to
the requested tier. Only Pi 1.3.0 has been tested. Review the [cost and reporting
caveats](#wire-behavior-and-caveats) before opting in. Installation alone does
not enable a faster tier.

If you previously installed a manual copy in `~/.pi/agent/extensions/`, remove
or move that copy out of the discovery directory before installing this package,
to avoid duplicate commands and request hooks.

## Use

Select GPT-6 Astra through `/model`, then:

```text
/reload
/speed ultrafast
```

- `/speed` opens a picker.
- `/speed normal` explicitly requests the standard tier.
- `/speed fast` requests Fast.
- `/speed ultrafast` requests Ultrafast.
- `/speed status` shows the selection, last completed request's raw tier metadata,
  and text tokens/second when measurable.
- `pi --speed ultrafast` opts in at startup (select an Astra model as usual).

Thinking effort is never changed. Selection is stored on the session branch and
survives reload/resume; new sessions have **no override** unless `--speed` is used.
Switching to another model makes the setting inactive. Commands refuse to change
speed while a turn is running. The selected mode appears beside the model and
thinking level, without an extra speed status row:

```text
gpt-6-astra • xhigh • ultrafast
```

This is the **requested** mode, not a confirmation of execution or billing tier.
Use `/speed status` for the full requested-versus-reported details.

The inline display uses Pi's public custom-footer API, retaining the working
directory, git branch, session name, token/cache/cost/context stats, and other
extensions' status messages. It restores Pi's stock footer when inactive. Like
other custom footers, it cannot compose with a second footer replacement; the
last extension to set a footer wins. This affects display only, never routing.

## Token throughput display

The package also loads the independent `token-speed.ts` extension. It is on by
default and never changes models, tiers, thinking effort, or request payloads.
With the Astra speed footer active, a completed response looks like:

```text
gpt-6-astra • xhigh • ultrafast • ↓ 111.3 tok/s
```

Since v0.3.0, the footer uses **OpenCode-style turn throughput**:

```text
sum(output tokens, including reasoning) / sum(request durations in seconds)
```

It aggregates counts and durations before dividing, not the average of individual
request rates. Each duration runs from Pi's `before_provider_request` hook to the
final assistant message, including startup, queueing, and reasoning. Time between
requests (tools, approvals, and retry backoff) is excluded. This is provider-active
throughput, **not** wall-clock task speed. Pi's boundaries differ slightly from
OpenCode's, so this is the same style of metric, not bit-for-bit timing parity.

Without that footer (or on a narrow terminal), it uses Pi's normal extension
status row. It does **not** replace another extension's footer. Custom footers
must render Pi's extension statuses to show it.

- `/tokens` or `/tokens status` shows the turn aggregate and the latest request's
  full-request rate, visible-text streaming rate (when measurable), and latency.
- `/tokens off` hides the display; `/tokens on` enables the next turn. Change the
  toggle while idle so a partial turn cannot be mistaken for a complete measurement.
- The toggle persists on the session branch. Measurements are in memory only and
  reset on reload, branch navigation, idle model change, or the next turn.
- A turn includes model/tool steps and automatic continuations until Pi emits
  `agent_settled`. Model changes during that turn do not reset the aggregate.
- During a request it shows `waiting…`, `thinking…`, or `streaming…`. After each
  completed request, the footer shows the turn-so-far rate using final usage counts.
  Stream chunks are **not** counted as tokens.
- `tok/s` always means the same turn-wide metric, including tool-call output and
  reasoning. Pi's output count already includes reasoning; it is not added twice.
  A separate reasoning breakdown is not required. Zero-output successful requests
  still contribute their duration.
- A retry resets only that attempt's clock, preserving earlier successful steps.
  Failed attempts are excluded; errors and aborts hide the rate. A successful step
  without valid timing or usage suppresses the turn rate rather than showing a
  misleading average of only the measurable subset.

The older **text-burst rate** is still available in `/tokens status` and
`/speed status`, but no longer drives the footer. Short replies and buffered
chunks can make that rate look very high because it omits first-text latency.

No tokenization guesses or extra API requests are made. Numeric metadata plus
provider/model names are emitted locally as `token-speed:sample`; no prompt,
response text, IDs, or credentials are included. See [Timing](#timing) for the
measurement limitations.

Use `pi config` to disable either extension independently. For a
one-off session with only throughput, from this checkout:

```sh
pi --no-extensions -e ./token-speed.ts
```

Already installed? Update the package, then `/reload` in running sessions:

```sh
pi update git:github.com/robertgreiner/pi-openai-speed
```

## Wire behavior and caveats

| Selection | Codex OAuth (`openai-codex`) | OpenAI Responses (`openai`) |
| --- | --- | --- |
| normal | `service_tier: "default"` | `service_tier: "default"` |
| fast | `service_tier: "priority"` | `service_tier: "fast"` |
| ultrafast | `service_tier: "ultrafast"` | `service_tier: "ultrafast"` |

The `before_provider_request` hook replaces only this payload field; it does not
change models, endpoints, credentials, instructions, tools, or reasoning.
The Codex path was live-tested. The public OpenAI API mapping follows its docs
but was not live-tested with an API key.

Pi 1.3.0's simple-stream path drops a bare `serviceTier` option, so the override
is applied at the payload boundary instead. This extension does not retry with a
cheaper tier or hide rejections. Upstream routing can still downgrade requests.

**Cost:** OpenAI's Codex documentation currently lists Fast at 2.5x included
subscription usage / 2x purchased-credit rates, and Ultrafast at 8x included
usage / 6x purchased-credit rates. Eligibility applies. API-key rates are separate.
Pi's built-in dollar estimate is **not reliable for these overrides**. This
extension deliberately does not invent billing corrections from timing data.

**Reporting:** Codex OAuth may echo `service_tier: "default"` even on faster
requests. Keep requested tier, raw metadata, and measured speed separate. Speed
alone does not authoritatively confirm execution or billing tier.

## Timing

No prompts, response text, account identifiers, headers, or credentials are
retained by the extension. The last sample stays in memory, and is optionally
published on Pi's `openai-speed:sample` extension event for a benchmark observer.

The diagnostic **text-burst** throughput (not the footer's turn rate) is approximately:

```text
(output_tokens - output_tokens_details.reasoning_tokens)
    / (last received text delta time - first received text delta time)
```

Token counts come from the API, not characters or SSE/WebSocket chunk counts.
This excludes startup/queueing and hidden reasoning time. First-text latency and
total request time are separate. Small samples, chunk buffering, and the initial
chunk make this an approximate client-observed decode rate. No text rate is
reported for incomplete output, tool calls, unknown reasoning-token counts, or a
single text chunk. End-to-end output throughput includes reasoning tokens and
uses total request time.

## Development and tests

Clone the repository and use Node 22.19+:

```sh
git clone https://github.com/robertgreiner/pi-openai-speed.git
cd pi-openai-speed
npm ci --ignore-scripts
npm test
npm run typecheck
```

Pi provides its extension API and TUI utilities at runtime; the pinned development
dependencies are for tests and typechecking. CI runs unit and footer-layout tests
and typechecking without credentials or live model requests.

## Opt-in benchmark

From the repository checkout, with Python 3 and an authenticated Pi on your PATH:

**This benchmark makes billable/allowance-consuming requests**, three per
repetition, using Pi's existing credentials:

```sh
python3 benchmark.py --repetitions 2
```

It makes sequential, fresh-session requests with identical prompts, no tools,
no project/user context files or skills, and low reasoning by default. The second
repetition reverses tier order. It does not change normal Pi settings. Each
response requests 60 short numbered sentences. Use `--thinking xhigh` for a
separate reasoning-inclusive experiment. Requests time out after 120 seconds;
failed/incomplete responses or multiple attempts are excluded from clean samples.

Artifacts are private files under `~/.local/state/pi/speed-benchmarks/<timestamp>/`:
request tier, timing/token metadata, generated benchmark text, errors, and an
aggregate JSON file. No credentials or HTTP headers are logged.

## Measured on 2026-10-20

Six clean requests, two per tier, 60 lines each, low reasoning, no cached input.
All completed; 5,916 total input/output tokens, before tier usage multipliers.
Medians:

| Requested mode | Full-request output tok/s | Visible text tok/s | First text | Total time |
| --- | ---: | ---: | ---: | ---: |
| normal | 25.5 | 28.1 | 3.94 s | 35.28 s |
| fast | 31.8 | 36.5 | 3.93 s | 27.85 s |
| ultrafast | 111.3 | 173.3 | 3.13 s | 8.29 s |

Each benchmark turn contains one request. The full-request column is the median
of each request's output tokens (including reasoning) divided by its elapsed time,
recomputed from the same saved samples without new model calls. It corresponds to
the v0.3.0 footer's metric; the visible-text column remains a separate diagnostic.
This was not a live OpenCode benchmark.

All six reported raw `service_tier: "default"`. This is a small local diagnostic,
not a performance guarantee or authoritative billing-tier confirmation. An
additional 20-line Ultrafast pilot completed at 354.2 visible tok/s (not included
in the table).

Only the aggregate measurements are published here. Raw local benchmark files,
credentials, and session history are not included in this repository.

## Research

- [OpenAI Codex speed, eligibility, and usage multipliers](https://developers.openai.com/codex/speed/)
- [OpenAI Fast/priority request configuration](https://developers.openai.com/api/docs/guides/priority-processing)
- [OpenAI Ultrafast request configuration](https://developers.openai.com/api/docs/guides/ultrafast-mode)
- [Pi simple-stream serviceTier omission](https://github.com/earendil-works/pi/issues/11040)
- [Codex OAuth tier observability report](https://github.com/openai/codex/issues/54952)

The last two are issue reports, not official guarantees. The local tests verify
request payloads, successful completion, and measured throughput independently.

The turn-rate design follows [OpenCode v2.0.32's `turnTokensPerSecond`](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/tui/src/routes/session/rows.ts#L442).
Our tests reproduce its multi-request fixture and additionally cover weighted
aggregation, retries, settlement boundaries, missing samples, and zero output.

## License

[MIT](LICENSE). Not affiliated with OpenAI or the Pi project.
