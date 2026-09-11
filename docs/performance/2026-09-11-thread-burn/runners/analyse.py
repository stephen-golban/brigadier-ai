import json, statistics, glob, random, sys
def load(pat):
    out={}
    for f in sorted(glob.glob(pat)):
        d=json.load(open(f))
        lab=f.split('startup-')[1].replace('.json','')
        out[lab]=[s['pre_spawn_to_fcp_ms'] for s in d['samples'] if s.get('valid')]
    return out
def pct(xs,p):
    xs=sorted(xs); 
    if not xs: return None
    k=(len(xs)-1)*p/100
    lo=int(k); hi=min(lo+1,len(xs)-1)
    return xs[lo]+(xs[hi]-xs[lo])*(k-lo)
def rep(name, series, keys):
    allv=[v for k in keys for v in series[k]]
    warm=[v for k in keys for v in series[k][1:]]
    print(f"{name}: n={len(allv)} p50={pct(allv,50):.2f} p95={pct(allv,95):.2f} min={min(allv):.2f} max={max(allv):.2f} | warm n={len(warm)} p50={pct(warm,50):.2f} p95={pct(warm,95):.2f}")
    print("   per-series p50:", ", ".join(f"{pct(series[k],50):.2f}" for k in keys))
    return allv, warm
S=load(sys.argv[1]+"/out/startup-*.json")
for k in sorted(S): print(k, "valid", len(S[k]))
print()
clean=[f"s{i}" for i in range(1,5)]
bk=[f"baseline-{s}" for s in clean]; rk=[f"branch-{s}" for s in clean]
ba,bw=rep("BASELINE(f94c9ef) s1-s4 quiet", S, bk)
ra,rw=rep("BRANCH(ui/codex-thread) s1-s4 quiet", S, rk)
print()
rep("BASELINE s5 CONTENDED", S, ["baseline-s5"])
rep("BRANCH s5 CONTENDED", S, ["branch-s5"])
print()
def boot(a,b,n=20000):
    random.seed(7); d=[]
    for _ in range(n):
        sa=[random.choice(a) for _ in a]; sb=[random.choice(b) for _ in b]
        d.append(statistics.median(sb)-statistics.median(sa))
    d.sort(); return statistics.median(d), d[int(n*0.025)], d[int(n*0.975)]
m,lo,hi=boot(bw,rw); print(f"warm paired-ish bootstrap branch-baseline: {m:+.2f} ms  95% CI [{lo:+.2f}, {hi:+.2f}]")
h=len(bw)//2
m,lo,hi=boot(bw[:h],bw[h:]); print(f"noise floor (baseline 2nd half vs 1st): {m:+.2f} ms  95% CI [{lo:+.2f}, {hi:+.2f}]")
