#!/usr/bin/env python3
import json, os, statistics
W = "/private/tmp/brig-frame-20260911/out-fix"
ORDER = ["f1","f2","a1","f3","f4","a2","f5","f6","a3","f7","f8"]
def ex(l):
    p=os.path.join(W,"burn-%s.exit"%l); d={}
    if os.path.exists(p):
        for t in open(p).read().split():
            if "=" in t: k,v=t.split("=",1); d[k]=v
    return d
rows=[]
for l in ORDER:
    p=os.path.join(W,"burn-%s.json"%l)
    if not os.path.exists(p): continue
    d=json.load(open(p)); c=d.get("capture") or {}; s=c.get("summary") or {}; ws=c.get("windows") or []
    e=ex(l)
    wi=max(range(len(ws)),key=lambda i:ws[i].get("worst_ms",0)) if ws else None
    hid=next((i for i,w in enumerate(ws) if w.get("hidden")),None)
    t=0.0; frames=[]
    for i,w in enumerate(ws):
        for iv in w["intervals_ms"]:
            t+=iv
            n=round(iv/(1000/60))-1
            if n>0: frames.append((round(t),round(iv),i,int(n)))
    rows.append(dict(run=l,arm=e.get("arm"),dropped=s.get("total_dropped"),worst=s.get("worst_ms"),
        worst_w=wi,windows=len(ws),interrupted=s.get("interrupted"),hidden_at=hid,
        dur=s.get("duration_ms"),preroll=c.get("prerollMs"),deliv=(d.get("delivery_audit") or {}).get("pass"),
        pg=(e.get("pgrep_before"),e.get("pgrep_after")),l1=e.get("load_before"),l1a=e.get("load_after"),
        locks=(e.get("locks_before"),e.get("locks_after")),frames=frames[:10],
        harness_pass=d.get("pass"),exitc=e.get("exit")))
print("| run | arm | valid | drops | worst frame ms (window) | windows | dropping frames (rel ms / dt) | pgrep b/a | load1 b/a | locks b/a |")
print("| --- | --- | --- | ---: | --- | ---: | --- | --- | --- | --- |")
for r in rows:
    fr="; ".join("%d / %d" % (f[0],f[1]) for f in r["frames"]) or "none"
    print("| `%s` | %s | %s | %s | %s (w%s) | %s | %s | %s/%s | %s/%s | %s → %s |" % (
        r["run"],r["arm"],"no — window hidden at w%d"%r["hidden_at"] if r["interrupted"] else "yes",
        r["dropped"],r["worst"],r["worst_w"],r["windows"],fr,r["pg"][0],r["pg"][1],r["l1"],r["l1a"],
        r["locks"][0],r["locks"][1]))
print()
for arm in ("fix","accept"):
    v=[r for r in rows if r["arm"]==arm and not r["interrupted"]]
    inv=[r["run"] for r in rows if r["arm"]==arm and r["interrupted"]]
    if v:
        ds=sorted(r["dropped"] for r in v)
        print("%s: n_valid=%d drops=%s median=%s  worst=%s  invalid=%s" % (arm,len(v),ds,statistics.median(ds),
              sorted(r["worst"] for r in v),inv))
    else:
        print("%s: n_valid=0 invalid=%s" % (arm,inv))
