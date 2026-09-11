#!/bin/zsh
W=/private/tmp/brig-frame-20260911
for i in $(seq 1 180); do
  L=$(python3 -c "import subprocess,plistlib;print(plistlib.loads(subprocess.check_output(['ioreg','-n','Root','-d1','-a'])).get('IOConsoleLocked'))")
  [ "$L" = "False" ] && break
  sleep 20
done
if [ "$L" != "False" ]; then echo "STILL_LOCKED after 60 min"; exit 2; fi
echo "UNLOCKED at $(date +%H:%M:%S)"
for spec in accept:a1 prof:p1 pre4000:r1 accept:a2 prof:p2 pre4000:r2 ctl:c1 pre1500:s1 accept:a3 pre4000:r3 ctl:c2 pre1500:s2; do
  ARM=${spec%%:*}; LBL=${spec##*:}
  "$W/burn.sh" "$ARM" "$LBL"
done
echo "AUTORUN_DONE"
