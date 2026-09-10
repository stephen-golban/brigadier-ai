# Brigadier native profiling setup — 2026-09-10

Read-only research; no build, app launch, or profiling run was performed. The configuration examples below are proposed diagnostic instrumentation, not measured results. Parent task owns the recovered worktree and acceptance runs.

## Verified local versions and production profiling

Main checkout currently has `react-dom` **19.2.8** and Vite **7.3.6** installed, although package.json allows `react-dom ^19.1.0`. `src/main.tsx` imports `react-dom/client`. Recheck the recovered worktree's installed versions before use.

React officially recommends aliasing `react-dom/client` to `react-dom/profiling` for profiling builds. Profiling introduces overhead and must stay out of acceptance. The installed `node_modules/react-dom/profiling.js` selects `cjs/react-dom-profiling.profiling.js` under `NODE_ENV=production`; that file exports `createRoot` (line 17848). [React profiling builds](https://react.dev/reference/dev-tools/react-performance-tracks)

Suggested opt-in addition to the existing Vite alias configuration (preserve its `@` alias):

```ts
resolve: {
  alias: [
    ...(process.env.BRIGADIER_REACT_PROFILE === "1"
      ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }]
      : []),
    { find: "@", replacement: srcDir },
  ],
},
```

Vite supports ordered array aliases with regular-expression matching. Use an exact match so other React DOM entry points remain intact. Build with `BRIGADIER_REACT_PROFILE=1` only for the diagnostic package; retain normal production mode and release Rust optimization. [Vite alias documentation](https://vite.dev/config/shared-options#resolve-alias)

## What to record, and what the numbers mean

Wrap the mounted App, Sidebar, ThreadView, and Transcript boundaries with `<Profiler id="..." onRender={...}>`. Store the six callback fields in memory and export after capture. Do not set React state, write localStorage, or invoke native IPC per callback. `actualDuration` measures rendering in that subtree; `baseDuration` estimates the unoptimized render cost. `startTime` and `commitTime` are timestamps. **`commitTime - startTime` is not commit duration.** Group callbacks by `commitTime`; nested subtree durations overlap, so do not sum all profilers. [Profiler API](https://react.dev/reference/react/Profiler)

The installed runtime calls an additional undocumented `onCommit(id, phase, effectDuration, commitStartTime)` at lines 9354–9377. Its input accumulates effect durations during layout-effect traversal (lines 9797–9819); it is neither a stable public API nor complete DOM/layout/paint timing. The installed React type declarations omit it. Avoid labeling it total commit duration.

More useful: the installed profiling runtime emits its own commit span at lines 13355–13375:

```js
console.timeStamp("Commit", startMs, endMs, currentTrack, "Scheduler ⚛", color)
```

Component render spans use `console.timeStamp(name, startMs, endMs, "Components ⚛", ...)` at lines 2472–2500. A diagnostic-only bootstrap can wrap `console.timeStamp` **before importing React DOM**, append numeric spans to memory, and forward to the original function. This captures React's own spans even when Web Inspector cannot display Chrome's custom tracks. Keep the original function binding and arguments. Filter by the exact Scheduler/Components track arguments to exclude unrelated timestamps.

Caveat: source chooses completed-render end as the commit span start for ordinary commits, and `commitStartTime` after a suspended commit. The span includes the React commit path through DOM mutation/layout effects; browser paint is outside it. Report its exact definition rather than claiming independent paint or CPU timing. This wrapper is proposed from inspected source and has not been run here.

React's current performance-track documentation describes render, commit, and remaining-effects phases, but the page currently targets React 19.3. Local 19.2.8 source is the authority for the emitted argument format above. Browser custom-track support is not guaranteed by merely having `console.timeStamp`. [React performance tracks](https://react.dev/reference/dev-tools/react-performance-tracks)

## Native WebContent CPU and layout/paint

Verified host: macOS 26.6.2, full Xcode at `/Applications/Xcode.app/Contents/Developer`; `/usr/bin/xctrace`, `/usr/bin/sample`, and `/usr/sbin/spindump` exist. `xcrun xctrace list templates` lists **Time Profiler**, **CPU Profiler**, **Animation Hitches**, **System Trace**, and **Activity Monitor**. These are local tool outputs, not evidence that attaching to this app succeeds.

Identify Brigadier's actual WebContent PID before capture; multiple running WKWebView apps can share generic process names. Preserve process inventory and attribution evidence, then attach to the numeric PID. Proposed commands, syntax verified against local help:

```sh
xcrun xctrace record --template 'Time Profiler' --attach "$brigadier_webcontent_pid" --time-limit 15s --output /tmp/brigadier-perf-e2ce/webcontent-before.trace
xcrun xctrace export --input /tmp/brigadier-perf-e2ce/webcontent-before.trace --toc --output /tmp/brigadier-perf-e2ce/webcontent-before-toc.xml
sample "$brigadier_webcontent_pid" 15 1 -file /tmp/brigadier-perf-e2ce/webcontent-before-sample.txt
```

Run either recorder in a separate diagnostic burn, not simultaneously by default. A native stack sample can identify CPU residency in JavaScriptCore, style, layout, painting, IPC or waits; it cannot provide precise per-frame layout durations. Inspect the exported trace table of contents before choosing XPath exports; schema names are instrument/version-dependent. Local sources: `xcrun xctrace help record`, `xcrun xctrace help export`, and `sample --help` (the last prints usage and exits 255 because no PID was supplied).

For exact browser categories, Web Inspector Timelines records style invalidations/recalculations, layout, composite, and paint, plus sampled JavaScript and page-related CPU. Frames view groups that work by frame, and recordings export to a reusable file. Disable Screenshots and unnecessary allocation/memory/media tracks for this diagnosis. Correlate workload and React markers against Layout & Rendering and JavaScript & Events. [WebKit Timelines documentation](https://webkit.org/web-inspector/timelines-tab/)

Release WKWebViews require opting into `isInspectable`; the API defaults false and is available on macOS 13.3+. Safari Develop then exposes the inspectable view. [WebKit inspectability API](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/)

Installed Tauri 2.11.5 source (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.11.5/src/webview/webview_window.rs`) exposes builder `.devtools(true)` at line 1167, and `open_devtools()` only under `debug_assertions` or the `devtools` feature at lines 2438–2441. Main's Tauri dependency currently has `macos-private-api` and `unstable`, not `devtools`. Enable inspectability only in a separate diagnostic build if required; do not change acceptance to a debug build.

## Measurement discipline

Keep acceptance binary free of profiling aliases, timestamp wrappers, inspectors, samplers, HMR, and competing builds. Use the unchanged ThreadView workload and fresh isolated data in diagnostics too. Compare before/after render counts and durations, commit spans, browser layout/paint, CPU samples, and delivered workload counts. This research establishes measurement methods; it establishes no performance cause or passing result.

## Exact-PID activation helper (follow-up)

Use `NSRunningApplication(processIdentifier: spawnedPid)` followed by `activate(options:)`. The initializer identifies the existing application instance and returns nil if no application has that PID; neither operation launches an application. This avoids bundle-based lookup and the `open -a` path that produced a second instance in the parent task's diagnostic. [Apple PID initializer](https://developer.apple.com/documentation/appkit/nsrunningapplication/init%28processidentifier%3A%29)

The current SDK's `NSRunningApplication.h` verifies:

- Lines 163–165 declare the nullable PID lookup.
- Lines 146–148 say `activateWithOptions:` returns whether the request was sent, not whether foreground activation finished.
- Lines 19–27 define `.activateAllWindows`; `.activateIgnoringOtherApps` is deprecated since macOS 14 and explicitly has no effect.
- Lines 129–144 document macOS 14+ `activate(from:options:)`: activation may fail or be delayed, and the other app should yield first.
- Lines 49–61 warn that time-varying properties stay cached until the main run loop advances. Pump the run loop while polling activation, rather than using only sleep.

SDK source: `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/AppKit.framework/Versions/C/Headers/NSRunningApplication.h`. These are first-party installed headers read on 2026-09-10.

A command-line helper cannot manufacture cooperative yield on behalf of Codex, Terminal, or another foreground app. Only the active app can influence that activation context. Merely passing `NSWorkspace.shared.frontmostApplication` to `activate(from:options:)` does not establish that it yielded. Apple documents activation as a request subject to system context, so the harness must fail preparation if foreground activation is not observed. There is no verified general prohibition on a CLI issuing the request, and no verified guarantee it will succeed. [Apple cooperative activation](https://developer.apple.com/documentation/appkit/passing-control-from-one-app-to-another-with-cooperative-activation)

Minimal helper, **type-checked successfully with installed `xcrun swiftc -typecheck -` (exit 0), not executed**:

```swift
import AppKit
import Foundation

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}
guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]), pid > 0 else {
    fail("usage: activate-pid PID", 64)
}
let deadline = ProcessInfo.processInfo.systemUptime + 10
var target: NSRunningApplication?
while ProcessInfo.processInfo.systemUptime < deadline {
    if let candidate = NSRunningApplication(processIdentifier: pid),
       !candidate.isTerminated, candidate.activationPolicy != .prohibited {
        target = candidate
        break
    }
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
}
guard let target else { fail("PID did not register as an activatable app", 2) }
let requested = target.activate(options: [.activateAllWindows])
var activeSince: TimeInterval?
while ProcessInfo.processInfo.systemUptime < deadline {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
    if target.isTerminated { fail("target terminated", 3) }
    let now = ProcessInfo.processInfo.systemUptime
    if target.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
        if activeSince == nil { activeSince = now }
        if now - activeSince! >= 0.25 {
            print("activated pid=\(pid) requestSent=\(requested)")
            exit(0)
        }
    } else { activeSince = nil }
}
fail("activation timeout pid=\(pid) requestSent=\(requested)", 4)
```

Save that code as a task-owned `activate-pid.swift`, then compile **before any timed run**:

```sh
xcrun swiftc -O /tmp/brigadier-perf-e2ce/activate-pid.swift -o /tmp/brigadier-perf-e2ce/activate-pid
```

During harness preparation, invoke the precompiled helper with the PID returned by the direct spawn. Wait for exit 0, then allow the normal settling interval before starting burn capture. The helper checks 250 ms of stable foreground status; it does not prove unobstructed content, successful browser paint, or capture validity. Keep native window visibility and document visibility checks. It deliberately avoids requiring `isFinishedLaunching`, because the SDK says some apps never post its triggering notification. For additional identity assurance, compare `target.executableURL` with the expected benchmark binary and retain the spawned process handle until termination.

Do not move the startup clock forward to after activation: pre-spawn-to-FCP must retain its original clock origin and every sample. Activation belongs in the same consistent repeated-launch procedure; its helper compilation belongs outside it. If FCP occurs before focus, preserve the sample and record that ordering. Burn capture may start only after foreground preparation succeeds.

## Replay delivery correction

Measured after the peer persistence fix: the last-started replay emitted 11,977 workload events plus its terminal event in 60,000 ms. `ReplayDriver` explicitly selected `MissedTickBehavior::Delay`, which moves future deadlines after a late tick and permanently reduces delivered workload. Tokio documents `Burst` as retaining the original schedule and catching up missed ticks. The burn must use that behavior to deliver its requested rate rather than silently lowering it when busy. This only affects the synthetic replay driver, not provider events or the frame meter. Sequential session setup remains included in capture and creates extra work for earlier sessions; require at least 12,000 workload events per session and preserve all raw counts/timestamps. [Tokio interval behavior](https://docs.rs/tokio/latest/tokio/time/enum.MissedTickBehavior.html)

## Attention snapshots and lazy scroll initialization

Verified API contract: a `useSyncExternalStore` notification calls `getSnapshot`; React compares its value with the prior snapshot using `Object.is`. An unchanged primitive therefore does not itself schedule a store-driven rerender. Returning a newly allocated object on every call violates the snapshot caching contract. `subscribe` must return cleanup; changing its function identity resubscribes, so use a module-level function or a dependency-correct `useCallback`. Snapshots must be immutable and remain equal while their represented data is unchanged. [React external-store contract](https://react.dev/reference/react/useSyncExternalStore)

Verified installed React DOM 19.2.8 source: `node_modules/react-dom/cjs/react-dom-client.production.js:4746` implements the subscription callback as `checkIfSnapshotChanged(inst) && forceStoreRerender(fiber)`; the check at line 4751 calls `getSnapshot()` and compares with `objectIs`. Exceptions trigger an update. This equality only suppresses the store-induced update; parent, props, other state, and other subscriptions can still render the component.

Local source observation: `src/attention.ts` acknowledges the selected session in an effect, writes storage, dispatches `brigadier-session-read`, then each hook subscriber reparses storage into a fresh object and calls `setReads`. Parent-reported diagnostic counts are 3,655 store rebuilds, 6,628 App renders, and 2,853 `readPersistence` calls; this research did not independently rerun that diagnostic. The event-to-state path explains a mechanism for extra updates, but its measured contribution still requires a before/after run.

Implementation inference: snapshot the semantic attention result needed by the hook using a stable primitive or cached immutable value. An incrementing revision or serialized full read-sequence map would still change on every selected-session acknowledgment and miss this optimization. Keep acknowledgment/persistence and notifications intact; compare their derived UI result to suppress redundant React work. Preserve pending-approval priority, failed/completed unread state, and worker-pane acknowledgment. Keep storage writes outside `getSnapshot`, which React may call repeatedly. Test real semantic changes as well as equal notifications.

Verified lazy initialization: `useState(() => readSavedScroll(sessionId))` calls the initializer when creating state, rather than evaluating `readSavedScroll` as a JavaScript argument on every render. Development Strict Mode may invoke it twice; keep it free of writes. React ignores the initial-state argument after initialization. [React state initialization](https://react.dev/reference/react/useState#avoiding-recreating-the-initial-state)

Local source observation: Transcript currently uses **`useRef(IIFE())`**, whose storage-reading IIFE is evaluated on every render even though the ref retains its first value. Its saved scroll value is only read afterward, so lazy `useState` without using its setter can hold that immutable mount snapshot. Transcript already has `key={sessionId}`, so changing sessions remounts it and reads that session's saved scroll. Retain parsing fallback, saved `top`/`following` behavior, layout-effect restoration, and existing scroll persistence. No application files, builds, or running apps were changed by this research.

## Debug/Vite comparison without file watching or HMR updates

Verified Vite 7 documentation: `server.hmr: false` disables HMR; `server.watch: null` disables file watching, including later watcher add/unwatch operations. `strictPort: true` prevents silent port changes. Current documentation retains these options. [Vite 7 server options](https://v7.vite.dev/config/server-options), [current server options](https://vite.dev/config/server-options)

The existing config exports an async callback, so call and await it before extending its object. Vite's `mergeConfig` accepts objects, not callbacks. **Do not use `mergeConfig` for the null watcher override:** installed Vite 7.3.6 `dist/node/chunks/config.js:2494` skips overrides whose value is null, retaining the base watcher. Direct object spread avoids that trap. [Vite async configuration](https://v7.vite.dev/config/#async-config), [Vite config merging](https://v7.vite.dev/guide/api-javascript#mergeconfig)

Proposed temporary `/tmp/brigadier-perf-e2ce/vite-benchmark.config.mjs`:

```js
import base from "/Users/stephen/.codex/worktrees/e2ce/brigadier-ai/vite.config.ts";

export default async (env) => {
  const config = await base(env);
  return {
    ...config,
    root: "/Users/stephen/.codex/worktrees/e2ce/brigadier-ai",
    server: {
      ...config.server,
      host: "127.0.0.1",
      port: 1422,
      strictPort: true,
      open: false,
      hmr: false,
      watch: null,
    },
  };
};
```

Launch from the performance worktree, before native timing:

```sh
VITE_BURN=1 VITE_REACT_PROFILE=0 node node_modules/vite/bin/vite.js --config /tmp/brigadier-perf-e2ce/vite-benchmark.config.mjs --mode development
```

The command preserves development React behavior, all base plugins/aliases, and dependency exclusions. The native debug binary must independently target `http://127.0.0.1:1422`; starting this server does not alter its compiled dev URL. Settle dependency optimization/transforms before burn capture and record whether startup samples use a cold or already-warmed Vite server. Disabling file watching does not stop on-demand transforms or dependency optimization.

Installed source additionally verifies that `@vitejs/plugin-react/dist/index.js:140` disables Fast Refresh when `server.hmr === false`; Vite `config.js:25461` selects its no-op watcher when watch is null. However, **Vite 7.3.6 still injects `/@vite/client` and its WebSocket transport with HMR disabled** (`config.js:24875`, `client/client.mjs:733–755`). Label this configuration “HMR updates and file watching disabled”; do not claim it removes all Vite client traffic. Setting experimental `server.ws: false` alone disables the server endpoint but leaves the injected client trying to connect. Removing or rewriting the Vite client would change the development baseline and is outside this minimal comparison setup. Exact config/command above was researched but not launched or built by the research agent.
