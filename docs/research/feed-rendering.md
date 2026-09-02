# Feed rendering: virtualized terse rows, rAF ingestion, and honest FPS in WKWebView

Date: 2026-09-02. Scope: the UI half of the feed — which virtualizer, how bytes coming off a
`tauri::ipc::Channel` become React state, and how to measure 60 fps in a WKWebView without lying.

Assumes `tauri-runtime.md` §3–§4 (Channel semantics, the 8192-byte `eval` threshold, "`onmessage`
must do nothing but push into a buffer") and `substrate.md` (the DOM is the wall; coalesce per
frame; virtualize). Nothing here repeats those.

Tags: **[docs]** vendor documentation · **[source]** read in the shipped package/compat data ·
**[measured]** run on this machine today · **[asserted]** reasoned, not verified.

## Versions verified

| Thing | Version | Published | How |
|---|---|---|---|
| `@tanstack/react-virtual` | **3.14.10** | 2026-08-18 | `npm view` **[source]** |
| `@tanstack/virtual-core` (its only dep) | **3.17.8** | — | pinned exactly in `react-virtual`'s `package.json` **[source]** |
| `react-window` | **2.3.0** | 2026-07-20 | `npm view` **[source]** |
| `react-virtuoso` | **4.18.12** | 2026-08-17 | `npm view` **[source]** |
| `react` / `react-dom` (this repo) | `^19.1.0` | — | `package.json` **[source]** |
| macOS / Safari / WebKit | 26.5.2 (25F84) / 26.5.2 / 21624.2.5.11.8 | — | `sw_vers`, `Info.plist` **[measured]** |
| Display | Built-in Liquid Retina XDR, Apple M4 Pro | — | `system_profiler SPDisplaysDataType` **[measured]** |
| `caniuse-db` / MDN `browser-compat-data` | `@latest` / `main` as of today | — | jsDelivr, raw.githubusercontent **[source]** |

All three libraries are **MIT** (`npm view <pkg> license`) **[source]**. All three are maintained:
every one shipped a release within the last three weeks **[source]**.

Bundle sizes below were produced here by minifying each package's published ESM entry with this
repo's own esbuild (`node_modules/.bin/esbuild --minify --format=esm`) and gzipping at `-9`. They
are **whole-package** figures before tree-shaking, not what Vite will actually emit. **[measured]**

| Package | minified | min+gzip |
|---|---|---|
| `@tanstack/react-virtual` + `@tanstack/virtual-core` | 24,603 B | **7,577 B** |
| `react-window` | 12,631 B | **4,613 B** |
| `react-virtuoso` | 60,755 B | **20,152 B** |

---

## 1. Virtualization options for React 19

### Summary

| | `@tanstack/react-virtual` 3.14.10 | `react-window` 2.3.0 | `react-virtuoso` 4.18.12 |
|---|---|---|---|
| React 19 in `peerDependencies` | `^16.8 \|\| ^17 \|\| ^18 \|\| ^19` **[source]** | `^18 \|\| ^19` **[source]** | `>=16 \|\| >=17 \|\| >=18 \|\| >=19` **[source]** |
| min+gzip | 7.6 KB | 4.6 KB | 20.2 KB |
| Shape | headless hook, you write the DOM | component, you write the row | component, opaque DOM |
| Fixed height | `estimateSize: () => H` and never call `measureElement` | `rowHeight={H}` | `fixedItemHeight={H}` |
| Tail-follow, native | **yes** — `anchorTo: 'end'` + `followOnAppend` **[source]** | no | **yes** — `followOutput` **[source]** |
| "Unless the user scrolled up", native | **yes**, gated on `isAtEnd()` **[source]** | no | **yes**, documented **[docs]** |
| Head-drop (ring cap) anchoring | **yes** — key-based anchor on edge-key change **[source]** | no | `firstItemIndex` (prepend only) **[source]** |

### `@tanstack/react-virtual` 3.14.10 — API as shipped

Read from `dist/esm/index.d.ts` of the published tarballs, not from the docs site. **[source]**

`useVirtualizer(options)` returns a `Virtualizer` augmented with `containerRef`. `VirtualizerOptions`
(from `@tanstack/virtual-core` 3.17.8) is exactly:

```
count, getScrollElement, estimateSize, scrollToFn, observeElementRect, observeElementOffset,
debug?, initialRect?, onChange?, measureElement?, overscan?, horizontal?, paddingStart?,
paddingEnd?, scrollPaddingStart?, scrollPaddingEnd?, initialOffset?, getItemKey?,
rangeExtractor?, scrollMargin?, gap?, indexAttribute?, initialMeasurementsCache?, lanes?,
anchorTo?, followOnAppend?, scrollEndThreshold?, isScrollingResetDelay?, useScrollendEvent?,
enabled?, isRtl?, useAnimationFrameWithResizeObserver?, laneAssignmentMode?, useCachedMeasurements?
```

The React wrapper adds three more: `useFlushSync?` (**default `true`**), `directDomUpdates?`
(default `false`), `directDomUpdatesMode?: 'position' | 'transform'` (default `'transform'`).
**[source]**

