# Startup and first-launch intro research

Checked 2026-09-06. Research for the ongoing design interview; no implementation or final design approval.

**Later user decision:** subsequent launches should also have a related intro with music toggleable in Settings. This supersedes the quiet-subsequent-launch recommendation below. The user supplied an Arc welcome recording; see [the visual and audio analysis](arc-intro-analysis-2026-09-06.md). Exact repeat-launch duration and audio default remain undecided.

## Current Brigadier source

- **Source checked:** `index.html` has an empty React root and no initial loading artwork.
- **Source checked:** `src-tauri/src/lib.rs` setup calls `tauri::async_runtime::block_on(state::build(data_dir))` before registering ready state. Initialization therefore blocks that setup hook.
- **Source checked:** `src-tauri/src/state.rs` initialization opens the store, builds the supervisor, and awaits a Claude probe. Git pruning/reconciliation subsequently run in a background task from `lib.rs`.
- **Source checked:** `src/App.tsx` mount waits for a grouped `Promise.all` of app info, projects, models, sessions, and approvals before applying the results. It independently probes Claude again. The initial `projectsLoaded` flag governs unknown-project fetching, not a dedicated startup screen.
- **Not measured:** current launch latency, cold/warm timing, or the cost of individual initialization stages. Historical timings in `perceived-performance.md` are not current measurements.

## External primary sources

- **Documented:** [Tauri splashscreen guide](https://v2.tauri.app/learn/splashscreen/) shows spawning backend setup asynchronously and tracking frontend/backend completion. Its example uses two windows; this is an available example, not a requirement to introduce a separate window. Retrieved 2026-09-06.
- **Documented:** [Arc Windows release notes, March 14, 2024](https://resources.arc.net/hc/en-us/articles/22513842649623-Arc-for-Windows-2023-2026-Release-Notes) mention reducing the volume of its unboxing startup sound and polishing onboarding. This verifies that an audible unboxing experience existed; it does not establish its exact visual sequence, duration, current behavior, or macOS behavior. Retrieved 2026-09-06.
- **Unverified:** exact Dia intro choreography/audio. Official Dia getting-started and help results did not establish these details.

## Recommendation to discuss

Show the main window promptly, move blocking initialization off the UI path, and show loading states only for the parts that are still unavailable. Handle failure with a recoverable state instead of indefinite animation. Treat the cinematic welcome as a separate first-launch experience, with original Brigadier motion/audio, skipping and muting available. On subsequent launches, use quiet progress only while actual work remains. These are proposed choices; first-launch versus every-launch behavior remains an interview question.
