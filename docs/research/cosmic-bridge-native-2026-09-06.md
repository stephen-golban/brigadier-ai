# Cosmic bridge: native launch implementation

Verified 2026-09-06 against installed source. Research only; no application source changed or native app launched for this note.

## Decision

**A single transparent main webview is a viable minimal implementation:** begin hidden, configure it borderless over the chosen monitor's work area, show the dim/orb animation, and resize/reposition the same native window to the animation's final application rectangle. Keep its webview transparent throughout and paint the final app with opaque CSS. This avoids a second webview's readiness, handoff and capabilities plumbing. This is an architectural inference from the APIs below, not a native rendering result. A separate overlay remains possible but is unnecessary for this approach.

The earlier [feasibility note](desktop-intro-glass-feasibility-2026-09-06.md) has correct installed versions and transparency restrictions. Its separate-overlay proposal was a candidate, not a requirement. Its statement about `state::build` blocking setup remains true in the source inspected at the start of this research.

## Exact native APIs

Resolved versions remain Tauri **2.11.5**, tauri-runtime-wry **2.11.4**, Wry **0.55.1**; see [Cargo.lock](../../Cargo.lock). The Tauri config currently creates the default `main` window; [default capability](../../src-tauri/capabilities/default.json) targets `main`. A single-window implementation preserves that label.