Instance surface used by a log tail: `getVirtualItems()`, `getTotalSize()`, `scrollToIndex()`,
`scrollToOffset()`, `scrollToEnd({behavior})`, `scrollBy()`, `getDistanceFromEnd()`,
`isAtEnd(threshold?)`, `measure()`, `takeSnapshot()`. `VirtualItem` is
`{ key, index, start, end, size, lane }`. **[source]**

**The tail-follow is real and it is conditional.** In `setOptions`, when `anchorTo === 'end'` and
the item count grew and the last key changed, it sets `followOnAppend` **only if**
`this.isAtEnd(prevOptions.scrollEndThreshold)` was true *before* the append:

```js
const behavior = merged.followOnAppend === true ? "auto" : merged.followOnAppend || null;
if (behavior && nextCount > prevCount && this.isAtEnd(prevOptions.scrollEndThreshold) &&
    (prevCount === 0 || merged.getItemKey(nextCount - 1) !== prevLastKey)) {
  followOnAppend = behavior;
}
```

`dist/esm/index.js:304-306` **[source]**. `isAtEnd` is
`getMaxScrollOffset() - getScrollOffset() <= threshold`, and `scrollEndThreshold` defaults to `1`
px (`index.js:273`, `:955`) **[source]**. That is precisely "stick to bottom unless the user
scrolled up", with no `atBottom` state of your own. Raise `scrollEndThreshold` to ~24 px so a
half-pixel of scroll does not detach the tail. **[asserted]**

**`anchorTo: 'end'` also solves the ring cap.** When the *first* key changes — which is what
happens when the 501st row pushes row 1 out — the same code path captures the item at the current
scroll offset and its intra-item delta, then re-resolves the offset against the new measurements
and writes `scrollOffset` before paint (`index.js:290-337`, `:485-502`) **[source]**. Without
that, dropping rows off the head shifts everything under the reader's cursor. WebKit will not save
you here: it has no scroll anchoring (§5).

**`directDomUpdates: true` is the option that matters for our load.** With it on, the virtualizer
writes item `transform`/`top` and the container height straight to the DOM in `onChange`, and
re-renders React **only when the visible index range or `isScrolling` changes**
(`react-virtual/dist/esm/index.js:60-88`, `flushSync(rerender)` at `:79`) **[source]**. That also defuses the default
`useFlushSync: true`, which otherwise calls `flushSync(rerender)` on every synchronous scroll
notification — and React's own docs say `flushSync` "can significantly hurt performance… Use
`flushSync` as last resort" **[docs]** react.dev/reference/react-dom/flushSync.

Its documented requirements when enabled: items must be `position: absolute` (plus `top: 0;
left: 0` in `'transform'` mode), items must not set the main-axis position themselves, the inner
sizer must take `virtualizer.containerRef` and must not set `height`, and the flag is
"intended to be set once at mount" — toggling it at runtime leaves stale inline styles.
**[source]** (`index.d.ts` doc comments).

### `react-window` 2.3.0 — v2 is out and the v1 API is gone

`react-window` is on **2.x**; v1 docs were moved to a separate site
(`react-window-v1.vercel.app`), which the README states explicitly **[source]**. The v1
`FixedSizeList` / `VariableSizeList` / `width` / `height` / `itemCount` / `itemSize` surface no
longer exists. v2 exports:

```ts
function List<RowProps, TagName = "div">(props: ListProps<RowProps, TagName>): ReactElement
// required: rowComponent, rowCount, rowHeight, rowProps
// optional: defaultHeight, listRef, onResize, onRowsRendered, overscanCount, rowKey, tagName…
// rowHeight: number | string | ((index, cellProps) => number) | DynamicRowHeight
interface ListImperativeAPI { element; scrollToRow({align, behavior, index}) }
const useListRef: typeof useRef<ListImperativeAPI>
function useDynamicRowHeight({ defaultRowHeight, key })
```

`dist/react-window.d.ts:313-507` **[source]**. The list sizes itself to its parent (there is no
`height` prop, only `defaultHeight` "for initial render… important for server rendering") and
`Grid`/`List` position rows with `position: absolute` + `transform: translateY(...)`
(`dist/react-window.js:840-842`) **[source]**.

React 19 is in `peerDependencies` (`^18.0.0 || ^19.0.0`) **[source]**.

**No tail-following.** The only scroll control is the imperative `scrollToRow`. "Stick to bottom
unless scrolled up" is yours to write: track `scrollTop + clientHeight >= scrollHeight - ε` on the
outer element (reachable via `listRef.current.element`) and call `scrollToRow` after each commit.
Nothing in the type surface anchors scroll when rows are removed from the head, so the ring cap is
also yours. **[source]** (absence)

### `react-virtuoso` 4.18.12 — the one built for a log tail

`followOutput?: FollowOutput` where `FollowOutput = FollowOutputCallback | 'auto' | 'smooth' |
boolean` and `FollowOutputCallback = (isAtBottom: boolean) => FollowOutputScalarType`
(`dist/index.d.ts:206-216`) **[source]**. The doc comment is unambiguous:

