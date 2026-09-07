# Intro window controls: macOS setter ordering

Verified 2026-09-07 against the installed, locked Tauri 2.11.5 / tauri-runtime-wry 2.11.4 / Tao 0.35.3 sources. Research only; no application source edited or native app launched.

## Cause

`launch::restore` calls `set_decorations(true)` while Tao's shared `resizable` state is still false. Tao builds a decorated style mask without `NSWindowStyleMask::Resizable`, then queues that mask asynchronously. The following `set_resizable(true)` changes the native mask synchronously, but the previously queued decoration operation subsequently overwrites it with the nonresizable mask. This is a deterministic ordering defect in the inspected implementation and explains why restoring the titlebar does not restore resizing/zoom/fullscreen behavior. Sources: installed `tao-0.35.3/src/platform_impl/macos/window.rs:795–810,1342–1376`; [versioned upstream window implementation](https://github.com/tauri-apps/tao/blob/tao-v0.35.3/src/platform_impl/macos/window.rs).

## Minimal fix

Call `set_resizable(true)` **before** `set_decorations(true)`. This updates the shared state before the decoration mask is constructed. The decorated mask includes Titled, Closable, Miniaturizable and Resizable. No additional fullscreen collection behavior is changed by either setter. `set_maximizable(true)` merely enables an existing Zoom button, so it cannot repair the missing Resizable bit and should not substitute for the ordering fix. If explicitly restoring button enablement, do so after decorations have actually applied. Sources: same installed window implementation, `set_resizable`, `set_decorations`, `set_maximizable`, `set_minimizable`.

```rust
window.set_resizable(true).map_err(native)?;
window.set_decorations(true).map_err(native)?;
window.set_shadow(true).map_err(native)?;
```

## Related handoff timing

Running these setters inside `run_on_main_thread` does **not** make their native changes synchronous. Tauri dispatches inline there, but Tao's decoration, content-size and frame-position helpers always enqueue main-dispatch-queue operations. The existing oneshot can therefore resolve before native geometry changes apply. Its immediate titlebar measurement can also observe the previous frame. Sources: installed `tauri-runtime-wry-2.11.4/src/lib.rs:235–255`; installed `tao-0.35.3/src/platform_impl/macos/util/async.rs:62–110`; [versioned upstream dispatch helpers](https://github.com/tauri-apps/tao/blob/tao-v0.35.3/src/platform_impl/macos/util/async.rs).

For a handoff completion barrier, observe settled target geometry or enqueue a native main-queue callback after these operations. Repeating `run_on_main_thread` immediately from the main thread is not such a barrier. Perform final titlebar measurement and button restoration after the decoration operation. Then allow the frontend to remove its transition cover.

## Native verification still required

After submitting the name: verify native edge resizing, yellow minimize, green-button zoom/fullscreen entry and exit, and smooth content/titlebar placement. Verify returning launch separately. This note establishes the source-level cause; it does not claim those interactions were executed.

## Implemented handoff

`launch.rs` now restores resizability before decorations, queues a dispatch2 main-queue callback before measuring the titlebar/restoring geometry, then queues another before returning `launch_finish`. dispatch2 0.3.1 was already locked transitively; its safe `DispatchQueue::main().exec_async` API was verified in the installed source. Final content position matches the full-monitor-centered intro card.

The renderer uses three phases: fade greeting/field to an opaque graphite card; restore native geometry behind that card; after two animation frames, fade the cover over the mounted App. CSS animation-end events control both fades, and the WebGL canvas is not recreated midway through a visible fade. React's effect in the Suspense subtree gates the handoff on App committing.

Measured: 269 frontend tests pass, including pending App commit, native finish pending/failure/retry, animation-completion ordering, and name validation. Browser integration passes normal/reduced motion, shader, name persistence, settings, and replay. Native QA subsequently completed onboarding. Accessibility exposed enabled close, fullscreen/zoom, and minimize controls. The zoom secondary action succeeded; clicking fullscreen removed the normal titlebar controls, and Control-Command-F restored them on exit. Minimize accepted its action. Native screen capture returned white and then ScreenCaptureKit error -3811, so pixel-level smoothness and the exact zoom/minimize geometry were not visually verified. All 67 native library tests passed. The release bundle was signed, installed at `/Applications/Brigadier.app`, and relaunched with the onboarding flags reset; the installed accessibility tree showed the initial welcome with its Continue button still gated by the intro animation. Backup: `~/Library/Application Support/Brigadier App Backups/20260907-133049`.
