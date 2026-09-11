#!/bin/zsh
set -u
W=/private/tmp/brig-frame-20260911
SRC=/Users/stephen/Development/brigadier-ai.worktrees/burn-2026-09-11
LABEL="$1"; CONF="$2"; shift 2
export PATH="$HOME/.cargo/bin:$PATH"
cd "$SRC" || exit 90
S=$(date +%s)
env "$@" VITE_BURN=1 npm run tauri build -- --features burn --config "$CONF" --bundles app > "$W/out/build-$LABEL.log" 2>&1
CODE=$?
E=$(date +%s)
echo "build_label=$LABEL exit=$CODE seconds=$((E-S)) config=$CONF" > "$W/out/build-$LABEL.exit"
if [ $CODE -eq 0 ]; then
  rm -rf "$W/frozen-$LABEL.app"
  cp -Rc "$SRC/target/release/bundle/macos/Brigadier CssSpike.app" "$W/frozen-$LABEL.app"
  echo "freeze_exit=$?" >> "$W/out/build-$LABEL.exit"
fi
cat "$W/out/build-$LABEL.exit"
exit $CODE