> If set to `true`, the list automatically scrolls to bottom if the total count is changed.
> Set to `"smooth"` for an animated scrolling. **By default, `followOutput` scrolls down only if
> the list is already at the bottom.**

`dist/index.d.ts:1206-1223` **[docs]**. Companions: `atBottomStateChange?: (atBottom: boolean)`,
`atBottomThreshold?: number` ("By default `4`"), `alignToBottom?: boolean`, `increaseViewportBy`
(its `overscan`), and `fixedItemHeight?: number` — "Can be used to improve performance if the
rendered items are of known size. Setting it causes the component to skip item measurements."
**[source]**

It is the only one of the three whose stick-to-bottom you get by typing one prop. It is also 2.7×
the gzip of TanStack and hands you an opaque DOM you cannot instrument or style around.

### The hand-rolled option

For genuinely fixed-height rows the arithmetic is trivial and correct:

```
first = Math.floor(scrollTop / H) - overscan
last  = Math.min(n, Math.ceil((scrollTop + clientHeight) / H) + overscan)
// sizer: height = n * H;  row i: position:absolute; top:0; transform: translateY(i*H - dropped*H)
```

For fixed heights it is reasonable and it is what the libraries reduce to. What you take on:

1. **No scroll anchoring in WebKit.** `overflow-anchor` is `n` for Safari through 26.6 and 27, `y`
   only in Safari Technology Preview (`caniuse-db/features-json/css-overflow-anchor.json`)
   **[source]**; MDN BCD lists `safari: 27` **[source]**. The two disagree on the exact release;
   they agree it is **not available in Safari/WebKit 26.5**, which is what this machine runs. So
   the browser will not hold the reader's position for you when the ring drops rows off the head —
   you must adjust `scrollTop` yourself, before paint, in a layout effect. This is the single
   biggest reason not to hand-roll here.
2. **Resize.** No `height` prop means a `ResizeObserver` on the scroller, and a re-derived window
   on every resize.
3. **Sub-pixel `H`.** `devicePixelRatio` is 2 on this display; a row height that is not an integer
   CSS pixel makes `n * H` and `i * H` disagree with what the compositor rounds to, and rows drift
   against the sizer. Pin `H` to an integer. **[asserted]**
4. **Scroll events fire off the rAF cadence.** WebKit dispatches `scroll` during the rendering
   update, so recomputing the window in the scroll handler is fine — but committing React state
   there re-enters render synchronously. Route it through the same rAF drain as ingestion. **[asserted]**
5. **`scrollend`** now exists in Safari 26.2+ (`api.Element.scrollend_event`, BCD) **[source]**, so
   "the user stopped scrolling" is cheap — but that is also what TanStack's `useScrollendEvent`
   option already wraps.

None of this is hard. It is ~120 lines you own, debug and re-derive, to save 7.6 KB gzip — and item
(1) is a correctness bug, not a polish item.

---

## 2. Ingestion: Channel → buffer → one rAF drain → one commit

The pattern in `tauri-runtime.md` §4 is confirmed and it is the right one: `Channel.onmessage` runs
synchronously inside the eval'd script on the main JS thread (`@tauri-apps/api/core.js:82-115`), so
it must only append to a module-level array. **[source]**

```
Rust: Channel::send(batch)  →  eval  →  TS Channel dispatch  →  onmessage(batch)
onmessage: BUF.push(...batch.rows)            // no React, no sort, no format
rAF loop:  if (BUF.length) { store.append(BUF.splice(0)); }   // once per frame, one commit
```

**React 19 automatic batching is not in question, and it is not sufficient by itself.** React's own
release note is explicit that since 18, "updates inside of timeouts, promises, native event
handlers or any other event are batched" — before 18, only React event handlers were **[docs]**
react.dev/blog/2022/03/29/react-v18. A `Channel.onmessage` call is "any other event", so ten
`setRows` calls in one task collapse to one render. What batching does *not* do is collapse **ten
separate tasks** — ten channel messages arriving as ten separate eval'd scripts in one frame are
ten tasks, hence ten renders. Ten concurrent sessions is exactly that shape. The rAF drain is what
turns 10 sessions × N messages into one commit per frame; batching only saves you within a task.
**[docs]** + **[asserted]**

### `useSyncExternalStore` vs `useState`

`useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot?)`; `getSnapshot` must return a
value stable under `Object.is` while the store has not changed, and the snapshot must be immutable
— "If the underlying store has mutable data, return a new immutable snapshot if the data has
changed. Otherwise, return a cached last snapshot." **[docs]**
react.dev/reference/react/useSyncExternalStore.

Two caveats that decide the design:

- "If a different `subscribe` function is passed during a re-render, React will re-subscribe…
  You can prevent this by declaring `subscribe` outside the component." **[docs]** — so the store
  is a module singleton, not a hook-local closure.
- "If the store is mutated during a non-blocking Transition update, React will fall back to
  performing that update as blocking. Specifically, for every Transition update, React will call
  `getSnapshot` a second time just before applying changes to the DOM. If it returns a different
  value than when it was called originally, React will restart the update from scratch." **[docs]**
  A feed that mutates 60 times a second and is read inside a `startTransition` will restart
  transitions constantly. Keep the feed out of transitions.

