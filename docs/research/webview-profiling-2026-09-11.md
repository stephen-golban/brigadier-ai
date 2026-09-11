# Profiling the WKWebView inside a Tauri v2 burn build — 2026-09-11

Question: can the Safari Web Inspector's Timeline be used to attribute a long frame inside the
native burn harness, and what is the exact current flag for turning it on in a **release** build?

Answered against current docs today, per `CLAUDE.md` §1. Every claim is marked **[measured]** (read
off this tree), **[docs]** (read off a primary doc today) or **[asserted]**.

## 1. What this tree pins

- `tauri 2.11.5`, `wry 0.55.1`, `tao 0.35.3`, `objc2-web-kit 0.3.2` — **[measured]**, `Cargo.lock`.
- `src-tauri/Cargo.toml:24` — `tauri = { version = "2", features = ["macos-private-api", "unstable"] }`.
  The `devtools` feature is **not** enabled. **[measured]**
- There is no `open_devtools` / `close_devtools` call anywhere in `src-tauri/`. **[measured]**

## 2. The current Tauri v2 route

From <https://v2.tauri.app/develop/debug/>, read 2026-09-11 — **[docs]**:

- The inspector is compiled in for `tauri dev` and debug builds only. To have it in a **release**
  build you must enable the Cargo feature named exactly **`devtools`**:
  `tauri = { version = "2", features = ["…", "devtools"] }`.
- The programmatic API is `WebviewWindow::open_devtools()` and `WebviewWindow::close_devtools()`,
  typically from `Builder::setup` via `app.get_webview_window("main")`.
- On macOS this is **a private API**. Tauri's own doc says using it prevents App Store acceptance.
  It is also only supported on macOS 10.15+.

So the correct incantation for this tree would be a `burn`-only Cargo feature that additionally
enables `tauri/devtools`, plus an env-var-guarded `open_devtools()` in `lib.rs`'s setup. It was
**not** added: see §4.

## 3. `WEBKIT_INSPECTOR` is the wrong route on macOS

`WEBKIT_INSPECTOR_SERVER=ip:port` is documented only for the **WebKitGTK and WPE** ports (Igalia's
WPE/WebKitGTK environment-variable reference and `trac.webkit.org/wiki/RemoteInspectorGTKandWPE`,
read 2026-09-11). No macOS/WKWebView documentation for it was found. **[docs, negative]** — do not
reach for it in this app; on macOS the equivalent is `WKWebView.isInspectable`, which Tauri sets for
you behind the `devtools` feature.

## 4. Why no Timeline recording was taken for the burn-frame work

Three reasons, in order of how binding they are:

1. **The harness forbids it.** `scripts/measure-native-burn.py`'s own docstring: *"No build, UI
   automation, screen capture, or profiler may run during this acceptance workload."* A Timeline
   recording is a profiler attached to the measured process; a capture taken under one is a
   diagnostic, never an acceptance result. **[measured]**
2. **It needs a human at the keyboard.** Opening the Inspector, arming the Timeline, and stopping it
   across a 2-second window 23 seconds into an unattended launch is GUI work. The burn harness
   launches the app, activates it, waits and quits; there is no automation seam for it, and driving
   the GUI with another agent is exactly what invalidated 10 of 31 runs in
   `docs/performance/codex-thread-burn-2026-09-11.md` §2.
3. **Cheaper instruments already exist in-tree and are not perturbing in the same way.**
   `src/perfDiagnostics.ts` records React scheduler `Render`/`Commit` spans, per-component
   aggregates, a `performance.now()` trace (`frame`, `drain`, `notify`, `history-request`/`-response`,
   `turns-request`/`-response`, `markdown-module`, `labels-applied`) and an end-of-frame
   `MessageChannel` probe, all behind `VITE_REACT_PROFILE=1`; and `scripts/measure-native-profile.py`
   wraps the burn with `/usr/bin/sample` against the WebContent pid for a native stack sample. Those
   two are independent of each other (JS instrumentation vs native sampler) and neither needs a
   human. **[measured]**

## 5. What the Inspector would still add, if someone wants it later

The in-tree instruments have a real blind spot, named in
`docs/performance/2026-09-11/cold-path-attribution.md` §4: this WebKit's
`PerformanceObserver.supportedEntryTypes` carries no `longtask`, no `long-animation-frame` and no
`element`, and `performance.getEntriesByType("resource")` came back empty in all five traced
captures. So style, layout, paint and GC are invisible to JS here; a frame with no React span and no
trace entry is simply blank. The Inspector's Timeline is the only instrument that would split
`render-update`'s single number into style/layout/paint. If that split is ever needed:

```toml
# src-tauri/Cargo.toml, burn builds only
[features]
burn = ["tauri/devtools"]
```

```rust
// src-tauri/src/lib.rs, in setup()
#[cfg(feature = "burn")]
if std::env::var_os("BRIGADIER_DEVTOOLS").is_some() {
    if let Some(w) = app.get_webview_window("main") { w.open_devtools(); }
}
```

**[asserted]** — written from §2's docs, not compiled or run in this tree. Note that the extra
window changes the measured window's size and occlusion, so the burn must be re-baselined under it.
