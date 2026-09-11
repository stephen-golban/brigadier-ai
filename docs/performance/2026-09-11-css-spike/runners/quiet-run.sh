#!/bin/zsh
set -u
SP=/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/14e67347-0897-4eec-9dd1-f6e922823da6/scratchpad
run() {  # run <quietlabel> <sourceapp>
  local lab="$1" src="$2"
  rm -rf "$SP/spike-perf/frozen-$lab.app"
  cp -Rc "$SP/spike-perf/frozen-$src.app" "$SP/spike-perf/frozen-$lab.app" || return 1
  echo "### $(date +%H:%M:%S) $lab (from $src) load=$(sysctl -n vm.loadavg)"
  "$SP/spike-perf/startup.sh" "$lab" 10 2>&1 | tail -2
}
for i in 1 2 3; do
  run "qbase$i" baseline
  run "qfull$i" full
  [[ $i -le 2 ]] && run "qnofc$i" nofc
  [[ $i -le 2 ]] && run "qtok$i"  tokens
done
for i in 1 2 3; do
  run "qmdtc$i" mdt-nocss
  run "qmdtf$i" mdt-fullcss
  run "qmdtn$i" mdt-nofc
done
echo "ALL_QUIET_SERIES_DONE"