Verdict: **`useSyncExternalStore` over a versioned module store.** Not because it renders faster
than `useState` — with a once-per-frame commit they cost the same — but because:

- The buffer already lives outside React (it must; `onmessage` is not a React event). A
  `useState` setter forces a second copy of the same data inside React and a `setState` call per
  subscribing component; `useSyncExternalStore` lets N panes read one array through N cheap
  `getSnapshot` calls.
- `getSnapshot` returning a **cached** value is the natural fit for a ring buffer: bump an integer
  `version` and swap in a new frozen array once per frame; every unchanged pane's `getSnapshot`
  returns the identical reference and does not re-render.
- Per-session selectors fall out for free — `getSnapshot` can be `() => store.sessions[id]`, so a
  burst on session 7 does not touch panes 1–6.

Concrete shape (`subscribe` declared at module scope, snapshot swapped once per frame):

```ts
// feed-store.ts — module scope, no React
let BUF: Row[] = [];
const snap = new Map<SessionId, readonly Row[]>();   // frozen arrays, one per session
const listeners = new Set<() => void>();
export const subscribe = (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); };
export const getSnapshot = (id: SessionId) => snap.get(id) ?? EMPTY;

function drain() {                  // exactly one rAF loop for the whole app
  if (BUF.length) {
    for (const [id, rows] of groupBySession(BUF)) {
      const next = capRing([...(snap.get(id) ?? EMPTY), ...rows], UI_CAP);
      snap.set(id, next);           // new reference only for touched sessions
    }
    BUF.length = 0;
    for (const cb of listeners) cb();
  }
  requestAnimationFrame(drain);
}
```

One rAF loop for the whole window, not one per session: N rAF callbacks in a frame all receive the
same timestamp and all run in the same rendering update anyway **[docs]** (MDN,
`Window.requestAnimationFrame`), and a single loop is the only place you can enforce a global
budget.

**Do not use `flushSync` anywhere in this path** — react.dev calls it a last resort that "can
significantly hurt the performance of your app" **[docs]**. This is also why `directDomUpdates:
true` matters if TanStack is chosen: it is what stops the default `useFlushSync: true` from firing
on every scroll notification (§1).

---

## 3. Measuring frame rate inside WKWebView

### (a) In-page instrumentation — what actually exists in WebKit 26.5

| API | Safari/WebKit | Chrome | Source |
|---|---|---|---|
| `PerformanceObserver` | 11 | 52 | BCD `api.PerformanceObserver` **[source]** |
| `PerformanceObserver.supportedEntryTypes` | 13 | 73 | BCD **[source]** |
| `longtask` (`PerformanceLongTaskTiming`) | **no** | 58 | BCD `api.PerformanceLongTaskTiming` **[source]** |
| `long-animation-frame` (`PerformanceLongAnimationFrameTiming`) | **no** | 123 | BCD **[source]** |
| `event` (`PerformanceEventTiming`, INP) | **26.2** | 76 | BCD **[source]** |
| `Element` `scrollend` | **26.2** | 114 | BCD **[source]** |

MDN also flags LoAF as "not Baseline because it does not work in some of the most widely-used
browsers" **[docs]**.

**So the two APIs everyone reaches for to find jank — `longtask` and `long-animation-frame` — do
not exist in our runtime.** There is no `blockingDuration`, no `scripts` attribution, no
`renderStart`. Everything must be derived from `requestAnimationFrame` timestamps and
`performance.now()`. `performance.mark`/`measure` still work and still show up in Web Inspector's
timeline, but they measure your code, not the frame.

Resolution is adequate. `performance.now()` is coarsened to 100 µs in non-cross-origin-isolated
contexts (5 µs when isolated) **[docs]** MDN `Performance.now`. The **rAF timestamp argument** is
coarser — MDN: "a decimal number, in milliseconds, but with a minimal precision of 1 millisecond"
**[docs]** — so take deltas from `performance.now()` read at the top of the callback, not from the
`timestamp` argument, if you want sub-millisecond frame times.

### (b) Web Inspector on a Tauri window

Tauri's debug docs: right-click → **Inspect Element**, or **⌘⌥I**; "The inspector on macOS uses
Safari's inspector"; "the inspector is only enabled in development and debug builds"; enabling it
in a production build requires the `devtools` Cargo feature, and "The devtools API is private on
macOS. Using private APIs on macOS prevents your application from being accepted to the App Store."
Programmatic control is `WebviewWindow::open_devtools` / `close_devtools`. **[docs]**
v2.tauri.app/develop/debug/

Practical consequence: **Web Inspector's Timelines panel is a dev-loop tool only.** The
build-breaking regression gate cannot depend on a human reading a flame chart; it has to be the
in-app meter from (c), which ships in every build.

### (c) Does WKWebView cap rAF at 60 Hz, and how not to misread 120 Hz

This machine has a Liquid Retina XDR (ProMotion, 120 Hz) panel **[measured]**. Two facts collide:

- WebKit's own explainer states that on Apple 120 Hz devices, accelerated animations run at 120 Hz
  but "script-driven animations using `requestAnimationFrame()` as well as all non-accelerated Web
  Animations" update at **60 Hz**, a deliberate choice made for power and web-compat reasons.
  **[docs]** github.com/WebKit/explainers/tree/main/animation-frame-rate
- WebKit bug 173434 ("Support for 120Hz requestAnimationFrame") is **still open**, with 2025
  comments reporting 120 fps achieved on some configurations once the "Prefer Page Rendering
  Updates near 60fps" setting is turned off, and that setting defaulting **on**. **[source]**
- The knob is the internal `PreferPageRenderingUpdatesNear60FPSEnabled` WebKit preference, only
  reachable through the private `_features` / `_setEnabled:forFeature:` API. A third-party Tauri
  plugin (`tauri-plugin-macos-fps` 0.1) exists solely to flip it, and its README claims the cap
  applies on macOS 13–15 and that macOS 26+ removed it. **[asserted]** — that is a README, not
  Apple documentation, and it is the weakest claim in this file.

Net: **the rAF cadence in our WKWebView is 60 Hz or 120 Hz depending on OS version and a
preference we do not control, and we must not hardcode 16.67 ms.** A meter that assumes 60 Hz on a
window running at 120 Hz reports every frame as "half a frame late" and shows ~50% dropped frames
on a perfectly healthy app. Do not enable the private-API plugin: a 120 Hz feed halves the per-frame
budget for zero user benefit on a log tail. **[asserted]**

- **[measured]** In a real WKWebView 10-session burn, the per-window `hz` field came out as 70 and
  80 Hz in several windows, because `hz` was rounded to the nearest multiple of 10
  (`Math.round(1000 / period / 10) * 10`) instead of snapped to a real cadence; a 70 Hz bucket set
  the budget to 1000/70 ≈ 14.3 ms and flagged healthy 18 ms frames as failures. Fix: `derivePeriod`
  now snaps *every* path — p10 as well as the p50 fallback — to the nearest real cadence
  (`snapToCadence`, 120/60/30 Hz) before returning the period, and `hz` in `report` is
  `Math.round(1000 / period)` off that already-snapped period, so `hz` can only ever be 120, 60 or
  30 (`src/fps.ts`).

### Recommended in-app FPS meter

Derive the target cadence, never assume it. One module, one rAF loop shared with the ingestion
drain (§2), a ring of 240 frame times, a report every second.

```ts
// fps.ts — same rAF loop as the feed drain; the drain runs first, then this samples.
const times = new Float64Array(240); let i = 0, n = 0;
let last = performance.now(), acc: number[] = [];

