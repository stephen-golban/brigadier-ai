import json, statistics, glob, random, sys
W=sys.argv[1]
def load():
    out={}
    for f in sorted(glob.glob(W+"/out/startup-*.json")):
        d=json.load(open(f)); lab=f.split('startup-')[1].replace('.json','')
        out[lab]=[s['pre_spawn_to_fcp_ms'] for s in d['samples'] if s.get('valid')]
    return out
def pct(xs,p):
    xs=sorted(xs); k=(len(xs)-1)*p/100; lo=int(k); hi=min(lo+1,len(xs)-1)
    return xs[lo]+(xs[hi]-xs[lo])*(k-lo)
S=load()
quiet=[f"s{i}" for i in [1,2,3,4,6,7,8,9]]
def rep(name,keys):
    a=[v for k in keys for v in S[k]]; w=[v for k in keys for v in S[k][1:]]
    print(f"{name}\n  all   n={len(a)} p50={pct(a,50):7.2f} p95={pct(a,95):8.2f} min={min(a):.2f} max={max(a):.2f}")
    print(f"  warm  n={len(w)} p50={pct(w,50):7.2f} p95={pct(w,95):8.2f}")
    print("  series p50:", ", ".join(f"{pct(S[k],50):.1f}" for k in keys))
    return a,w
ba,bw=rep("BASELINE f94c9ef  (8 quiet series)",[f"baseline-{s}" for s in quiet])
ra,rw=rep("BRANCH   ui/codex-thread (8 quiet series)",[f"branch-{s}" for s in quiet])
print()
rep("baseline s5+s10 CONTENDED",["baseline-s5","baseline-s10"])
rep("branch   s5 CONTENDED / s10 quiet",["branch-s5","branch-s10"])
print()
def boot(a,b,n=20000):
    random.seed(11); d=[]
    for _ in range(n):
        d.append(statistics.median([random.choice(b) for _ in b])-statistics.median([random.choice(a) for _ in a]))
    d.sort(); return statistics.median(d), d[int(n*.025)], d[int(n*.975)]
m,lo,hi=boot(bw,rw); print(f"branch - baseline (warm):      {m:+7.2f} ms  95% CI [{lo:+.2f}, {hi:+.2f}]")
h=len(bw)//2
m,lo,hi=boot(bw[:h],bw[h:]); print(f"noise floor (base 2nd v 1st): {m:+7.2f} ms  95% CI [{lo:+.2f}, {hi:+.2f}]")
# paired by series
pb=[pct(S[f"baseline-{s}"][1:],50) for s in quiet]; pr=[pct(S[f"branch-{s}"][1:],50) for s in quiet]
diffs=[r-b for b,r in zip(pb,pr)]
print("per-series warm p50 diffs (branch-baseline):", ", ".join(f"{d:+.1f}" for d in diffs))
print(f"mean of per-series diffs = {statistics.mean(diffs):+.2f} ms, median = {statistics.median(diffs):+.2f} ms, sd = {statistics.stdev(diffs):.2f}")
