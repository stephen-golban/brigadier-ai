#!/bin/zsh
set -u
SP=/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/14e67347-0897-4eec-9dd1-f6e922823da6/scratchpad
locked() { ioreg -n Root -d1 -a | python3 -c "import sys,plistlib;print('1' if plistlib.loads(sys.stdin.buffer.read()).get('IOConsoleLocked',True) else '0')"; }
busy()   { pgrep -f "cargo |rustc|vite build|esbuild|tauri build|swiftc|xcodebuild" >/dev/null && echo 1 || echo 0; }
DEADLINE=$(( $(date +%s) + 5400 ))
while [ $(date +%s) -lt $DEADLINE ]; do
  if [ "$(locked)" = "0" ] && [ "$(busy)" = "0" ]; then
    echo "$(date +%H:%M:%S) console unlocked and no foreign build — starting quiet series"
    "$SP/spike-perf/quiet-run.sh"
    echo "$(date +%H:%M:%S) startup series done; burns next"
    "$SP/spike-perf/resetdata.sh"; "$SP/spike-perf/burn.sh" qbaseline 2>&1 | tail -2
    "$SP/spike-perf/resetdata.sh"; "$SP/spike-perf/burn.sh" qfull 2>&1 | tail -2
    echo "QUIET_ALL_DONE"
    exit 0
  fi
  sleep 30
done
echo "TIMED_OUT_STILL_LOCKED_OR_BUSY"
exit 2
