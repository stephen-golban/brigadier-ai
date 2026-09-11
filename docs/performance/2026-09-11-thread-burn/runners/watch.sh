#!/bin/zsh
OUT=/private/tmp/brig-burn-20260911/out/contention.log
: > "$OUT"
while true; do
  P=$(ps -Ao command | grep -E "cargo (build|test|clippy)|rustc --crate-name|tauri build|vite build" | grep -v grep | head -3 | tr '\n' ';' | cut -c1-120)
  echo "$(date +%H:%M:%S) load1=$(sysctl -n vm.loadavg | awk '{print $2}') foreign=[$P]" >> "$OUT"
  sleep 5
done
