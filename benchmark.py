#!/usr/bin/env python3
"""Opt-in, billable benchmark through the installed Pi CLI and its normal credentials."""
import argparse
import datetime
import json
import os
from pathlib import Path
import statistics
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, choices=range(1, 4), default=1)
    parser.add_argument("--thinking", choices=["low", "medium", "high", "xhigh"], default="low")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    extension = Path(__file__).resolve().parent
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = (args.output or Path.home() / ".local/state/pi/speed-benchmarks" / stamp).resolve()
    output.mkdir(parents=True, exist_ok=False)
    prompt = (
        "Write exactly 60 numbered lines. Each line is a different simple factual sentence "
        "about an everyday household object. Use 10 to 14 words per sentence. "
        "No preamble or conclusion."
    )
    version = subprocess.check_output(["pi", "--version"], text=True).strip()
    (output / "metadata.json").write_text(json.dumps({
        "piVersion": version, "prompt": prompt, "thinking": args.thinking,
        "repetitions": args.repetitions, "transport": "Pi configured transport (auto by default)",
        "method": "Sequential fresh sessions, alternating tier order. Same prompt, no tools/context/skills. API usage counts, not chunk counts.",
    }, indent=2) + "\n")
    results = []
    print(f"Results: {output}", flush=True)
    for repetition in range(args.repetitions):
        tiers = ["normal", "fast", "ultrafast"]
        if repetition % 2:
            tiers.reverse()
        for speed in tiers:
            name = f"{repetition + 1}-{speed}"
            report = output / f"{name}.jsonl"
            command = [
                "pi", "--no-extensions", "-e", str(extension / "index.ts"),
                "-e", str(extension / "benchmark-probe.ts"),
                "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files",
                "--no-approve", "--offline", "--no-session",
                "--model", "openai-codex/gpt-6-astra", "--thinking", args.thinking,
                "--speed", speed, "--system-prompt",
                "Follow the user instructions exactly. This is a harmless text generation benchmark.",
                "-p", prompt,
            ]
            env = {**os.environ, "PI_SPEED_BENCHMARK_REPORT": str(report)}
            print(f"Running {name} ...", flush=True)
            with (output / f"{name}-output.txt").open("w") as stdout, (output / f"{name}-stderr.txt").open("w") as stderr:
                try:
                    process = subprocess.run(command, cwd=output, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=120)
                    returncode = process.returncode
                except subprocess.TimeoutExpired:
                    returncode = "timeout"
            events = [json.loads(line) for line in report.read_text().splitlines()] if report.exists() else []
            samples = [e["data"] for e in events if e["kind"] == "sample"]
            assistant = next((e["data"] for e in reversed(events) if e["kind"] == "assistant"), {})
            # Never silently count retries or incomplete responses as clean throughput samples.
            requests = sum(e["kind"] == "request" for e in events)
            clean = returncode == 0 and requests == 1 and len(samples) == 1 and assistant.get("stopReason") == "stop"
            result = {"run": name, "speed": speed, "returncode": returncode, "requestCount": requests, "clean": clean,
                      "sample": samples[-1] if samples else None, "error": assistant.get("errorMessage")}
            results.append(result)
            (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
            if clean and samples[0].get("visibleTokensPerSecond") is not None:
                s = samples[0]
                print(f"  {s['visibleTokensPerSecond']:.1f} visible tok/s; first text {s['firstTextSeconds']:.2f}s; "
                      f"total {s['elapsedSeconds']:.2f}s; {s['visibleTokens']} visible + {s['reasoningTokens']} reasoning tokens; "
                      f"requested {s['requestedTier']}, reported {s.get('reportedTier')}", flush=True)
            else:
                print(f"  NOT A CLEAN SAMPLE: {result}", flush=True)
    print("\nMedian visible text throughput (first-to-last text; excludes startup/reasoning):")
    for speed in ["normal", "fast", "ultrafast"]:
        samples = [r["sample"] for r in results if r["clean"] and r["speed"] == speed and r["sample"].get("visibleTokensPerSecond") is not None]
        if samples:
            print(f"  {speed:9s} {statistics.median(s['visibleTokensPerSecond'] for s in samples):7.1f} tok/s (n={len(samples)})")
    print("Codex's raw reported service tier is NOT authoritative execution/billing confirmation.")


if __name__ == "__main__":
    main()
