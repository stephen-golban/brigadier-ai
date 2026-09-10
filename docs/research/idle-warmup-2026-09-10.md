# Warming the MarkdownContent chunk during idle — 2026-09-10

Read-only research plus a standalone WKWebView probe. No app launch, no `npm run build`, no source edit. Everything
labelled **[measured]** was produced on this machine today by a compiled Swift harness driving a `WKWebView`; everything
labelled **[asserted]** comes from a spec, a vendor doc, or installed source that was read but not executed.

The bottom line first, because it inverts the brief's leading hypothesis:

- `requestIdleCallback` **does not exist** in this WebKit, and neither does `scheduler.postTask`. **[measured]**
- `<link rel="modulepreload">` **fetches and populates the module map but never evaluates**, and for this specific
  286 KB chunk the cost is almost entirely evaluation — a preload hint removed **~0 ms of ~55 ms**. **[measured]**
- Actually calling `import()` early removes **all** of it: the later `import()` measures **0.0 ms**. **[measured]**

So the fix is to *call the import*, not to hint at it, and the whole question is *when*.

---

## 0. The probe, so the numbers below can be dismissed or reproduced

`/private/tmp/.../scratchpad/pl.swift` — a `swiftc -O` binary, `NSApplication` with `.prohibited` activation policy, a
`WKWebView` with a **non-persistent** `websiteDataStore`, `callAsyncJavaScript` against a page served by
`python3 -m http.server` on `127.0.0.1:8731` out of a **copy of this worktree's `dist/`**. One fresh process per sample;
every URL carries a distinct `?v=` cache-buster. The UA the probe reported is byte-identical to the one the brief quotes
for the app: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)`. **[measured]**

Host: macOS 26.6.2 (build 25G83), Safari 26.6.2. **[measured]** — `sw_vers`, `defaults read /Applications/Safari.app/…`.

The scratchpad probe is disposable and is not part of the repo.

---

## 1. `requestIdleCallback` in this WebKit: absent, and it is not an oversight

### Measured, in this machine's WKWebView

```json
{"ric":"undefined","cic":"undefined","postTask":"undefined","schedYield":"undefined",
 "modulepreload":true,"preload":true,
 "entryTypes":["event","first-input","largest-contentful-paint","mark","measure","navigation","paint","resource"]}
