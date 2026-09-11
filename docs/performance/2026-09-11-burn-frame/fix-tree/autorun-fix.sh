#!/bin/zsh
W=/private/tmp/brig-frame-20260911
echo "START $(date +%H:%M:%S) locks=$(ls $HOME/.brigadier/workspace-locks-v1 | wc -l | tr -d ' ')"
"$W/burn-fix.sh" fix f1
"$W/startup-fix.sh" fix s1 10
for spec in fix:f2 accept:a1 fix:f3 fix:f4 accept:a2 fix:f5 fix:f6 accept:a3; do
  ARM=${spec%%:*}; LBL=${spec##*:}
  "$W/burn-fix.sh" "$ARM" "$LBL"
done
echo "AUTORUN_FIX_DONE $(date +%H:%M:%S) locks=$(ls $HOME/.brigadier/workspace-locks-v1 | wc -l | tr -d ' ')"
