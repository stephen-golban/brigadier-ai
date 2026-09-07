# Desktop intro and glass feasibility

Research date: 2026-09-06. Approved direction: desktop dimming, floating orb expanding into the app, repeat-launch intro/music with Settings controls, and subtle glass surfaces. This note identifies implementation checks, not additional approval gates. No product changes or runtime experiment.

## Available foundation

Brigadier resolves Rust Tauri **2.11.5**, tauri-runtime-wry **2.11.4**, Wry **0.55.1**, and JavaScript API **2.11.1**. Its current configuration creates one ordinary 1280×800 window, with no transparency, native effects or private-API setting. Its capabilities cover only the `main` window. Sources: local `Cargo.lock`, `node_modules/@tauri-apps/api/package.json`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`.

Tauri supports transparent, undecorated, positioned/sized, always-on-top windows, visibility control, and separate splashscreen windows. **Feasible construction to prototype:** a temporary transparent borderless overlay on the launch display, a translucent dim layer, and an orb animated within it toward the final app bounds; then hand off to the already-rendered main window and destroy the overlay. This is an implementation inference from the available primitives, not a built-in orb-to-window transition. Keep the effect local to its window/display rather than changing monitor brightness. [Window configuration](https://v2.tauri.app/reference/config/#windowconfig), [official splashscreen pattern](https://v2.tauri.app/learn/splashscreen/).

On macOS, Tauri documents that transparent webview windows require its `macos-private-api` feature/configuration (`app.macOSPrivateApi`). The docs explicitly state that use of those private APIs prevents App Store acceptance. That is the relevant distribution constraint of this Tauri transparency path; this note makes no claim about direct-download notarization. The inspected Brigadier configuration has not enabled the feature. [Transparency requirements](https://v2.tauri.app/reference/config/#transparent), [private-API configuration](https://v2.tauri.app/reference/config/#macosprivateapi).

## Two different glass effects

CSS `backdrop-filter` filters content behind an element in the page's backdrop; transparency is necessary to see the result. Use it for menus/popovers over Brigadier content. It is not a supported mechanism for reading or blurring wallpaper and unrelated native windows behind the webview. [CSS backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter).

For native background material, Tauri offers macOS effects such as `sidebar`, `menu`, `popover` and `underWindowBackground`; these require a transparent window. They are window effects, not per-DOM-element materials. A native material underlay with opaque main content and a translucent sidebar is a candidate composition; verify clipping, corner treatment and focus-state appearance in the packaged app. Neither CSS blur nor these named materials proves Liquid Glass parity. [Native window effects](https://v2.tauri.app/reference/config/#windoweffects), [materials](https://v2.tauri.app/reference/config/#windoweffect).

## Startup and sound checks

Current `src-tauri/src/lib.rs:229` blocks inside setup on `state::build(data_dir)`. First visible painting must be decoupled from that initialization for an immediately animated intro. Tauri's splashscreen guide demonstrates background setup and a later main-window handoff. Publish explicit ready/failed state, keep the intro's initial assets lightweight, and remove the overlay on both success and failure; the animation must not conceal an initialization failure. [Splashscreen lifecycle](https://v2.tauri.app/learn/splashscreen/).

Local Wry 0.55.1 defaults its autoplay option to true (`src/lib.rs:843`); its WKWebView setup clears the media user-action requirement when enabled (`src/wkwebview/mod.rs:361`). That supports attempting automatic intro music but does not verify audible playback, precise animation/audio synchronization, Web Audio behavior, or media decoding in Brigadier's packaged macOS build. Test the chosen playback method and handle rejection without blocking startup. Honor saved intro/music preferences before starting audio. [Wry autoplay API](https://docs.rs/wry/0.55.1/wry/struct.WebViewBuilder.html#method.with_autoplay).

Implementation verification: cold and warm first paint; overlay-to-main transition without a flash; mixed-DPI/multiple displays and current Space; focus and click handling; cleanup after failure/quit; reduced-motion behavior; packaged audio playback and toggles. These are feasibility/quality checks within the approved design, not reasons to reopen it.