```

`typeof window.requestIdleCallback === "undefined"`, `cancelIdleCallback` likewise, `scheduler.postTask` and
`scheduler.yield` likewise. **[measured]** The `entryTypes` list reproduces exactly what `src/paint.ts:21-23` already
records, which is a useful cross-check that the probe and the app see the same engine.

### Why, from WebKit's own source and bug tracker

- WebKit trunk `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml:4980-4986` — the only place the feature's
  default lives — reads:

  ```yaml
  RequestIdleCallbackEnabled:
    type: bool
    status: testable
    category: dom
    humanReadableName: "requestIdleCallback"
    humanReadableDescription: "Enable requestIdleCallback support"
    defaultValue: false
  ```

  `status: testable` and `defaultValue: false`: implemented, off by default, on every port. **[asserted]** — read from
  <https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml>
  today; this is trunk, not the branch that shipped in macOS 26.6.2.
- MDN's browser-compat-data (`api/Window.json`, `main`) records Safari as
  `{"version_added": "preview", "flags": [{"type":"preference","name":"requestIdleCallback","value_to_set":"true"}]}`
  for both `requestIdleCallback` and `cancelIdleCallback`. **[asserted]** — raw JSON, not the rendered page; the MDN
  page itself renders its table client-side and `WebFetch` cannot see it. The page's Baseline banner reads "Limited
  availability — This feature is not Baseline because it does not work in some of the most widely-used browsers."
- The implementation bug, <https://bugs.webkit.org/show_bug.cgi?id=164193>, is RESOLVED FIXED. Enablement is a separate
  bug, <https://bugs.webkit.org/show_bug.cgi?id=285049> ("Re-enable requestIdleCallback on Apple ports"), which is
  **REOPENED**: enabled 2025-02-04, reverted 2025-02-13 over a page-load regression (bug 287681, google.com), and
  Ryosuke Niwa's 2025-06-03 comment reads "Unfortunately, this feature is in a bit of limbo given we observed a page
  load time regression on google.com." **[asserted]**
- **webkit.org/status is retired.** Fetching it returns "The WebKit Feature status page has been retired" and a pointer
  to MDN / Can I Use. **[measured]** The brief asks which of the three sources I reached: webkit.org/status — reached,
  useless; bugs.webkit.org — reached, quoted above; MDN — reached only via its raw compat data, not the rendered table.
- `scheduler.postTask` / `scheduler.yield`: BCD `api/Scheduler.json` has Safari `{"version_added": false}` for the
  interface and both methods. **[asserted]** Matches the probe. **[measured]**

### The fallback, and what it actually gives you

There is no idle signal in this engine. What exists is *ordering*, and the honest framing is that you can only choose
**which task** your work runs in, never that the engine is quiet:

- **`setTimeout(fn, n)`** — a task. Per HTML, the only clamp is nesting-based: "If *nestingLevel* is greater than 5, and
  *timeout* is less than 4, then set *timeout* to 4." **[asserted]** — <https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html>,
  timer initialization steps. A single non-nested `setTimeout(fn, 0)` is therefore not clamped to 4 ms.
- **`MessageChannel` `postMessage`** — a task with no clamp at any nesting depth. This is what React's own scheduler
  uses, and it is the closest thing to a vendor-blessed fallback in a browser with no `requestIdleCallback`: installed
  `node_modules/scheduler/cjs/scheduler.production.js:192-207` selects `setImmediate` if present, else `MessageChannel`,
  else `setTimeout(…, 0)`; `grep -c requestIdleCallback` over that file returns **0**. **[measured]** (scheduler 0.27.0.)
- **`requestAnimationFrame`** — a callback *before* the next rendering update, not idle time. Two nested rAFs put you
  after a paint; `src/paint.ts:434-435` already relies on exactly that double-rAF property.

None of these wait for quiet. Whatever you schedule runs at the head of the next task and blocks the main thread for its
full duration. For a ~55 ms module evaluation (§2) that is roughly three 60 Hz frames, and there is no way to split it —
module evaluation is one indivisible job. **The only lever is when, not how much.** **[asserted]**

Polyfills are not an answer here, and the brief is right that cross-browser stories are irrelevant: the common
`requestIdleCallback` shims degrade to exactly the `setTimeout` above while presenting an API that *claims* a deadline
it cannot compute. Prefer the honest primitive.

---

## 2. `modulepreload`: fetch + module map, never evaluation — and evaluation is where the cost is

### What the spec says, verbatim

HTML Standard §4.6.8.12, Link type "modulepreload" (<https://html.spec.whatwg.org/multipage/links.html#link-type-modulepreload>):

> The `modulepreload` keyword is a specialized alternative to the `preload` keyword, with a processing model geared
> toward preloading module scripts. In particular, it uses the specific fetch behavior for module scripts (including,
> e.g., a different interpretation of the `crossorigin` attribute), and places the result into the appropriate **module
> map for later evaluation**. In contrast, a similar external resource link using the `preload` keyword would place the
> result in the preload cache, without affecting the document's module map.

and, in the section's second example:

> The following code shows how `modulepreload` links can be used in conjunction with `import()` to ensure network
> fetching is done ahead of time, so that when `import()` is called, the module is already ready **(but not evaluated)**
> in the module map:

The processing model is "Fetch a modulepreload module script graph", and the MDN summary embedded in that same spec
section says "preemptively fetch a module script, **parse and compile it**, and store it in the document's module map
for later execution." **[asserted]** So: fetch — yes; parse (and, as a quality-of-implementation matter, compile) — yes;
**instantiate/link and evaluate — no.** Linking and evaluation happen at the first `import()`.

Two further spec details worth having: `<link rel=modulepreload>` "must not delay the load event", and fetching the
module's *dependencies* is explicitly optional ("implementations can take advantage of the fact that module scripts
declare their dependencies… This is intended as an optimization opportunity"), with the `load` event firing after the
named module only, not its graph. **[asserted]**

### WebKit implements it

- `document.createElement("link").relList.supports("modulepreload") === true` in this machine's WKWebView. **[measured]**
- Safari 17.0, "JavaScript and Web API": "Support for `<link rel="modulepreload">`."
  <https://webkit.org/blog/14445/webkit-features-in-safari-17-0/> **[asserted]**
- BCD `html/elements/link.json` → `link/rel/modulepreload`: Safari `17`. `as=script` also Safari 17; `as=json` Safari
  26.2; `as=style` not yet (`https://webkit.org/b/303761`). **[asserted]**

