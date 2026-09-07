# Native handoff cover, 2026-09-07

Superseded by [onboarding continuity](../plans/onboarding-continuity-2026-09-07.md): native framing now happens before name entry, and the greeting-to-workspace fade no longer uses a cover window. The investigation below records the earlier approach.

## Recommendation

A separate **native window without a webview** can hold a solid graphite frame while the main transparent WKWebView resizes and its native decorations change. This removes the cover's dependence on the surface undergoing reallocation. This is a source-supported mechanism, not yet a verified visual result: a native recording must still verify the actual transition.

Use `tauri::WindowBuilder`, enabling the Tauri `unstable` feature alongside the existing `macos-private-api`. The builder is feature-gated, despite all of its operations being safe Rust. [`WindowBuilder` documentation](https://docs.rs/tauri/2.11.5/tauri/window/struct.WindowBuilder.html), installed `tauri-2.11.5/src/window/mod.rs:106-139`, `src/lib.rs:235-237`.

## Verified recipe

```rust
let cover = tauri::WindowBuilder::new(&app, "launch-cover")
    .title("Brigadier")
    .visible(false)
    .focused(false)
    .focusable(false)
    .decorations(false)
    .transparent(false)
    .shadow(false)
    .resizable(false)
    .closable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .background_color(tauri::window::Color(24, 24, 27, 255))
    .build()?;
```

These methods exist in installed `tauri-2.11.5/src/window/mod.rs`, specifically `new:209`, `build:352`, `focused:877`, `focusable:884`, `visible:891`, and `background_color:933`. The color matches `.launch-surface` in `src/launch.css`: `#18181b`.

Set exact size/position while hidden, using `PhysicalSize` and `PhysicalPosition` for existing monitor/window coordinates. Builder `.position(x,y)` and `.inner_size(w,h)` take **logical** pixels. On mixed DPI screens do not directly pass monitor physical coordinates into the builder. Tao's runtime setters convert using the window's current scale, so moving across displays and then sizing requires a queued-operation barrier before measuring the new scale. Existing `after_native_updates` provides a queue-order barrier, not a compositor-presentation guarantee. Installed `tauri-2.11.5/src/window/mod.rs:813-823`; `tao-0.35.3/src/platform_impl/macos/window.rs:728-760`.

On macOS Tao sets native `NSWindow.backgroundColor` during construction, before showing. With `transparent(false)` it does not call `setOpaque(false)`. Its plain content view only forwards `drawRect` to its superclass, so no HTML or asynchronous page load is required for the fill. Installed `tao-0.35.3/src/platform_impl/macos/window.rs:525-562`; `src/platform_impl/macos/view.rs:341-355`.

`focusable(false)` installs false responses for both `canBecomeMainWindow` and `canBecomeKeyWindow`; `show()` orders the window front using `makeKeyAndOrderFront` but cannot make this cover the key window. Installed `tao-0.35.3/src/platform_impl/macos/window.rs:412-432`, `:668-672`, `util/async.rs:210-217`.

## Ordering and cleanup

1. Fade intro graphics into the existing opaque graphite CSS surface.
2. Create/size/position/show the separate native cover at that exact screen rectangle before resizing the main window. Keep it stationary throughout the native mutation.
3. Restore main controls in their already-fixed order, then resize/reposition after the queued decoration updates.
4. Let the frontend render its post-resize opaque surface at the final viewport dimensions. Send an acknowledgement after a render/paint opportunity, not merely after `launch_finish` returns.
5. Remove the native cover while the identical graphite frontend surface remains opaque. Then fade that frontend surface into the already-mounted workspace.
6. Destroy the cover on error, cancellation, or closing the main window; a failed handoff must never strand an always-on-top square. A separate cleanup deadline can recover if the renderer disappears before acknowledging.

`app.get_window("launch-cover")` returns the native window; `Window::destroy()` bypasses close cancellation and removes it. Native-window lookup is also gated by `unstable`. Installed `tauri-2.11.5/src/lib.rs:541-546`, `src/window/mod.rs:1799`.

Do not pre-create a hidden cover for the entire intro without lifecycle cleanup. Tauri exits automatically only after the last native window is destroyed. A surviving hidden cover prevents closing `main` from being the last-window event. Current Brigadier `lib.rs` does graceful shutdown on `RunEvent::ExitRequested` and `RunEvent::Exit`; destroying a temporary cover while `main` remains does not trigger either. Installed `tauri-runtime-wry-2.11.4/src/lib.rs:4310-4327`, `:4371-4373`; repository `src-tauri/src/lib.rs:295-315`.

## Parenting, appearance, and alternatives

Do **not** parent a screen-stationary cover to the main window that will move. Tauri parenting on macOS calls `addChildWindow:ordered:NSWindowAbove`; AppKit's child-window positioning follows its parent. This is useful for attached windows but works against this handoff. A brief independent `always_on_top(true)` cover avoids being reordered behind the main window; it uses native floating window level, so it must be short-lived and cleaned up. `skip_taskbar` is unsupported on macOS and cannot be relied on to hide auxiliary-window behavior. [`parent` documentation](https://docs.rs/tauri/2.11.5/tauri/window/struct.WindowBuilder.html#method.parent), [Apple child-window API](https://developer.apple.com/documentation/appkit/nswindow/addchildwindow(_:ordered:)), installed `tao-0.35.3/src/platform_impl/macos/window.rs:315-317`, `:1391-1398`.

An opaque undecorated native cover is rectangular. It may briefly square off the CSS card's 18px corners unless the transition has already made those corner pixels opaque. Evaluate native footage rather than assuming exact rounded-corner parity. Do not switch to a transparent native cover just to obtain rounded CSS corners: that reintroduces a webview/paint dependency.

`WebviewWindowBuilder.background_color` configures both native and webview layers, but adds page-loading work and a second renderer surface unnecessarily. Native `WindowBuilder` avoids those dependencies. Installed `tauri-2.11.5/src/webview/webview_window.rs:1170-1186`.

No public Tauri/Tao API was found for an atomic combined frame/style change or `disableScreenUpdatesUntilFlush`. Safe `set_background_color(Some(Color(...)))` on the main window can additionally provide an opaque backing during compositor loss, but fills its entire still-full-monitor rectangle; enabling it before shrinking would replace the dimmed desktop with solid graphite. It is not by itself a visually equivalent fix. Installed `tauri-2.11.5/src/window/mod.rs:1809`, `tao-0.35.3/src/platform_impl/macos/window.rs:908-928`.

## Implementation and verification

Implemented native-only `launch-cover` creation at handoff, main CloseRequested/error cleanup, graphite native backing after geometry settles, and a separate `launch_reveal` acknowledgement. Frontend settling makes App visible under both covers before two paint opportunities; the fade starts only after native removal acknowledges. Returning launches also receive graphite native backing.

Measured: 20 targeted intro/style tests pass, including waiting for native removal and rendering the App before requesting it. Browser integration passes shader, required name, persistence, settings, replay, and reduced motion. `cargo check` and debug/release app bundles succeed. Native QA completed required name → greeting → workspace, exposed enabled window controls, and exited fully when its close button was used (no QA process remained, proving no surviving cover window held it open). Native capture still returns white frames, so no pixel-level claim about the transition is made.

This replaces the previous CSS-only resize cover, which the owner confirmed still flickered: both that cover and App shared the same resized WKWebView surface.