export function sampleFrame() {
  const now = performance.now();
  const dt = now - last; last = now;
  times[i = (i + 1) % 240] = dt; if (n < 240) n++;
  acc.push(dt);
  if (acc.length >= 60) report();
}

function report() {
  const s = acc.slice().sort((a, b) => a - b); const N = s.length;
  // Cadence, measured: the 10th percentile frame time is the display's true period,
  // because a frame can be late but never early. 8.33 -> 120 Hz, 16.67 -> 60 Hz.
  const period = s[Math.floor(N * 0.10)];
  const hz = Math.round(1000 / period / 10) * 10;
  const budget = 1000 / hz;
  const dropped = s.reduce((k, dt) => k + Math.max(0, Math.round(dt / budget) - 1), 0);
  const m = {
    hz,
    frames: N,
    dropped,
    p50_frame_ms: +s[(N * 0.50) | 0].toFixed(2),
    p95_frame_ms: +s[(N * 0.95) | 0].toFixed(2),
    p99_frame_ms: +s[(N * 0.99) | 0].toFixed(2),
    worst_ms: +s[N - 1].toFixed(2),
  };
  acc = [];
  if (import.meta.env.DEV) console.debug("fps", m);
  void invoke("record_frame_stats", { m });   // fire-and-forget; Rust writes NDJSON
}
```

Cost per frame: one `performance.now()`, one array push, one modulo store — sub-microsecond, and
the once-a-second sort is over ~60–120 numbers. Cheap enough to leave on in dev builds
permanently; gate the `invoke` (not the sampling) behind a flag in release. **[asserted]**

Three details that keep it honest:

- **`dropped` counts missed vsyncs, not "frames under 60".** `round(dt/budget) - 1` charges a
  33 ms frame as one drop and a 50 ms frame as two.
- **Report `hz` alongside.** A run that reports `hz: 120, p95: 9.1 ms` is healthier than one
  reporting `hz: 60, p95: 16.4 ms`, and a naive fps number cannot tell them apart.
- **Guard the p10 against sub-multiples.** **[measured]** 2026-09-02, Chrome for Testing 152: three
  windows of one run derived `hz: 120` because ≥10% of their frames arrived near 8.3 ms while `p50`
  stayed at 16.6 ms. p10 had landed on half the real period, which halved the budget and charged 43
  dropped vsyncs that never happened. So p10 is believed only when it agrees with the median —
  `period = p10 if |p10 − p50| ≤ 0.2 × p50 else snap(p50)`, where `snap` picks the nearest of
  8.33 / 16.67 / 33.3 ms (and 16.67 for anything slower than ~24 Hz, which is a stalling app on a
  60 Hz panel, not a display cadence). `derivePeriod` in `src/fps.ts`, with the source of the
  cadence reported as `hz_source`.
- **rAF is paused, not slowed, when the document is hidden** — MDN: "`requestAnimationFrame()`
  calls are paused in most browsers when running in background tabs or hidden `<iframe>`s"
  **[docs]**. An occluded or minimized Tauri window therefore produces one enormous `dt`, not a
  low frame rate. Discard any sample where `dt > 1000` and reset, or the burn result is garbage
  the first time someone ⌘-tabs away.

---

## 4. The 10-agent burn harness

### Shape

A `#[tauri::command]` that replays the existing NDJSON fixtures at a chosen rate across N synthetic
sessions, feeding the **real** `Channel` path — same `Envelope`, same batching, same
`Channel::send` — with no `claude` process anywhere:

