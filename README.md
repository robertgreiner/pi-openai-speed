# Pi OpenAI Speed

Normal, Fast, and Ultrafast controls for GPT-6 Astra in [Pi](https://pi.dev).
Requires Pi 1.3.0+. Only `openai-codex/gpt-6-astra` and `openai/gpt-6-astra` are affected.

## Install

```sh
pi install git:github.com/robertgreiner/pi-openai-speed
```

Requires an authenticated supported provider and access to the requested tier.
Installation alone does **not** enable a paid tier. Remove any old manual copy in
`~/.pi/agent/extensions/` before installing to avoid duplicate request hooks.

## Use

Select GPT-6 Astra with `/model`, then:

```text
/reload
/speed ultrafast
```

- `/speed` opens a picker.
- `/speed normal` explicitly requests the standard tier.
- `/speed fast` requests Fast.
- `/speed ultrafast` requests Ultrafast.
- `/speed status` reports the selection, configured default, and last request's raw
  tier metadata and diagnostic visible-text rate.
- `pi --speed ultrafast` opts in at startup; select an Astra model as usual.

Thinking effort is never changed. Selection is stored on the session branch and
survives reload/resume. Switching to another model makes the setting inactive.
Changes are refused during an active turn.

The selected mode appears beside the model and effort:

```text
gpt-6-astra • xhigh • ultrafast
```

This is the **requested** mode, not confirmation of execution or billing tier.
The public custom-footer API retains working directory, branch, session name,
token/cache/cost/context stats, and other extensions' statuses. It restores the
stock footer when inactive. Like any footer replacement, it cannot compose with a
second footer replacement: the last setter wins. Display never changes routing.

Extension statuses use the same muted footer color and share spare space on the
working-directory row. The model/effort/speed/throughput row stays unchanged.
Only statuses that do not fit use an extra row on narrow terminals; explicit
warning/error colors are preserved. Colors follow the active theme.

## Token throughput is now a separate package

Starting with **v0.5.0**, `/tokens` and the provider-neutral throughput observer live
in [pi-token-speed](https://github.com/robertgreiner/pi-token-speed).

To retain them when upgrading from v0.4.0 or earlier:

```sh
pi update git:github.com/robertgreiner/pi-openai-speed
pi install git:github.com/robertgreiner/pi-token-speed
```

Then `/reload` once. Do not load the old bundled `token-speed.ts` alongside the new
package. Existing `/tokens` branch settings survive: its `token-speed-state` entry,
`token-speed` status key, and `token-speed:sample` event are unchanged.

When both are installed, the footer still automatically renders:

```text
gpt-6-astra • xhigh • ultrafast • ↓ 111.3 tok/s
```

The integration reads the optional status entry; there is no hard dependency or
cross-repository source import. Each package works independently. `pi config` can
disable either one. The throughput package documents its measurement semantics.

## Personal default

Create `~/.pi/agent/openai-speed.json` (or under `PI_CODING_AGENT_DIR`):

```json
{ "defaultSpeed": "ultrafast" }
```

Valid values: `normal`, `fast`, `ultrafast`. Remove the property or file for no
override. This is a deliberate cost/allowance opt-in; the package never creates it.
`/reload` rereads it. Precedence: startup `--speed` → saved branch choice → personal
default → no override. Later `/speed` choices persist on that branch. Malformed
defaults warn and apply no default override. Models and thinking remain unchanged.

For matching startup defaults, merge into Pi's `settings.json`:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-6-astra",
  "defaultThinkingLevel": "xhigh"
}
```

Per-model thinking settings can override the global default; set
`modelThinkingLevels["openai-codex/gpt-6-astra"]` to `"xhigh"` if necessary.
Resuming an existing session retains its model, thinking, and explicit speed.

## Wire behavior and caveats

| Selection | Codex OAuth | OpenAI Responses |
| --- | --- | --- |
| normal | `service_tier: "default"` | `service_tier: "default"` |
| fast | `service_tier: "priority"` | `service_tier: "fast"` |
| ultrafast | `service_tier: "ultrafast"` | `service_tier: "ultrafast"` |

Only this payload field is changed by `before_provider_request`; models,
endpoints, credentials, instructions, tools, and reasoning are untouched. Pi
1.3.0's simple-stream path drops a bare `serviceTier` option, hence the payload hook.
The Codex path was live-tested; the API-key path follows OpenAI documentation but
was not live-tested. The extension never hides rejections or retries on a cheaper
tier. Upstream routing may still downgrade requests.

**Cost:** OpenAI's Codex documentation lists Fast at 2.5x included subscription
usage / 2x purchased-credit rates, and Ultrafast at 8x / 6x respectively. Eligibility
applies. API-key rates are separate. Pi's built-in dollar estimate is **not reliable
for these overrides**; no speculative billing correction is made.

**Reporting:** Codex OAuth may echo `service_tier: "default"` on faster requests.
Keep requested tier, reported metadata, and observed throughput separate. Speed
alone does not establish execution or billing tier.

**Virtual routing:** the scope guard requires both the selected physical Astra
model and matching wire model. A virtual model selection does not inherit the
speed override. No automatic routing is implemented.

## Diagnostic timing and privacy

The in-memory last sample, also available through local `openai-speed:sample`,
contains numeric timing/usage and provider/model metadata only. No prompts,
response text, account IDs, headers, or credentials are retained.

Visible-text burst rate is approximately `(output_tokens - reasoning_tokens) /
(last text delta time - first text delta time)`. It excludes startup/queueing and
hidden reasoning. First-text latency and total request time are separate. Short
replies and buffered chunks can inflate it. No text rate is reported for incomplete
output, tool calls, unknown reasoning counts, or a single chunk. This diagnostic
is not the separate token-speed package's turn-wide footer rate.

## Development and opt-in benchmark

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

CI runs unit/footer tests and typechecking on Node 22/24/26, without credentials or
live requests. Pi supplies runtime dependencies.

The benchmark **makes billable/allowance-consuming requests**, three per repetition:

```sh
python3 benchmark.py --repetitions 2
```

It uses sequential fresh sessions, identical prompts, low reasoning, no tools,
project/user context, or skills. The second repetition reverses tier order. Each
response requests 60 numbered sentences. `--thinking xhigh` runs a separate
reasoning-inclusive experiment. Requests time out after 120 seconds; failed,
incomplete, or retried requests are excluded from clean samples.

Private artifacts go under `~/.local/state/pi/speed-benchmarks/<timestamp>/` and
include timing, usage, generated benchmark text, errors, and aggregate JSON, never
credentials or HTTP headers. Normal Pi settings are not modified.

### Measurements from 2026-10-20 (unchanged historical benchmark)

Six clean requests, two per tier, 5,916 total tokens before tier multipliers. Medians:

| Requested | Full-request output tok/s | Visible text tok/s | First text | Total |
| --- | ---: | ---: | ---: | ---: |
| normal | 25.5 | 28.1 | 3.94 s | 35.28 s |
| fast | 31.8 | 36.5 | 3.93 s | 27.85 s |
| ultrafast | 111.3 | 173.3 | 3.13 s | 8.29 s |

All reported raw `service_tier: "default"`. These are small local diagnostics, not
a performance guarantee, billing confirmation, or a live OpenCode comparison.
The full-request column was recomputed from saved samples without new calls. An
additional 20-line Ultrafast pilot observed 354.2 visible tok/s and is not in the table.
The package extraction did not rerun this paid benchmark.

## References

- [Codex speed, eligibility, usage](https://developers.openai.com/codex/speed/)
- [Priority processing](https://developers.openai.com/api/docs/guides/priority-processing)
- [Ultrafast configuration](https://developers.openai.com/api/docs/guides/ultrafast-mode)
- [Pi serviceTier issue report](https://github.com/earendil-works/pi/issues/11040)
- [Codex tier observability issue report](https://github.com/openai/codex/issues/54952)

Issue reports are not official guarantees. MIT; not affiliated with Pi or OpenAI.
