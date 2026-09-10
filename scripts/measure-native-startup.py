#!/usr/bin/env python3
"""Measure pre-spawn -> WKWebView FCP without building or touching app settings.

This includes spawn-call overhead and is a conservative approximation of exec -> FCP.
Run only with an unlocked, foreground desktop and no builds/capture/profilers active.
See docs/research/native-performance-timing-2026-09-09.md.
"""
import argparse
import json
import os
import plistlib
from pathlib import Path
import statistics
import subprocess
import time


def console_locked():
    status = subprocess.check_output(["ioreg", "-n", "Root", "-d1", "-a"])
    return bool(plistlib.loads(status).get("IOConsoleLocked", True))


def measure(binary, paint_log, count, output, activate_helper):
    if output.exists():
        raise SystemExit("Refusing to overwrite an existing measurement")
    samples = []
    for index in range(count):
        if console_locked():
            sample = {"run": index, "valid": False, "error": "console locked before launch"}
            samples.append(sample)
            print(json.dumps(sample), flush=True)
            break
        offset = paint_log.stat().st_size if paint_log.exists() else 0
        with output.with_suffix(f".run-{index}.log").open("w") as log:
            env = {**os.environ, "BRIGADIER_TRACE": "1"}
            before_mono = time.monotonic_ns() / 1e6
            before_epoch = time.time_ns() / 1e6
            child = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
            paint = None
            try:
                activation = subprocess.run([str(activate_helper.resolve()), str(child.pid)], stdout=log, stderr=log)
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline and child.poll() is None:
                    if paint_log.exists():
                        with paint_log.open() as stream:
                            stream.seek(offset)
                            for line in stream:
                                try:
                                    entry = json.loads(line)
                                except json.JSONDecodeError:
                                    continue
                                if entry.get("kind") == "fcp" and entry.get("process_start_epoch_ms", 0) >= before_epoch:
                                    paint = entry
                                    break
                    if paint is not None:
                        break
                    time.sleep(0.02)
                clock_discontinuity = abs(
                    (time.time_ns() / 1e6 - before_epoch)
                    - (time.monotonic_ns() / 1e6 - before_mono)
                )
                elapsed = paint["epoch_ms"] - before_epoch if paint else None
                sample = {
                    "run": index,
                    "activation_exit": activation.returncode,
                    "pre_spawn_epoch_ms": before_epoch,
                    "paint": paint,
                    "pre_spawn_to_fcp_ms": elapsed,
                    "clock_discontinuity_ms": clock_discontinuity,
                    "console_locked_after": console_locked(),
                    "valid": activation.returncode == 0 and elapsed is not None and elapsed > 0 and clock_discontinuity < 10,
                }
                sample["valid"] = sample["valid"] and not sample["console_locked_after"]
                samples.append(sample)
                print(json.dumps(sample), flush=True)
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
        time.sleep(2)
    complete = len(samples) == count and all(s["valid"] for s in samples)
    median = statistics.median(s["pre_spawn_to_fcp_ms"] for s in samples) if complete else None
    result = {
        "binary": str(binary), "paint_log": str(paint_log), "requested_runs": count, "samples": samples,
        "p50_ms": median, "pass": complete and median <= 295,
        "limitations": "Warm-cache launches. Pre-spawn includes launch-call overhead. FCP is not presentation or workspace readiness. Operator must verify unlocked foreground conditions.",
    }
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"p50_ms": median, "pass": result["pass"]}))
    return result["pass"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--activate-helper", type=Path, required=True)
    parser.add_argument("--paint-log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=10)
    args = parser.parse_args()
    if args.runs < 3:
        parser.error("at least three independent launches are required")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    raise SystemExit(0 if measure(args.binary.resolve(), args.paint_log, args.runs, args.output, args.activate_helper) else 1)