### Measured: what a preload hint is worth for *this* chunk

Real chunk, real bytes, in a fresh WKWebView per sample. Page loads `dist/assets/index-*.css`, has a `#root`, imports
the app entry chunk first (so the shared graph is already evaluated, as it is in the app), waits 600 ms, then times
`await import("/assets/MarkdownContent-WiAdncY7.js")`. Six samples per arm. **[measured]**

| arm | preload phase (ms) | `import()` (ms), 6 samples |
|---|---|---|
| cold — no hint | — | 57, 61, 60, 37, 37, 60 |
| `<link rel=modulepreload>` on the chunk **and both dep chunks**, +600 ms to settle | 8–10 | 60, 52, 56, 54, 57, 55 |
| warm — an earlier `import()` of the same chunk, +600 ms, then re-`import()` | warm import 61, 57, 40, 58, 42 | **0.0, 0.0, 0.0, 0.0, 0.0** |

Read it plainly: the preload hint bought nothing measurable (~55 ms median either way, and the cold arm's spread
overlaps it), while an early real `import()` made the second one free. The chunk's cost is **module evaluation**, and
`modulepreload` is defined not to do that.

Corroborating control, on a **synthetic** 286,248-byte module (2,000 small functions, no imports, trivial top-level) so
that parse/compile is isolated from evaluation, 10 samples per arm: cold `import()` ≈ 5–6 ms, after `modulepreload`
≈ 3–4 ms, after classic `rel=preload as=script` ≈ 4–6 ms. **[measured]** Two readings follow. First, JSC parses 286 KB
of JS in single-digit milliseconds (lazy function parsing), so **byte count is a bad proxy for cost** — the 286 KB
figure in `src/components/Markdown.tsx:37-45` is not itself the problem. Second, since the real chunk costs ~55 ms and a
same-sized synthetic costs ~5 ms, ~50 ms of the real chunk is **top-level evaluation of the markdown/highlighting
graph**, not parsing.

A ~40 ms bimodal artefact appeared in some synthetic-arm samples, landing in whichever phase happened to touch the
network first (it shows up in the *classic* `rel=preload` arm too, which does no parsing), so it is a loader/warm-up
artefact of the probe environment and not the mechanism. Reported rather than smoothed away.

### What Vite 7.3.6 already emits, and what it does not

