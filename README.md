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
gpt-6-astra • xhigh • ultrafast • ↓ 173.3 tok/s
```

Without that footer (or on a narrow terminal), it uses Pi's normal extension
status row. It does **not** replace another extension's footer. Custom footers
must render Pi's extension statuses to show it.

- `/tokens` or `/tokens status` explains the latest response's throughput and timing.
- `/tokens off` hides the display; `/tokens on` enables the next measurement.
- The toggle persists on the session branch. Measurements are in memory only and
  reset on reload, branch navigation, model change, or the next request.
- During a request it shows `waiting…`, `thinking…`, or `streaming…`. The numerical
  rate appears at completion, when the provider supplies final token counts.
  Stream chunks are **not** counted as tokens.
- `tok/s` means approximate **visible-text streaming throughput**, excluding
  startup and reasoning, using Pi's reported output-minus-reasoning tokens.
- `tok/s total` is the fallback: **all output tokens / total request time**, including
  startup and reasoning. This is used for tool calls, length-limited responses,
  single-chunk output, or missing reasoning breakdowns. These two rates are not
  interchangeable. Errors and aborts are not reported as successful measurements.
- Every assistant request is measured separately; time executing tools between
  requests is not included. A retry resets the measurement.

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

Text throughput is approximately:

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

| Requested mode | Visible text tok/s | Versus normal | First text | Total time |
| --- | ---: | ---: | ---: | ---: |
| normal | 28.1 | 1.00x | 3.94 s | 35.28 s |
| fast | 36.5 | 1.30x | 3.93 s | 27.85 s |
| ultrafast | 173.3 | 6.17x | 3.13 s | 8.29 s |

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

## License

[MIT](LICENSE). Not affiliated with OpenAI or the Pi project.
