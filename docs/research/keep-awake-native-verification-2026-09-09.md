# Keep-awake native verification: measurement limits

Date: 2026-09-09. Scope: primary-source research followed by an isolated native app test. The observed display-idle/automatic-lock comparison passed; see measured results below.

## What the assertions guarantee

**Asserted from Apple source:** `caffeinate -diu -t 60` creates three assertions: `PreventUserIdleDisplaySleep`, `PreventUserIdleSystemSleep`, and `UserIsActive`. The explicit timeout applies to the assertions and process. Without an explicit timeout, caffeinate gives the user-active assertion five seconds. Replacing this process before 60 seconds can renew the assertions; successful renewal must be measured, including any gap. [Apple caffeinate implementation](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.c), [Apple manual source](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8).

**Asserted from Apple headers:** display-idle prevention prevents automatic display dimming/off; user-activity declaration powers on the display and postpones display sleep. Neither description promises suppression of screen saver or every screen-lock mechanism. The private `UserIsActive` assertion is the backend of the public user-activity declaration API. [Apple public IOPMLib header](https://github.com/apple-oss-distributions/IOKitUser/blob/main/pwr_mgt.subproj/IOPMLib.h), [Apple private IOPMLib header](https://github.com/apple-oss-distributions/IOKitUser/blob/main/pwr_mgt.subproj/IOPMLibPrivate.h).

**Asserted from Apple user documentation:** password requirements may follow either screen-saver activation or display-off, after a configurable delay. Keeping the display on alone therefore does not establish the complete requested no-auto-lock behavior. [Apple: require a password after waking](https://support.apple.com/en-ae/guide/mac-help/mchlp2270/mac).

**Inference:** renewed `-diu` is a plausible implementation of idle prevention, but source inspection and `pmset -g assertions` alone cannot establish unattended screen-saver/lock suppression on this installed macOS. Explicit locking, lid closure, and idle locking are different cases.

## Read-only lock observation

**Measured once on this host:** `/usr/sbin/ioreg -n Root -d1 -a` returned root `IOConsoleLocked=false`, one on-console session, and no `CGSSessionScreenIsLocked` key. OS build in this snapshot was `25G83`. Missing keys must be preserved as unknown/missing, not silently converted into a verified false value. These lock keys were not found documented as a stable public contract in the Apple sources checked.

This command restricts output to useful state and emits JSON null for missing values:

```sh
python3 - <<'PY'
import json, plistlib, subprocess
root = plistlib.loads(subprocess.check_output(['/usr/sbin/ioreg', '-n', 'Root', '-d1', '-a']))
if isinstance(root, list):
    root = root[0]
sessions = [s for s in root.get('IOConsoleUsers', []) if s.get('kCGSSessionOnConsoleKey') is True]
print(json.dumps({
    'IOConsoleLocked': root.get('IOConsoleLocked'),
    'on_console_sessions': len(sessions),
    'CGSSessionScreenIsLocked': [s.get('CGSSessionScreenIsLocked') for s in sessions],
}))
PY
```

## Required empirical test

1. Record actual screen-saver, display-off, and password-delay settings without changing them; record other applications' assertions and the tested app binary/version.
2. Verify app work plus enabled toggle creates the expected child/assertions. Observe multiple renewal cycles, with no synthetic mouse/keyboard input during the interval.
3. Remain unattended beyond the configured idle trigger plus password delay. Read lock state, display state, assertion ownership and idle elapsed time; preserve unknowns. An unlocked endpoint after user input is insufficient because that input may have unlocked or reset idleness.
4. Use an off/stopped control under the same conditions. A control that never locks, other software's active assertions, continuing physical input, disabled idle locking, or an observation shorter than the configured timer makes the no-auto-lock conclusion inconclusive.
5. Separately verify toggle-off, work-finished and app-quit assertion release. Assertion release can be proven immediately; resumed normal locking requires waiting for the idle policy again.

**Not checked by this research:** an unattended on/off comparison, actual screen-saver suppression, renewal timing, saved-setting persistence, or app lifecycle behavior. No system preferences were changed and no caffeinate process was launched for this note.


## Measured native verification

Built the current checkout, including the uncommitted keep-awake feature, as a separate app with isolated data:

```sh
PATH=/Users/stephen/.cargo/bin:$PATH npm run tauri build -- --debug --bundles app --config '{"identifier":"com.brigadier.keepawake-test","productName":"Brigadier Keep Awake Test"}'
```

Build exited 0. Used the native UI to enable Settings → General → Power → Keep machine awake while working. Verified it was initially off, enabled successfully, and remained on after quitting and relaunching. A disposable repository at `/tmp/brigadier-keepawake-fixture-20260909` hosted a real Claude agent executing `/bin/sleep 300`, then returning `KEEP_AWAKE_TEST_DONE`. The installed `/Applications/Brigadier.app` and its data were not replaced or edited.

A separate task had `caffeinate -di -t 3600` running. The owner explicitly authorized stopping that process before the comparison. The display was on AC power. Through System Settings, temporarily changed AC display-off from 2 hours to 1 minute. Password after display-off was already Immediately and was not changed. Battery timeout remained 2 hours.

Verified that toggling keep-awake off during live work removed this app's caffeinate process and reduced system-wide PreventUserIdleDisplaySleep to 0 after the unrelated blocker was stopped. Re-enabling created the app-owned three assertions again. Actual children were owned by isolated app PID 70386, with lease renewal across PIDs 79575, 81885, 83735, 87738, 88616 and 91032. No UI automation, screenshots, synthetic input, or build ran during the unattended observation; shell polling read `ioreg` and `pmset` every approximately five seconds. Early samples with continued physical input were excluded from the idle conclusion.

| Local time | Physical HID idle | App assertions present | IOConsoleLocked |
| --- | ---: | --- | --- |
| 23:49:00 | 61.5 s | Yes | false |
| 23:49:15 | 76.8 s | Yes, renewed child | false |
| 23:49:40 | 102.1 s | Yes | false |
| 23:49:45 | 107.2 s | No, work finished | false |
| 23:50:46 | 168.0 s | No; powerd display delay also released | false |
| 23:50:56 | 178.2 s | No | true |

**Measured result:** stayed unlocked beyond the configured 60-second display-idle threshold while work was active, including an assertion renewal without physical input. Assertions released on completion, followed by actual automatic lock approximately 71 seconds after the first assertion-free sample. Sampling precision is approximately five seconds. The OS's additional transient `com.apple.powermanagement.delayDisplayOff` assertion was visible in the interval after completion and expired before locking. All 57 samples are in `/tmp/brigadier-keepawake-observations.ndjson`; the observer is `/tmp/brigadier-keepawake-observe.py`.

**Scope limitation:** this verifies this Mac's display-idle-driven automatic lock on AC power. It does not establish behavior for separately configured screen-saver policies, managed lock policies, explicit Lock Screen, lid closure, or battery power. System sleep itself was not isolated from ChatGPT's existing NoIdleSleepAssertion; this run proves display/lock behavior and app-owned assertion lifecycle, not unassisted whole-machine sleep.

On 2026-09-10, after the owner unlocked the Mac, restored the original two-hour AC display timeout through System Settings. Verified both UI controls show For 2 hours and `pmset -g custom` reports displaysleep 120 for both AC and battery. Password policy remained Immediately. Closed the isolated test app after verification.


## Commit verification (2026-09-10)

- `cargo test --workspace`: 803 passed, 12 ignored, 0 failed across 43 reported suites. First attempt used a stale claude-wire test binary embedding a deleted `/private/tmp/brigadier-graft-results/rust-budget-1-graft` fixture path. Clearing only that crate's build cache with `cargo clean -p claude-wire` and rerunning the full command passed; no fixture or product code changes were needed.
- `npm test`: 549 passed in 67 files.
- `npx tsc --noEmit`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo doc --workspace --no-deps`: each exited 0.
- `npm run tauri build`: exited 0; produced the release macOS app and DMG.
- Removed only this verification's isolated app bundle, app-data directory and disposable Git fixture after closing the test processes. Kept the observation logs in `/tmp` and this report. No project worktree or branch was created for the feature.
- App-wide startup/rendering acceptance remains owned by the separate performance task; the native keep-awake result above does not claim that unrelated performance bar passes.
