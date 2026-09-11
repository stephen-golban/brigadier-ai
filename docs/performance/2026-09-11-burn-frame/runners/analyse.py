#!/usr/bin/env python3
"""Per-run table + cluster localisation + trace attribution for the burn-frame work."""
import json, glob, os, sys

W = "/private/tmp/brig-frame-20260911/out"


def load(p):
    with open(p) as f:
        return json.load(f)


def run_row(path):
    d = load(path)
    cap = d.get("capture") or {}
    s = cap.get("summary") or {}
    ws = cap.get("windows") or []
    ex = {}
    exf = path.replace(".json", "").replace("burn-", "burn-") + ".exit"
    exf = os.path.join(W, "burn-" + os.path.basename(path)[5:-5] + ".exit")
    if os.path.exists(exf):
        for tok in open(exf).read().split():
            if "=" in tok:
                k, v = tok.split("=", 1)
                ex[k] = v
    # per-window drops
    drops = [(i, w["dropped"], w["worst_ms"]) for i, w in enumerate(ws) if w["dropped"]]
    return {
        "file": os.path.basename(path),
        "arm": ex.get("arm"),
        "harness_pass": d.get("pass"),
        "interrupted": s.get("interrupted"),
        "locked_after": d.get("console_locked_after"),
        "activation": d.get("activation_exit"),
        "dropped": s.get("total_dropped"),
        "worst_ms": s.get("worst_ms"),
        "windows": len(ws),
        "preroll": cap.get("prerollMs"),
        "hidden0": (ws[0].get("hidden") if ws else None),
        "final_hidden": (cap.get("finalVisibility") or {}).get("hidden"),
        "pgrep_before": ex.get("pgrep_before"),
        "pgrep_after": ex.get("pgrep_after"),
        "load_before": ex.get("load_before"),
        "load_after": ex.get("load_after"),
        "locks_before": ex.get("locks_before"),
        "locks_after": ex.get("locks_after"),
        "drop_windows": drops[:8],
        "dom": [w["dom_nodes"] for w in ws[:5]],
        "head": (d.get("source") or {}).get("head", "")[:8],
        "dirty": (d.get("source") or {}).get("dirty"),
        "trace": len((((cap.get("diagnostics") or {}).get("trace")) or [])),
    }


def big_frames(path, upto_ms=6000):
    """Every rAF interval that drops >=1 vsync, with its offset from capture start."""
    d = load(path)
    cap = d.get("capture") or {}
    ws = cap.get("windows") or []
    out = []
    t = 0.0
    for wi, w in enumerate(ws):
        for iv in w["intervals_ms"]:
            t += iv
            if round(iv / (1000 / 60)) - 1 > 0:
                out.append((round(t, 1), iv, wi, int(round(iv / (1000 / 60)) - 1)))
        if t > upto_ms:
            break
    return out


def trace_window(path, lo, hi):
    d = load(path)
    cap = d["capture"]
    diag = cap.get("diagnostics") or {}
    if not diag.get("trace"):
        return None, None, None
    t0 = cap["windows"][0]["window_start_ms"] - diag["timeOriginMs"]
    tr = [(round(e["t"] - t0, 1), e["k"], e.get("d")) for e in diag["trace"] if lo <= e["t"] - t0 <= hi]
    sp = [(round(s["start"] - t0, 1), round(s["end"] - t0, 1), s["name"], round(s["end"] - s["start"], 1))
          for s in diag.get("spans", []) if lo <= s["start"] - t0 <= hi]
    return t0, tr, sp


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "table"
    files = sorted(glob.glob(os.path.join(W, "burn-*.json")))
    if mode == "table":
        for f in files:
            r = run_row(f)
            print(json.dumps(r))
    elif mode == "frames":
        for f in files:
            print("==", os.path.basename(f))
            for row in big_frames(f):
                print("   rel=%8.1f ms  dt=%5.1f  window=%2d  dropped=%d" % row)
    elif mode == "trace":
        f, lo, hi = sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
        t0, tr, sp = trace_window(f, lo, hi)
        print("capture start perf.now =", t0)
        print("-- spans --")
        for s in sp:
            print("   %8.1f -> %8.1f  %-8s %.1f ms" % s)
        print("-- trace --")
        for e in tr:
            print("   %8.1f  %-16s d=%s" % e)
