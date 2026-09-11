#!/bin/zsh
set -u
W=/private/tmp/brig-burn-20260911
LABEL="$1"; SRC="$2"; TGT="$3"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$TGT"
cd "$SRC" || exit 90
S=$(date +%s)
VITE_BURN=1 npm run tauri build -- --features burn --config "$W/tauri.json" --bundles app > "$W/out/build-$LABEL.log" 2>&1
CODE=$?
E=$(date +%s)
echo "build_label=$LABEL exit=$CODE seconds=$((E-S))" > "$W/out/build-$LABEL.exit"
if [ $CODE -eq 0 ]; then
  rm -rf "$W/frozen-$LABEL.app"
  cp -Rc "$TGT/release/bundle/macos/Brigadier CssSpike.app" "$W/frozen-$LABEL.app"
  echo "freeze_exit=$?" >> "$W/out/build-$LABEL.exit"
fi
cat "$W/out/build-$LABEL.exit"
exit $CODE
