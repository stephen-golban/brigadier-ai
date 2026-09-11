#!/bin/zsh
# usage: rburn.sh <arm> <label> -- retry until an uninterrupted, uncontended run lands (max 4 tries)
set -u
W=/private/tmp/brig-burn-20260911
ARM="$1"; BASE="$2"
foreign() { ps -Ao command | grep -E "cargo (build|test|clippy)|rustc --crate-name|tauri build|vite build" | grep -v grep | head -1; }
for T in 1 2 3 4; do
  D=$(( $(date +%s) + 600 ))
  while { [ -n "$(foreign)" ] || [ $(echo "$(sysctl -n vm.loadavg | awk '{print $2}') > 6.0" | bc) -eq 1 ]; } && [ $(date +%s) -lt $D ]; do sleep 5; done
  L="$BASE-t$T"
  S=$(date +%H:%M:%S)
  "$W/burn.sh" "$ARM" "$L" >/dev/null 2>&1
  E=$(date +%H:%M:%S)
  CONT=$(awk -v s="$S" -v e="$E" '$1>=s && $1<=e' "$W/out/contention.log" | grep -vc "foreign=\[\]")
  LOAD=$(awk -v s="$S" -v e="$E" '$1>=s && $1<=e {gsub("load1=","",$2); t+=$2; n++} END{if(n)printf "%.2f",t/n; else print "na"}' "$W/out/contention.log")
  R=$(python3 -c "
import json;d=json.load(open('$W/out/burn-$L.json'));s=(d.get('capture') or {}).get('summary',{})
print(s.get('total_dropped'),s.get('worst_ms'),s.get('interrupted'),s.get('windows'))")
  set -- $=R
  echo "$ARM $L window=$S..$E foreign=$CONT load=$LOAD dropped=$1 worst=$2 interrupted=$3 windows=$4"
  if [ "$3" = "False" ] && [ "$CONT" -eq 0 ]; then exit 0; fi
done
exit 1
