# Onboarding continuity

Superseded by [Fixed-window onboarding](fixed-window-onboarding-2026-09-07.md). Moving native framing to the first Continue relocated the flicker; the current implementation eliminates that operation throughout onboarding. The details below record the previous iteration.

The owner confirmed that name entry, the greeting, and the workspace should share a stationary native window. Keep the desktop cinematic intro, settle the final window size/position and macOS controls before name entry, hold the greeting for about 1.4 seconds (longer only while loading), and crossfade directly into the workspace over 0.5 seconds. Reduced motion keeps the existing shorter timing.

`launch_prepare` now restores native controls and geometry before name entry. Interrupted onboarding starts in the normal window. The temporary native cover and the `launch_finish`/`launch_reveal` commands are removed. Saving a name and revealing the workspace no longer changes native geometry or creates another window.

The workspace mounts beneath name entry and remains inaccessible while onboarding is active. App reports readiness after its initial workspace data has committed. The greeting's minimum hold runs independently of that readiness, followed by two animation-frame opportunities and a single overlay fade. Greeting text and the cosmic field remain mounted throughout the fade; the app underneath is already visible and laid out. Replay uses the same fade without native window changes or another name prompt.

Validation: 37 targeted frontend tests passed, including delayed workspace data, delayed lazy loading, native preparation failure/retry, normal and reduced-motion timing, and keeping the same greeting/app nodes through the transition. Three native launch tests passed. TypeScript, release app bundle, and signature verification passed. Browser integration sampled 61 crossfade frames with a visible workspace, retained greeting, and unchanged app bounds; name persistence, replay, mute, and reduced motion also passed.

Installed macOS verification confirmed controls at name entry and after resuming interrupted onboarding. Native screenshots captured the greeting, overlapping greeting/workspace during the fade, and final workspace with the same visible frame and controls. No blank gap appeared in the inspected samples; these snapshots are not a full frame-rate performance measurement.

Installed at `/Applications/Brigadier.app`. Previous app and preferences backed up under `~/Library/Application Support/Brigadier-update-backups/20260907-145055`. The installed app is left at name entry for the owner's review. Projects, notes, and unrelated preferences are preserved.
