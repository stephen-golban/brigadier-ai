#!/bin/zsh
# Samples every 2s for foreign build processes; writes one line per sample.
OUT="$1"
: > "$OUT"
while true; do
  L=$(sysctl -n vm.loadavg | awk '{print $2}')
  P=$(pgrep -fl "cargo |rustc|vite build|esbuild|tauri build|swiftc|xcodebuild|clang |ld64|npm run" | grep -v quietwatch | tr '\n' ';')
  echo "$(date +%H:%M:%S) load1=$L procs=[$P]" >> "$OUT"
  sleep 2
done
