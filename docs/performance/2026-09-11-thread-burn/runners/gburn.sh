#!/bin/zsh
# usage: gburn.sh <arm> <label>  -- waits for a quiet machine, runs one burn,
# marks it contended if any foreign build appeared inside its window.
set -u
W=/private/tmp/brig-burn-20260911
ARM="$1"; LABEL="$2"
foreign() { ps -Ao command | grep -E "cargo (build|test|clippy)|rustc --crate-name|tauri build|vite build" | grep -v grep | head -1; }
# wait for quiet, up to 12 min
D=$(( $(date +%s) + 720 ))
while [ -n "$(foreign)" ] && [ $(date +%s) -lt $D ]; do sleep 5; done
S=$(date +%H:%M:%S)
"$W/burn.sh" "$ARM" "$LABEL" >/dev/null 2>&1
E=$(date +%H:%M:%S)
CONT=$(awk -v s="$S" -v e="$E" '$1>=s && $1<=e' "$W/out/contention.log" | grep -vc "foreign=\[\]")
LOAD=$(awk -v s="$S" -v e="$E" '$1>=s && $1<=e {gsub("load1=","",$2); t+=$2; n++} END{if(n)printf "%.2f", t/n; else print "na"}' "$W/out/contention.log")
echo "label=$LABEL arm=$ARM window=$S..$E foreign_samples=$CONT mean_load1=$LOAD"