Installed [`WebviewWindow` source](https://docs.rs/tauri/2.11.5/src/tauri/webview/webview_window.rs.html) exposes:

```rust
window.current_monitor() -> tauri::Result<Option<Monitor>>
window.primary_monitor() -> tauri::Result<Option<Monitor>>
window.set_decorations(bool) -> tauri::Result<()>
window.set_shadow(bool) -> tauri::Result<()>
window.set_resizable(bool) -> tauri::Result<()>
window.set_size<S: Into<Size>>(S) -> tauri::Result<()>
window.set_position<P: Into<Position>>(P) -> tauri::Result<()>
window.show() -> tauri::Result<()>
window.set_focus() -> tauri::Result<()>
window.run_on_main_thread<F: FnOnce() + Send + 'static>(F) -> tauri::Result<()>
```

[`Monitor`](https://docs.rs/tauri/2.11.5/src/tauri/window/mod.rs.html) supplies `work_area() -> &PhysicalRect<i32, u32>`, `position() -> &PhysicalPosition<i32>`, `size() -> &PhysicalSize<u32>`, and `scale_factor() -> f64`. `work_area` has public `position` and `size` fields. Use work-area physical values directly for native placement; convert dimensions to logical/CSS units using the monitor scale factor. Do not mix physical monitor dimensions and CSS coordinates. A secondary display can have a negative global origin.

Practical sequence: get current monitor with primary fallback; set borderless/shadowless/nonresizable; set monitor work-area position and size while hidden; show after the page is ready; render the final card inside that viewport; then set final native geometry, restore decorations/shadow/resizability, and let the DOM fill the resized content area. Use a Rust command to own the transition and return a failure result that the UI handles. The ordinary app needs no JavaScript window-setter permissions if the command performs these operations in Rust.

**Geometry is not atomic.** Installed Tao's macOS `set_outer_position` sets the native outer top-left, while `set_inner_size` changes the content size. Enabling decorations changes frame versus content geometry. It also defers decoration changes during actual macOS fullscreen. Therefore use a normal work-area-sized window, and verify titlebar compensation and transition seams in the native app. Sources: installed `tao-*/src/platform_impl/macos/window.rs`, `set_outer_position`, `set_inner_size`, `set_decorations`; [Tao source](https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/macos/window.rs).

## Transparency and background limitations

Set `app.macOSPrivateApi: true` in config and enable the `macos-private-api` Cargo feature on `tauri`; set the window `transparent: true`. The builder's `transparent` method is compiled on macOS only under that feature. The configuration source still describes private APIs as preventing Mac App Store acceptance. It makes no assertion about direct-download notarization. Sources: installed `tauri-utils-2.9.3/src/config.rs` (`WindowConfig::transparent`, `AppConfig::macos_private_api`, `AppConfig::features`); installed `tauri-2.11.5/src/webview/webview_window.rs:1072`; [official window builder](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindowBuilder.html#method.transparent).

`WebviewWindow::set_background_color(Option<Color>)` calls both the window and webview setters. Its documentation explicitly says the macOS webview layer is not implemented. Do not rely on it to switch WKWebView from transparent to opaque after the intro. Set opaque document/app backgrounds after completion. The transparent initial page must also keep `html`, `body` and root backgrounds transparent; a full-page opaque canvas would prevent desktop dimming. Source: installed `tauri-2.11.5/src/webview/webview_window.rs:2274–2287` and [`WebviewWindow` source](https://docs.rs/tauri/2.11.5/src/tauri/webview/webview_window.rs.html).

## Background initialization without breaking managed state

The current [`AppState`](../../src-tauri/src/state.rs) has `get(&self) -> Result<&Ready, AppError>` and many command callers retain that reference across async operations. Replace its two `Option` fields with **one `OnceLock<Result<Ready, AppError>>`**, managed before starting initialization. Empty means pending. `get()` can preserve its existing borrowed return type and clone only errors. `OnceLock::get` never blocks; `set` publishes once and rejects a second value. Do not use blocking `wait` from UI commands. [Rust `OnceLock` documentation](https://doc.rust-lang.org/std/sync/struct.OnceLock.html).

Tauri's managed map is keyed by type and does not replace an already-managed value; trying to manage a new `AppState::ready` after managing pending silently fails to install it. Do not unmanage the state. Sources: installed `tauri-2.11.5/src/state.rs:105–149`; [Tauri state source](https://docs.rs/tauri/2.11.5/src/tauri/state.rs.html).

In setup, resolve the app data directory, manage pending state, install signal handling, and spawn async initialization with a cloned `AppHandle`. Return `Ok(())` promptly. Preserve startup failures in the cell, including `data_dir_locked`; the frontend must see a pending/ready/failed response and bootstrap ordinary commands only after pending resolves. An event alone can be missed; use a queryable state or a readiness command that can be called after listener installation. Tauri's official splashscreen example explicitly moves setup work off the setup callback. [Official splashscreen guide](https://v2.tauri.app/learn/splashscreen/).

Keep the repository's prune-then-reconcile order and reconciliation barrier. Publish Ready before `peers::start` / `cleanup::start`, since those functions call `app.state::<AppState>().get()`. Be deliberate about whether UI readiness waits for those services; publishing Ready alone makes ordinary commands available immediately. Sources: [`lib.rs`](../../src-tauri/src/lib.rs), [`peers.rs`](../../src-tauri/src/peers.rs), [`cleanup.rs`](../../src-tauri/src/cleanup.rs).

**Exit/publication race:** once initialization is asynchronous, quitting can happen while the cell is empty. A one-time cell by itself does not prevent initialization from publishing after shutdown checked it. Serialize publication and the shutdown transition with a brief mutex containing a closing flag. Publication checks that flag under the mutex before setting the cell; shutdown marks it under the same mutex and obtains the ready reference before unlocking. Do not hold the lock through an await or `block_on`. If exit wins before publication, do not start peers, cleanup or reconciliation. Preserve the existing idempotent `ExitRequested` and `Exit` cleanup hooks. This is a concurrency recommendation derived from the existing shutdown contract, not functionality provided by OnceLock.

## Isolated native verification

Do not launch a test build against `ai.brigadier.app` data. Existing startup opens the store, sweeps pid records and reconciles project worktrees. A read-only lock does not make an ordinary launch an isolated test. There is currently no app-data override environment variable in `lib.rs`.

The installed CLI accepts `tauri dev --no-watch --config /absolute/path/to/qa-config.json`; `--config` merges a JSON file into the default config (verified using `node_modules/.bin/tauri dev --help`). Give the QA build a unique identifier such as `ai.brigadier.cosmic-qa-20260906`, and a distinctive title/product name. Tauri's `app_local_data_dir` derives the path from that config identifier. Source: installed `tauri-2.11.5/src/path/desktop.rs:250–260`; [configuration files](https://v2.tauri.app/develop/configuration-files/).

Set `incognito: true` in the QA window configuration to keep webview storage isolated too. Wry explicitly chooses `WKWebsiteDataStore::nonPersistentDataStore` for incognito; without it the fallback is the default store. Array config overrides replace the window list, so supply the complete intended QA window settings when overriding `app.windows`. Sources: installed `tauri-utils-2.9.3/src/config.rs:2105–2111`; installed `wry-0.55.1/src/wkwebview/mod.rs:229–244`; [Wry source](https://docs.rs/wry/0.55.1/src/wry/wkwebview/mod.rs.html).

An empty isolated store has no project worktrees or live agents to reconcile. The initial Claude version probe still runs, but does not create a coding session or API call; see [`state::build`](../../src-tauri/src/state.rs). Verify intro first paint, alpha dimming, final frame/content position, focus and resizing, required-name persistence, disabled-intro behavior, startup error, and quit during pending initialization. Stop only the PID launched for QA via the normal SIGTERM handler; do not kill processes by the generic `brigadier` name. No native run was performed for this research, so these remain implementation verification tasks.

## Full-display backdrop correction — 2026-09-07

The user observed undimmed wallpaper below the Dock. The initial window used `monitor.work_area()`, which deliberately excludes OS-reserved regions. It now uses `*monitor.size()` and `*monitor.position()` for the borderless intro. The ordinary workspace still restores within the work area. Exact getters and return types rechecked in installed Tauri 2.11.5 `src/window/mod.rs` lines 86–97; the corresponding official source is linked above. This is a full-display borderless window, not native macOS fullscreen/Spaces.
