# Rendering fix direction

2026-09-11. Focused web research and current-source audit; no new build, test suite, or native capture.

## Conclusion

The strongest remaining source-supported architectural target is the global feed subscription in App. Local row memoization reduces some work, but session changes still enter the entire shell. The remaining first-open hitch needs attribution to scripting, layout or paint before another speculative change. The existing callback meter cannot provide that attribution. Removing the synthetic assistant-ui runtime is a possible simplification, not an established performance fix.

## What the measurements mean

- **Measured previously:** the last uninterrupted shared-clock capture reported five missed 60 Hz opportunities over about a minute and a worst callback interval of 45 ms. Most misses occurred during the first transcript appearance. These are callback intervals, not measured compositor presentation times. The current worker build has no valid uninterrupted rendering result.
- **Source-verified:** `src/fps.ts` computes missed opportunities as `max(0, round(interval / (1000/60)) - 1)`. `src/feedStore.ts` passes the browser's rAF timestamp. The meter already documents that it does not acknowledge compositor presentations.
- **Primary-source fact:** the HTML rendering algorithm runs animation callbacks before style/layout and excludes hidden documents. Callback spacing is useful evidence of scheduling delays, but does not isolate app JavaScript, browser work, OS scheduling, or actual presentation. [HTML rendering algorithm](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering).
- **Primary-source fact:** WebKit stops rAF and throttles timers when pages become inactive. Its documented cases include other apps, covered windows and other Spaces. This explains the mechanism behind unusable hidden captures; it does not identify why these particular windows became hidden. [WebKit power behavior](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/).
- **Recommendation:** preserve the existing burn as a stress/regression check. Do not use another complete burn as the next diagnostic. Record just the first transcript appearance in Web Inspector's Frames view and identify the expensive script/layout/paint record. Inspector instrumentation can affect performance, so this is a diagnostic, not an acceptance score. [WebKit Timelines reference](https://webkit.org/web-inspector/timelines-tab/).

## Concrete code issue: updates still enter the whole shell

**Source-verified:** `src/App.tsx:194` subscribes to the full `store.getState()` snapshot. The following memo filters/rebuilds the sessions record and order whenever that snapshot changes. Around line 1170, JSX constructs new sidebar title/session records and an order array. `Sidebar` itself is an ordinary component; its individual session rows/actions are memoized. Its filters, sorts and element construction still execute on parent renders.

`src/feedStore.ts` publishes a new whole-store snapshot when any session's rendered fields change. Thus a busy/status change for a background session reaches App even if most shell content is unchanged. Existing narrow transcript subscriptions and stable row props are useful, but do not remove that top-level dependency.

**Recommended implementation direction, not a measured gain:** have the stable shell subscribe only to navigation/selection and the few aggregate values it draws. Put ordered session IDs in a list subscription, and each session's visible state in that row's subscription. Keep selected-session data and approval updates scoped to their consumers. Preserve immutable cached snapshots and immediate approval/status delivery; do not suppress data or use a comparator that ignores callbacks. This reduces the amount of work caused by a real update instead of adding memoization throughout a tree that still receives broad updates.

React documents that external-store mutations cannot be marked as nonblocking transitions. Wrapping this feed in `startTransition` therefore is not a substitute. React also documents that fresh objects/functions defeat default memo comparison. [React external-store caveats](https://react.dev/reference/react/useSyncExternalStore), [React memo](https://react.dev/reference/react/memo).

**Limit:** source inspection establishes the broad update path. It does not establish that this path explains all of the remaining 45 ms interval, especially during initial mounting.

## The stress fixture is not ordinary streaming

**Measured/source-verified:** `burn-full-feed.json` records `scriptLen: 9`, `rowsPerSec: 200`, ten sessions. `ReplayDriver` loops the entire canonical script. The handshake/turn fixture therefore replays approximately 22 complete cycles per second per session, including start/completion status changes (about 44 busy flips/sec). `feedStore.ts:378` also re-stamps `startedAtMs` on session-started; ordering can change with each cycle. This behavior is explicitly documented in the existing store comments. The fixture has no content-delta/item-updated events (`scripts/measure-native-burn.py:65`).

**Inference:** this stresses repeated lifecycle changes and sorting, not just high-volume text streaming. It is a valid adversarial workload, but cannot stand in for all ordinary conversation behavior. Add a separate representative replay with sustained deltas within a turn when evaluating user-facing streaming; retain the existing workload and report both. Do not replace or weaken the current gate and call that an optimization.

## Alternative: simplify the scrolling integration

**Source-verified:** `ThreadView.tsx` renders saved rows directly, then separately maps the same rows into synthetic assistant-ui messages for viewport behavior. `TranscriptRuntime.tsx` creates a writable external-store runtime around those children. The composer/send path lives outside this wrapper. This gives a concrete seam for simplification while keeping the current Elements and visual design.

Official standalone Elements do not require a chat runtime. However, current ThreadPrimitive scrolling does require runtime scopes, and Markdown still uses AUI context. Replacing that scrolling adapter must preserve following after content/size changes, user scroll-away intent, saved position, virtualized history and Jump to latest. The current read-only viewport is not an equivalent writable replacement. See [scroll alternatives](transcript-scroll-alternatives-2026-09-11.md) for primary sources and installed-source details.

**Recommendation:** treat this as a secondary option if the cold trace attributes material cost to that runtime or its measurement effects. Existing traces do not prove it is the main culprit. A broad chat rewrite, a framework change, or more unmeasured tooltip/cache changes are not supported by the evidence.

## Bounded next step

Use one short cold-open diagnostic to select the actual expensive operation. If it confirms update fan-out, isolate subscriptions as above; if it shows layout/scroll measurement, fix that specific sequence. Verify the affected behavior and compare that same cold event before returning to the full acceptance workload. No blanket suite repetition is needed for this research-only change. Current release requirements and unresolved performance status remain unchanged.
