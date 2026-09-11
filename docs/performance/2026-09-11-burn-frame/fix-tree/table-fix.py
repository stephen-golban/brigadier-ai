#!/usr/bin/env python3
import json, glob, os, sys, statistics, datetime
W = "/private/tmp/brig-frame-20260911/out-fix"
ORDER = ["f1","f2","a1","f3","f4","a2","f5","f6","a3"]

def ex(label):
    p = os.path.join(W, "burn-%s.exit" % label); d = {}
    if os.path.exists(p):
        for t in open(p).read().split():
            if "=" in t: k,v = t.split("=",1); d[k]=v
    return d

rows = []
for lab in ORDER:
    p = os.path.join(W, "burn-%s.json" % lab)
    if not os.path.exists(p): continue
    d = json.load(open(p)); c = d.get("capture") or {}; s = c.get("summary") or {}
    ws = c.get("windows") or []
    e = ex(lab)
    worst_w = max(range(len(ws)), key=lambda i: ws[i].get("worst_ms",0)) if ws else None
    # first hidden window
    hid = next((i for i,w in enumerate(ws) if w.get("hidden")), None)
    rows.append(dict(run=lab, arm=e.get("arm"), exit=e.get("exit"),
        dropped=s.get("total_dropped"), worst=s.get("worst_ms"), worst_w=worst_w,
        windows=len(ws), interrupted=s.get("interrupted"), first_hidden=hid,
        dur=s.get("duration_ms"), preroll=c.get("prerollMs"),
        pass_=d.get("pass"), deliv=(d.get("delivery_audit") or {}).get("pass"),
        act=d.get("activation_exit"), lockedafter=d.get("console_locked_after"),
        pg=e.get("pgrep_before")+"/"+e.get("pgrep_after","?") if e.get("pgrep_before") else None,
        l1=e.get("load_before"), l1a=e.get("load_after"),
        locks=(e.get("locks_before"),e.get("locks_after")),
        head=(d.get("source") or {}).get("head","")[:7],
        dropwins=[(i,w["dropped"],round(w["worst_ms"],1)) for i,w in enumerate(ws) if w.get("dropped")][:6]))
for r in rows: print(json.dumps(r))
for arm in ("fix","accept"):
    valid = [r for r in rows if r["arm"]==arm and not r["interrupted"]]
    if valid:
        ds = sorted(r["dropped"] for r in valid)
        print("SUMMARY arm=%s n_valid=%d drops=%s median=%s" % (arm,len(valid),ds,statistics.median(ds)))
    inval = [r["run"] for r in rows if r["arm"]==arm and r["interrupted"]]
    print("SUMMARY arm=%s invalid=%s" % (arm, inval))
