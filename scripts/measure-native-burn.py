#!/usr/bin/env python3
"""Run an isolated app built with VITE_BURN=1, --features burn, and ?burn=auto.

The window must stay visible. No build, UI automation, screen capture, or profiler
may run during this acceptance workload. Raw results are never filtered.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import plistlib
import subprocess
import time


def locked():
    data = subprocess.check_output(["ioreg", "-n", "Root", "-d1", "-a"])
    return bool(plistlib.loads(data).get("IOConsoleLocked", True))


# The audited workload, pinned by `main`'s `expected` against `capture["workload"]`: 60 s at
# 200 rows/s. The delivery clause below is stated in these terms rather than read out of the
# producer report, so a producer that misreports its own configuration cannot relax it.
WORKLOAD_SECONDS = 60
# Per-second floor over those 60 seconds. Nominal is 200 events/s, and every one of the 600 audited
# seconds in the recorded passing run (docs/performance/2026-09-10/live-history-release-burn-1.json)
# carries 199-201. Half the nominal rate is a 2x margin against a scheduling hiccup shifting events
# across a bin boundary, and still fails a session that front-loads its events and then trickles
# just enough to keep a bin non-empty.
MIN_EVENTS_PER_SECOND = 100


def verify_delivery(data_dir, producer, capture):
    """Audit producer → durable envelopes → terminal UI counters, after capture."""
    errors, sessions = [], []
    ids = (producer or {}).get("sessionIds", [])
    frontend = {s["id"]: s for s in (capture or {}).get("delivery", {}).get("sessions", [])}
    # Harness configuration check, not delivery evidence. `src-tauri/src/burn.rs` stamps
    # `startedElapsedMs` before its sleep-then-kill task and `killedElapsedMs` after that task's
    # `sleep(duration)`, so `lifetimeMs >= durationS * 1000` holds for every session by
    # construction, whatever the app did. It can catch a mistyped `durationS` or a producer report
    # that lost its entry; it can never catch a session that stalled or died early. What the app
    # actually delivered is proven by the per-second bins below, off the durable stream.
    # A missing or self-inconsistent entry is a failed audit, never a silent pass.
    lifetimes = {entry.get("sessionId"): entry
                 for entry in (producer or {}).get("sessionLifetimes", []) or []
                 if isinstance(entry, dict)}
    if len(ids) != 10 or len(set(ids)) != 10:
        errors.append("Expected ten distinct producer sessions")
    for session_id in ids:
        path = data_dir / "raw" / (session_id + ".ndjson")
        if not path.is_file():
            errors.append(f"{session_id}: raw log missing")
            continue
        try:
            events = [json.loads(line) for line in path.read_text().splitlines() if line]
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"{session_id}: unreadable raw log: {error}")
            continue
        if not events:
            errors.append(f"{session_id}: empty raw log")
            continue
        kinds = Counter(e["event"]["type"] for e in events)
        contiguous = all(e["seq"] == i + 1 and e["session_id"] == session_id for i, e in enumerate(events))
        # Canonical terse_line excludes these event types; this fixture has no deltas/updates.
        rows = sum(n for kind, n in kinds.items() if kind not in {"turn-started", "content-delta", "item-updated"})
        ui = frontend.get(session_id, {})
        first, last = events[0]["at"], events[-1]["at"]
        per_second = Counter((e["at"] - first) // 1000 for e in events if e["event"]["type"] != "session-exited")
        last_item_seq = max((e["seq"] for e in events if e["event"]["type"] in {"item-started", "item-updated", "item-completed"}), default=0)
        life = lifetimes.get(session_id) or {}
        stamps = [life.get(field) for field in ("startedElapsedMs", "killedElapsedMs", "lifetimeMs")]
        entry = {"lastItemSeq": last_item_seq, "session": session_id, "events": len(events), "rows": rows,
                 "first": first, "last": last, "spanMs": last - first,
                 "startedElapsedMs": stamps[0], "killedElapsedMs": stamps[1], "lifetimeMs": stamps[2],
                 "contiguous": contiguous, "kinds": dict(kinds), "perSecond": dict(sorted(per_second.items()))}
        sessions.append(entry)
        if not contiguous or kinds.get("session-exited") != 1 or events[-1]["event"]["type"] != "session-exited":
            errors.append(f"{session_id}: incomplete durable event stream")
        if len(events) - 1 < 12000:
            errors.append(f"{session_id}: less than 12,000 workload events")
        # The delivery clause. Nothing in the harness can manufacture these bins: each one exists
        # only because a durable envelope carried an `at` inside it, so a 60th bin requires an
        # envelope at >= 59,000 ms past the first. That makes it immune to the 1 ms quantization
        # that failed a real run at spanMs 59,999 — that run's bins are 0..59, all 199-201 — while
        # still failing any session that went quiet mid-run.
        covered = sorted(per_second)
        if set(range(WORKLOAD_SECONDS)) - set(covered) or covered != list(range(len(covered))):
            gaps = [b for b in range(max(covered, default=-1) + 1) if b not in per_second]
            errors.append(f"{session_id}: durable stream does not cover {WORKLOAD_SECONDS} one-second bins contiguous from its first envelope "
                          f"(bins {len(covered)}, last {max(covered, default=None)}, empty {gaps[:8]})")
        starved = [(b, per_second[b]) for b in range(WORKLOAD_SECONDS) if 0 < per_second.get(b, 0) < MIN_EVENTS_PER_SECOND]
        if starved:
            errors.append(f"{session_id}: durable stream fell under {MIN_EVENTS_PER_SECOND} events in a second it was supposed to be delivering 200 "
                          f"(second, events: {starved[:8]})")
        if any(not isinstance(v, int) or isinstance(v, bool) for v in stamps):
            errors.append(f"{session_id}: harness check: producer report carries no monotonic sessionLifetimes entry")
        else:
            started_ms, killed_ms, lifetime_ms = stamps
            if killed_ms - started_ms != lifetime_ms:
                errors.append(f"{session_id}: harness check: sessionLifetimes stamps disagree with lifetimeMs")
            if lifetime_ms < 60000:
                errors.append(f"{session_id}: harness check: the burn's own timers ran {lifetime_ms} ms, under the 60-second configuration; this is the harness clock, not delivery evidence")
        if ui.get("status") != "exited" or ui.get("lastEventSeq") != events[-1]["seq"]:
            errors.append(f"{session_id}: frontend has not received the terminal sequence")
        if ui.get("rowsDropped") != 0 or ui.get("rowsTotal") != rows:
            errors.append(f"{session_id}: frontend row count/drop mismatch")
    if sum(s["events"] for s in sessions) != (producer or {}).get("emitted"):
        errors.append("Producer count differs from durable envelopes")
    if sum(s["rows"] for s in sessions) != (capture or {}).get("delivery", {}).get("ingest", {}).get("rowsIn"):
        errors.append("Frontend did not ingest every terse row")
    history = (capture or {}).get("delivery", {}).get("history", [])
    if len(history) != 1:
        errors.append("Expected one mounted ThreadView transcript")
    for viewed in history:
        delivered = next((s for s in sessions if s["session"] == viewed["sessionId"]), None)
        if not delivered or viewed["lastItemSeq"] != delivered["lastItemSeq"]:
            errors.append("Mounted transcript has not received its final item sequence")
        if viewed["responses"] < 60:
            errors.append("Mounted transcript did not refresh throughout the 60-second stream")
    return {"pass": not errors, "errors": errors, "sessions": sessions}


def main(args):
    if args.output.exists():
        raise SystemExit("Refusing to overwrite an existing measurement")
    if args.data_dir.name == "ai.brigadier.app":
        raise SystemExit("Use a disposable app identifier; refusing the normal app data directory")
    if locked():
        raise SystemExit("Mac is locked; unlock before a native rendering measurement")
    capture_file = args.data_dir / "burn-capture.json"
    previous = capture_file.stat().st_mtime_ns if capture_file.exists() else 0
    delivery_file = args.data_dir / "burn-delivery.json"
    previous_delivery = delivery_file.stat().st_mtime_ns if delivery_file.exists() else 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    capture = None
    with args.output.with_suffix(".log").open("w") as log:
        child = subprocess.Popen([str(args.binary.resolve())], stdout=log, stderr=log)
        hold = subprocess.Popen(["caffeinate", "-di", "-w", str(child.pid)], stdout=log, stderr=log)
        try:
            # Activation is preparation. Burn waits twenty seconds before capture.
            activation = subprocess.run([str(args.activate_helper.resolve()), str(child.pid)], stdout=log, stderr=log)
            deadline = time.monotonic() + (130 if activation.returncode == 0 else 0)
            while time.monotonic() < deadline and child.poll() is None:
                if capture_file.exists() and capture_file.stat().st_mtime_ns > previous:
                    try:
                        capture = json.loads(capture_file.read_text())
                        break
                    except json.JSONDecodeError:
                        pass
                time.sleep(0.25)
            console_locked = locked()
            hold_alive = hold.poll() is None
        finally:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            hold.terminate()
            hold.wait()
    summary = (capture or {}).get("summary") or {}
    expected = {"sessions": 10, "rowsPerSec": 200, "durationS": 60, "fixture": "s1-handshake-and-turn"}
    delivery = json.loads(delivery_file.read_text()) if delivery_file.exists() and delivery_file.stat().st_mtime_ns > previous_delivery else None
    delivery_audit = verify_delivery(args.data_dir, delivery, capture)
    passed = bool(activation.returncode == 0 and delivery_audit["pass"] and capture and capture.get("workload") == expected and summary.get("pass")
                  and summary.get("duration_ms", 0) >= 60000 and not capture.get("profiling") and capture.get("diagnostics") is None
                  and not console_locked and hold_alive)
    result = {"delivery_audit": delivery_audit, "producer_delivery": delivery, "activation_exit": activation.returncode if activation else None, "pass": passed, "console_locked_after": console_locked,
              "pid": child.pid, "sleep_assertion_alive": hold_alive, "capture": capture}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"pass": passed, "console_locked_after": console_locked,
                      "sleep_assertion_alive": hold_alive, "summary": summary}), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--activate-helper", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    raise SystemExit(main(parser.parse_args()))