The installed Vite is Rollup-based (`node_modules/vite/package.json` deps include `rollup`, installed 4.63.1; `grep -c
rolldownOptions` over `dist/node/chunks/config.js` returns **0**). **[measured]** Note that the *current* vite.dev docs
now describe `build.rollupOptions` as a deprecated alias of `build.rolldownOptions`; that is rolldown-vite and **does
not describe the version installed here**. Use the v7 docs (<https://v7.vite.dev/config/build-options>), where
`build.rollupOptions` is "Directly customize the underlying Rollup bundle."

- `build.modulePreload` defaults to `true` → normalised to `{ polyfill: true }`; installed default at
  `node_modules/vite/dist/node/chunks/config.js:33428`. **[measured]**
- **HTML-time `<link rel=modulepreload>` tags are emitted only for the entry chunk's transitive *static* imports.**
  `getImportedChunks` (config.js:24102-24116) recurses over `chunk.imports` — Rollup's static-import list — and
  `toPreloadTag` (24125-24132) turns those into head tags at 24183-24190. Dynamic imports are not in `chunk.imports`.
  **[measured, from installed source]** Consistent with the built output: `dist/index.html` contains **zero**
  `modulepreload` links. **[measured]**
- **Dynamic imports get their hints at call time, from the `__vitePreload` runtime helper** (`preload()`, config.js:
  23382-23434): it creates `<link rel=modulepreload as=script>` elements for the dep list, then calls `baseModule()`.
  Only CSS deps are awaited; JS links are fire-and-forget. The dep list is built by `addDeps` (23630-23655) starting
  from the target chunk itself, then its transitive static imports and CSS, and is emitted only when
  `deps.size > 1` (23661).
- For this app the built call is, verbatim from `dist/assets/App-*.js`:

  ```js
  const uR = u.lazy(() => $o(() => import("./MarkdownContent-WiAdncY7.js"), __vite__mapDeps([3,1,2,4,5])).then(…))
  ```

  with `__vite__mapDeps` resolving `[3,1,2,4,5]` to `MarkdownContent-*.js`, `index-yeoAvPsw.js` (the entry, already
  loaded), `index-*.css` (already a stylesheet in `<head>`, so skipped by the helper's dedupe), `theme-*.js` and
  `navigationApi-*.js`. **[measured]** So hints *are* already injected — but only at the instant of first transcript
  mount, which is precisely the moment they cannot help.
- The `vite/modulepreload-polyfill` is injected into the entry (config.js:24091) and appears in the entry chunk
  **[measured]**; its first line bails out when `relList.supports("modulepreload")` (config.js:23751), which is true
  here, so it costs one feature test.

**Conclusion for Q2:** adding a head-time `<link rel=modulepreload>` for this chunk — via `resolveDependencies`, a
`transformIndexHtml` plugin, or a hand-written tag — is a legitimate but nearly worthless change here. It would move
~8-10 ms of fetch off the critical path and leave the ~50 ms of evaluation exactly where it is.

---

## 3. Static import into the App chunk, and the 295 ms FCP gate

The mechanism question has a specific answer in this app, and it is not the intuitive one.

**FCP here does not depend on any JavaScript chunk.** `index.html` ships the `.boot-status` markup — an inline `<style>`,
an `<svg>` and a `<p>Opening Brigadier…</p>` — inside `#root` in the document body, and the only script in `<head>` is
`<script type="module" crossorigin src="/assets/index-*.js">`, which is deferred by definition of `type=module`. The
render-blocking resource is the `<link rel=stylesheet>` beside it, not the JS. **[asserted]** — read off
`index.html:1-35` and `dist/index.html`. The gate's number is the browser's own `first-contentful-paint`
`PerformanceEntry`, observed with `buffered: true` in `src/paint.ts:85-97` and differenced against Rust's `main()` stamp;
`scripts/measure-native-startup.py:2` calls the whole thing "pre-spawn -> WKWebView FCP".

Two consequences:

1. **Statically importing `MarkdownContent` into `App` would not delay FCP by mechanism.** `App` is itself a lazy chunk
   (`src/Launch.tsx:18`: `lazy(() => import("./App"))`), so a static import would fold 286 KB into `App-*.js`
   (1,068,452 B at the time of reading) and add its ~50 ms evaluation to `App`'s evaluation — which happens *after* the
   boot-status paint, on the Launch → App path. What it would regress is time-to-app-visible, not FCP.
2. **The same reasoning is what makes an unguarded warm-up dangerous.** A top-level `import()` in `main.tsx` runs in the
   deferred module script, and whether that lands before or after the first contentful paint is a race this research did
   **not** resolve. Fifty milliseconds landing on the wrong side of a 239.55 ms → 295 ms budget is a 20% margin gone. Do
   not schedule the warm-up from module scope; schedule it from a signal that FCP has already happened (§5).

`manualChunks` remains available in the installed toolchain — `node_modules/rollup/dist/rollup.d.ts:853` still declares
`manualChunks?: ManualChunksOption` on output options **[measured]** — but it is the wrong tool for this problem. It
changes *which file* code lands in; the cost measured in §2 is evaluation, which is invariant to the file boundary. The
only thing `manualChunks` could buy is splitting `MarkdownContent`'s ~50 ms into two chunks that evaluate at two
different times, which is a much larger change than warming one import and is not justified by anything measured here.

---

## 4. WebKit-specific hazards when scheduling work after load

Sourced:

- **A `setTimeout`- or `MessageChannel`-deferred `import()` runs in a normal task and will block the main thread for its
  whole duration.** 55 ms is ~3.3 frames at 60 Hz. If the warm-up fires while the Launch cinematic
  (`src/Launch.tsx`, `src/intro.css`) is still animating, it converts a first-mount stall into a launch-animation stall.
  **[measured]** for the 55 ms; **[asserted]** for the frame arithmetic.
- **Idle scheduling and page load genuinely interact in WebKit** — that is the stated reason `requestIdleCallback` is
  still off: a page-load-time regression on google.com (bug 285049, comment of 2025-06-03). It is weak evidence about
  *this* app, but it is the only WebKit-sourced statement I found tying idle-time work to load performance.
  **[asserted]**
- **Hidden pages get their DOM timers throttled on Cocoa by default.** `UnifiedWebPreferences.yaml:2690-2700`:
  `HiddenPageDOMTimerThrottlingEnabled`, `defaultValue: WebKit: "PLATFORM(COCOA) || PLATFORM(GTK)": true`; and
  `HiddenPageCSSAnimationSuspensionEnabled:2673-2681` is likewise true on Cocoa. **[asserted]** This matters because
  `src-tauri/tauri.conf.json` creates the window with `"visible": false` and `src-tauri/src/launch.rs:63`
  (`window.show()`) is what reveals it. A warm-up hung on `requestAnimationFrame` will not fire while the page is
  hidden or the window occluded; one hung on `setTimeout` may be delayed. Belt and braces: use a timer *and* accept that
  it may run late, rather than a rAF alone.
- **The fetch itself does not contend with the WebContent main thread in this app.** Tauri serves `frontendDist` assets
  from `crate::async_runtime::spawn` (`~/.cargo/registry/…/tauri-2.11.5/src/protocol/tauri.rs:98-111`), and wry's
  `WKURLSchemeHandler` calls `didReceiveResponse`/`didReceiveData`/`didFinish` from that responder closure
  (`…/wry-0.55.1/src/wkwebview/class/url_scheme_handler.rs:186-300`), off the UI thread. **[asserted, from installed
  crate source]** So the ~8-10 ms fetch is cheap and parallel; the ~50 ms evaluation is not.

Not sourced, and stated as such: **I found no WebKit primary source saying that WebKit deprioritises or defers fetches
issued during page load**, nor any WebKit setting analogous to a "defer async scripts until after first paint" switch —
I grepped the full `UnifiedWebPreferences.yaml` (220 KB) and `Source/WebCore/page/Settings.yaml` for `defer` and found
only `NeedsDeferKeyDownAndKeyPressTimersUntilNextEditingCommandQuirk`. **[measured]** That is absence of evidence in two
files, not proof the behaviour does not exist elsewhere in the engine.

---

## 5. Recommendation

Warm the module by **importing it**, gated on a real post-paint signal, from a place that already exists.

1. **Fire the same `import()` the `lazy()` uses**, so both resolve to one module-map entry:
   `import("./MarkdownContent")` from `src/components/Markdown.tsx`. A second `import()` of the same specifier costs
   **0.0 ms** (§2), so the `lazy()` boundary keeps working unchanged and its `Suspense` fallback simply stops being
   reached. Swallow the rejection — a failed warm-up must not surface as an unhandled rejection; the real
   `lazy()` retains the error path.
2. **Gate it on FCP, not on module scope.** `src/paint.ts` already owns a `first-contentful-paint` observer with
   `buffered: true` that fires exactly once (`sendFcp`). That callback is the correct trigger, and using it makes the
   295 ms gate safe *by construction* rather than by hoping the race falls the right way.
3. **Then push it out one more beat**, so the ~55 ms lands in a frame nobody is watching: two nested
   `requestAnimationFrame` calls (the pattern `paint.ts:434-435` already uses) followed by a `setTimeout(fn, N)`.
   Choose `N` so the warm-up lands after the Launch cinematic settles rather than during it; the honest way to pick it
   is to try one value and read the burn, not to reason about it. `MessageChannel` is available if a clamp ever matters,
   but a single non-nested `setTimeout` is not clamped (§1) and is simpler.
4. **Do not add a `modulepreload` hint** — neither by hand in `index.html` nor via `build.modulePreload.
   resolveDependencies`. Measured worth for this chunk: nothing outside noise (§2). It would also drift silently the
   next time the chunk's hash changes.
5. **Do not fold it into the App chunk** and do not reach for `manualChunks`. Both relocate bytes; neither removes the
   evaluation, which is the cost (§3).
6. **Verify with the burn, not with reasoning.** Two numbers decide it: exec → FCP must stay at or under its current
   239.55 ms p50 against the 295 ms gate, and the first transcript mount's two missed frames (27 ms, 33 ms) must
   disappear. If the missed frames survive, the 286 KB chunk was not the cause and this note's §2 numbers say where to
   look next — ~50 ms of it is markdown/highlighting top-level evaluation, so a smaller markdown graph, not a
   better-scheduled one, becomes the question.

---

## 6. What I did not verify

- **I did not run the app, build it, or run the burn.** Every number here comes from a standalone WKWebView probe
  against a copy of `dist/`, served over `http://127.0.0.1`, not over Tauri's custom protocol. Custom-protocol fetch
  latency, the app's real module graph state at first transcript mount, and JSC's disk bytecode cache across real
  launches are all unmeasured; the last of these could make the app's cold cost lower than the ~55 ms measured here.
- **I did not confirm the shipped WebKit's `requestIdleCallback` default from the framework binary.** The probe proves
  the API is absent from a default `WKWebViewConfiguration` on this machine **[measured]**, which is what matters; the
  `defaultValue: false` line is from WebKit *trunk*, not from the branch in macOS 26.6.2.
- **I did not test enabling the preference.** WebKit exposes `RequestIdleCallbackEnabled` as a `status: testable`
  preference; whether wry/Tauri can set it, and whether doing so is wise given bug 285049, is untested and unresearched.
- **I did not establish whether FCP in the real app happens before or after the entry module evaluates.** §3 argues from
  the deferred-module-script rule that it should be independent of JS; the app's own trace stream (`trace:dcl`, the
  `fcp` line) can settle it and I did not read one.
- **The synthetic 286 KB control is not MarkdownContent.** It bounds parse/compile cost for that byte count in JSC; it
  says nothing about which of MarkdownContent's dependencies dominate its ~50 ms of evaluation. Nobody has profiled
  inside that chunk.
- **`import()` of the real chunk in my probe evaluated the app entry first**, so the app entry's own side effects ran in
  a page that is not the app. `errs` came back empty in all 12 samples, but this is not the app's real state.
- **I did not check whether a warm-up interacts with React 19 StrictMode's double-invocation** or with the
  `profiling` branch in `src/components/Markdown.tsx:37-45`.
- **I reached webkit.org/status, bugs.webkit.org and MDN**; I could not read MDN's rendered compatibility tables (they
  are client-rendered) and used the browser-compat-data JSON on `main` instead. Those two can differ from what MDN
  displays.