```rust
#[tauri::command]
async fn burn(
    sessions: usize,        // 10
    rows_per_sec: f64,      // per session
    duration_s: u64,        // 60
    fixture: String,        // "s1-handshake-and-turn"
    on_event: tauri::ipc::Channel<FeedBatch>,
) -> Result<(), String>
```

Fixtures already present: `crates/claude-spike/fixtures/s1-handshake-and-turn.ndjson` through
`s7-kill.ndjson` (7 scenarios, plus `.sent.ndjson` and `.stderr.txt` siblings) **[source]**. The
replay parses each line once at startup into `Vec<Envelope>` — via the same adapter code, so the
harness exercises the real translation — then cycles the vector, stamping fresh `seq`, `at` and a
synthetic `session_id` per fake session. One `tokio::time::interval` per session at
`1.0/rows_per_sec`, one per-frame flusher at 16 ms that drains all sessions' pending rows into
sub-8 KB `Channel` messages.

Why this and not a real `claude`: ten real sessions cost ten API bills, are not reproducible, and
their event rate is not a dial. `substrate.md` already measured that spawning, reading and parsing
10 concurrent NDJSON streams is 0.34% of a core — the process side is not what is under test. What
is under test is the Channel→rAF→React→DOM path. **[source]** + **[asserted]**

### Batch size: how many rows fit under 8192 bytes

`tauri-runtime.md` §3 is the constraint: JSON payloads under 8192 bytes take the `eval` fast path;
one oversized message detours through `fetch` and **head-of-line blocks every later message** in
the TS `pendingMessages` array. Measured by serializing representative payloads today
(`json.dumps(..., separators=(',',':'))`, ASCII line body; `FEED_LINE_LIMIT = 200` is a **byte**
cap in `crates/store/src/feed.rs:24`, and `bounded()` cuts on a UTF-8 boundary, so byte length ≈
character count for our `·`-joined lines): **[measured]**

| Wire shape | 200-byte line | rows / 8192 B | 60-byte line | rows / 8192 B |
|---|---|---|---|---|
| Full `Envelope` (`ItemCompleted`, 26-char ULIDs) | 428 B | 19 | 288 B | 28 |
| `FeedRow` verbose keys (`session_id`/`seq`/`at`/`line`) | 285 B | 28 | 145 B | 56 |
| `FeedRow` short keys, `session_id` hoisted to the batch | 237 B | 34 | 97 B | 83 |

Batch wrapper (`{"session_id":"<ULID>","rows":[…]}`) costs 53 B. `FeedRow` today is
`{ session_id, seq, at, line }` and derives only `Clone, Debug, PartialEq, Eq` —
`crates/store/src/schema.rs:272-282` **[source]** — so a `Serialize` wire twin has to be written
either way; make it short-keyed while you are there.

**Cap the batch at 24 rows and re-check `serialized.len() < 8000` before every `send`, splitting on
overflow.** 24 × (237 + 1) + 53 = 5,765 B — a full frame of worst-case 200-byte lines with ~30%
headroom for multi-byte UTF-8 in tool names and paths. At 60 fps that ceiling is 1,440 rows/s per
channel, far above the plan's "tens of rows per second per session × 10". The check must be on the
actual serialized length, not the row count: the table is ASCII arithmetic and a CJK path blows it.
**[measured]** + **[asserted]**

### What must be measured to claim "60 fps"

Not an average. An average of 60 fps is what you get when 59 frames run at 4 ms and one runs at
1 second.

Report, per 1-second window, for a 60-second burn at 10 sessions:

- `hz` — the measured display cadence (§3c). Without it the rest is uninterpretable. Report
  `hz_source` (`p10` or `p50`) beside it, so a reader can see when the sub-multiple guard fired.
- **`p95_frame_ms` and `p99_frame_ms` and `worst_ms`** — ~~the gate is `p95 ≤ budget` and
  `worst ≤ 3 × budget`~~ **revised 2026-09-02:** the gate is `dropped == 0` **and**
  `p95 ≤ 1.1 × budget` **and** `worst ≤ 3 × budget`, where `budget = 1000/hz`.
