#!/usr/bin/env python3
import json,pathlib,subprocess,time
root=pathlib.Path(__file__).resolve().parent.parent

import argparse
p=argparse.ArgumentParser(description='Separate diagnostic capture; never acceptance')
p.add_argument('--label',required=True)
p.add_argument('--binary',type=pathlib.Path,required=True)
p.add_argument('--output-dir',type=pathlib.Path,required=True)
p.add_argument('--data-dir',type=pathlib.Path,required=True)
p.add_argument('--activate-helper',type=pathlib.Path,required=True)
p.add_argument('--target',choices=['webcontent','native'],default='webcontent')
p.add_argument('--sample-delay',type=float,default=22)
p.add_argument('--sample-seconds',type=int,default=15)
p.add_argument('--sample-interval-ms',type=int,default=1)
args=p.parse_args();label=args.label;out=args.output_dir;out.mkdir(parents=True,exist_ok=True)
if (out/f'{label}.json').exists():raise SystemExit('Refusing to overwrite measurement')
def processes():
 lines=subprocess.check_output(['ps','-axo','pid=,ppid=,comm='],text=True).splitlines()
 return {int(s.split(None,2)[0]):s for s in lines if s.rstrip().endswith('/com.apple.WebKit.WebContent')}
before=processes();started=time.monotonic()
with (out/f'{label}-run.log').open('w') as log:
 child=subprocess.Popen(['python3','scripts/measure-native-burn.py',str(args.binary),'--activate-helper',str(args.activate_helper),'--data-dir',str(args.data_dir),'--output',str(out/f'{label}.json')],cwd=root,stdout=log,stderr=log)
 while time.monotonic()-started<args.sample_delay and child.poll() is None:time.sleep(.5)
 after=processes();fresh=set(after)-set(before)
 evidence={'before':before,'after':after,'fresh':sorted(fresh),'sampleStartElapsedS':time.monotonic()-started}
 if args.target == 'native':
  import re
  match=re.search(r'activated pid=(\d+)',(out/f'{label}.log').read_text())
  fresh={int(match.group(1))} if match else set()
  evidence['nativePid']=next(iter(fresh)) if fresh else None
 if len(fresh)==1 and child.poll() is None:
  pid=next(iter(fresh));evidence['sampledTarget']=args.target;evidence['sampledPid']=pid;evidence['sampleExit']=subprocess.run(['/usr/bin/sample',str(pid),str(args.sample_seconds),str(args.sample_interval_ms),'-file',str(out/f'{label}-sample.txt')],stdout=log,stderr=log).returncode
 else:evidence['error']=f'No unique new {"native" if args.target=="native" else "WebContent"} process; no sample taken'
 (out/f'{label}-attribution.json').write_text(json.dumps(evidence,indent=2))
 result=child.wait()
print('Diagnostic harness exit',result,'(ordinary acceptance pass is disabled for profiling)')
print(json.dumps(evidence))