- `dropped` per second (missed vsyncs), and the **longest run of consecutive dropped frames** —
  one 200 ms stall is visible; forty scattered single drops are not.
- `rows_in` and `rows_committed` per second, to prove the harness actually delivered the load and
  the UI did not silently coalesce it away.
- `channel_msgs` and `max_msg_bytes`, to prove nothing crossed 8192 B and took the `fetch` path.
- Steady-state after 60 s: rendered DOM node count (must stay ~ viewport + 2×overscan) and JS heap,
  to catch a leak masquerading as a pass.

~~A run is a pass only if `p95_frame_ms ≤ 1000/hz` for every one-second window in the run, not for
the run as a whole.~~

**Revised 2026-09-02.** A run is a pass only if **every** one-second window in the run satisfies all
three of

```
dropped == 0                 and   p95_frame_ms ≤ 1.1 × (1000/hz)   and   worst_ms ≤ 3 × (1000/hz)
```

not the run as a whole. Averages are still not results; the raw per-window numbers are still
reported either way.

Why the 10% on p95 rather than the bare budget: **[measured]** 2026-09-02, 10 mock sessions at 2000
rows/s, **Chrome for Testing 152 — not WKWebView**. Every one-second window derived `hz 60` and
reported `p50 16.7 ms, p95 16.8 ms, worst 17.7 ms, dropped 0`. Frame times cluster on the budget
±0.2 ms, so `p95 ≤ 16.67` fails a run that missed no vsync at all — the old rule rejected a
perfect run on rounding. `dropped == 0` is now the load-bearing clause (it counts missed vsyncs
directly, §3c); the percentile clauses are there to catch the shape a drop count can hide.

The gate lives in one function, `windowPasses` in `src/fps.ts`; the overlay's red state and the burn
panel's PASS/FAIL both call it.

---

## 5. Rendering cost of a fixed-height row

- **`contain`** — Safari **15.4**+ for `strict`/`content`/`layout`/`paint`/`size`; `contain: style`
  only lands in Safari 27. BCD `css.properties.contain` **[source]**; caniuse "CSS Containment"
  shows `y` for Safari 26.5 **[source]**. `contain: strict` (= `layout paint size style`) is
  therefore **partially** unavailable today — the `style` component is the missing piece. Use
  `contain: layout paint size` (or `content` plus an explicit height) rather than `strict` to avoid
  depending on an unshipped value. **[source]**
- **`content-visibility`** — Safari **18**+ for the property, but `content-visibility: auto` only
  from **Safari 26**. BCD `css.properties.content-visibility.auto: safari 26` **[source]**;
  caniuse shows Safari 26.5 as `y` **[source]**. So it works on this machine and would break on
  macOS 15. More to the point: `content-visibility: auto` is a *substitute* for virtualization
  (skip rendering off-screen subtrees), and on rows that are already virtualized to ~40 nodes it
  buys nothing while adding a containment context per row. **[asserted]**
- **`overflow-anchor` / scroll anchoring** — not in WebKit 26.5 (§1, hand-rolled pitfall 1). This
  is the one CSS fact that changes the library choice.
- **`will-change`** — MDN's own guidance is that it is "intended to be used as a last resort" and
  that applying it to too many elements causes the page to consume a lot of memory. A row that
  never animates should not have it. Put `will-change` nowhere in the feed. **[docs]** MDN
  `will-change`.
- **`transform: translateY` vs `top`** — TanStack ships both and documents the tradeoff in its own
  types: `'transform'` (the default) "writes `transform: translate3d(...)`. Promotes items to their
  own compositor layer — usually smoother on long lists, but creates a stacking context and can
  interfere with `position: fixed` descendants"; `'position'` "writes `top` / `left`"
  **[source]** (`@tanstack/react-virtual/dist/esm/index.d.ts`). `react-window` 2.3.0 hardcodes
  `position:absolute` + `translateY` **[source]**. That is a vendor statement, not a measurement:
  no benchmark of the two on WKWebView was found or run. For rows that are recycled by React rather
  than animated, the difference is **asserted** to be in the noise; the real reason to prefer
  `'transform'` is that it is the default both libraries chose. **[asserted]**
- A `<div>` per row with a single text node, no flex, no measurement, is the cheapest thing WebKit
  can lay out. `substrate.md`'s warning stands: the cost that kills a feed is per-token markdown
  re-parse invalidating a virtualized list's heights, not the row element itself. Terse rows have
  no markdown, no measurement, and a compile-time-known height — that is the whole point of them.

---

## Recommendation

**Library: `@tanstack/react-virtual`, pin `3.14.10`** (it pins `@tanstack/virtual-core` `3.17.8`
exactly, so the transitive surface is fixed too). 7.6 KB min+gzip, MIT, released 2026-08-18, React
19 in `peerDependencies`.

It is the only one of the three that ships **both** halves of what a ring-capped log tail needs,
and ships them in code that was read, not in a blog post:

- `anchorTo: 'end'` + `followOnAppend: 'auto'` follows the tail **only when the reader was already
  at the bottom** (`isAtEnd(scrollEndThreshold)`, `index.js:305`).
- The same `anchorTo: 'end'` path re-anchors scroll when the **first** key changes — the exact
  event our 500-row ring produces 60 times a second — which WebKit's absent scroll anchoring
  cannot do for us.
- `directDomUpdates: true` + `directDomUpdatesMode: 'transform'` keeps scrolling off the React
  render path entirely and neutralizes the default `useFlushSync: true`.

`react-virtuoso` is the runner-up and the easier one to write (`followOutput` + `fixedItemHeight`
is two props), but it is 2.7× the bytes, gives no DOM to instrument for the FPS gate, and its
head-drop story (`firstItemIndex`) is aimed at prepending history, not at a ring. `react-window`
2.3.0 is the smallest and the cleanest component API, but has no tail-following and no anchoring at
all — choosing it means hand-rolling the two hard parts anyway. Hand-rolled is rejected for one
reason: WebKit has no scroll anchoring in 26.5, so the head-drop correctness bug is yours to
discover in week three.

Starting configuration:

```tsx
const v = useVirtualizer({
  count: rows.length,
  getScrollElement: () => scrollerRef.current,
  estimateSize: () => ROW_H,          // integer CSS px; never call measureElement
  overscan: 12,
  anchorTo: 'end',
  followOnAppend: 'auto',             // never 'smooth' — it re-animates every frame
  scrollEndThreshold: 24,             // px of slack before the tail detaches
  useScrollendEvent: true,            // Safari 26.2+ has scrollend
  directDomUpdates: true,
  directDomUpdatesMode: 'transform',
});
```

**Ingestion: module-level buffer → one shared `requestAnimationFrame` loop for the whole window →
one frozen snapshot per touched session → `useSyncExternalStore`.** `subscribe` declared at module
scope; `getSnapshot` per session id returning a cached reference; the feed never read inside
`startTransition`; no `flushSync` anywhere.

**FPS meter:** the §3c module — same rAF loop, `performance.now()` deltas, a 1-second report of
`{hz, frames, dropped, p50/p95/p99/worst_ms}` to `console.debug` in dev and to a
`record_frame_stats` Tauri command that appends NDJSON. It derives `hz` from the 10th-percentile
frame time instead of assuming 60 — falling back to the median when the two disagree by more than
20%, because a p10 on a sub-multiple invents dropped frames (§3c) — discards `dt > 1000` (hidden
window), and costs one `performance.now()` per frame. `hz_source` stays in the front end; the
`FrameStats` struct on the wire is unchanged.

**Burn harness:** one `burn(sessions, rows_per_sec, duration_s, fixture, Channel<FeedBatch>)`
command replaying `crates/claude-spike/fixtures/*.ndjson` through the real adapter and the real
`Channel`, batching ≤ 24 rows and asserting `serialized.len() < 8000` before each `send`. Gate
(revised 2026-09-02, see §4): ~~`p95_frame_ms ≤ 1000/hz`~~ `dropped == 0` and
`p95_frame_ms ≤ 1.1 × (1000/hz)` and `worst_ms ≤ 3 × (1000/hz)` in **every** one-second window of a
60 s run at 10 sessions, plus DOM node count flat and no message over 8192 B.

---

## Not checked

- **Nothing was rendered.** No React component, no virtualizer, no FPS meter and no burn harness
  was built or run. Every performance statement about our own UI is asserted; the only measurements
  here are bundle bytes, JSON payload bytes, and this machine's OS/display/WebKit versions.
- The observed rAF cadence in a real Tauri window on this machine was **not** measured. Whether it
  is 60 Hz or 120 Hz on macOS 26.5 is unresolved: WebKit's explainer says 60, an open WebKit bug
  says it depends on a preference, and a third-party plugin README claims macOS 26 removed the cap.
  The FPS meter is designed to survive this ambiguity rather than to settle it. **Measuring it is
  the first thing the burn harness should do.**
- No benchmark of `transform: translateY` vs `top` on WebKit. Both library defaults were read; the
  claim that the difference is negligible for non-animated recycled rows is asserted.
- No comparison of `useSyncExternalStore` against `useState` under real load — the argument is from
  the documented semantics and from where the data already lives, not from a profile.
- `react-window` 2.x was read from its published `.d.ts` and minified `dist`; its docs site
  (react-window.vercel.app) returned only a header to the fetcher, so the v1→v2 migration guide was
  not read. The v1 API's removal is inferred from the README pointing v1 users to a separate site
  plus the absence of `FixedSizeList` from the type surface.
- `react-virtuoso`'s `followOutput` implementation was **not** read, only its `.d.ts` doc comments;
  TanStack's was read in the shipped JS. The two claims are not equally strong.
- Tree-shaken, Vite-built sizes were not measured — the table is whole published packages.
- Nothing was tested on Windows or Linux. WebKitGTK is a different renderer with different
  containment and anchoring behaviour, and `substrate.md` already flags it as worse under DOM load.
- `contain: style`'s absence in Safari 26.5 was taken from BCD; no page was built to confirm that
  `contain: strict` silently degrades rather than erroring.
- No memory profile: whether a few thousand in-memory rows across 10 sessions matters was not
  measured.
