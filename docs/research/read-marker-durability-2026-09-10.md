# Read-marker durability across an app quit — 2026-09-10

`src/attention.ts` coalesces read-marker writes behind a 250 ms trailing throttle (`flushDelayMs`), which took the
60 Hz benchmark from 2,815 durable writes in 63 s to 224. The question this note answers is what that window costs when
the app goes away: the file's own header used to claim the `pagehide` listener and the selection-change flush "are what
cover that case", and marked it *not checked*. It is now checked, and the claim was false.

Bottom line first:

- On a macOS app quit, `visibilitychange→hidden` and `pagehide` flush **nothing**. A graceful Apple-Event quit (the
  Cmd-Q path) is statistically indistinguishable from a bare `SIGTERM`, which runs no handler at all. **[measured]**
- Worst measured graceful-quit loss: **48 read-marker events / 240 ms** of progress — against at most one advance under
  the old per-frame synchronous code. **[measured]**
- WebKit's own localStorage→SQLite layer is *not* the leak. It flushes on a graceful quit; only `SIGKILL` ever outran
  it. What is missing is the JS-side write. **[measured]**
- The selection-change flush (`useEffect(() => flushSessionReads, [selected])`) does work. **[measured]**

---

## 1. Method, so the numbers can be reproduced or dismissed

31 controlled runs against the **real isolated app** (not a probe webview), each one: start the app, drive a workload
that advances the selected session's read marker every ~5 ms, kill the app mid-workload by one of the three paths
below, then compare what survived on disk against ground truth.

- **Ground truth** is `max(seq)` in the data directory's `raw/<session>.ndjson` — the stream's own record of how far the
  session got. The delta against the persisted marker is the loss reported below. **[measured]**
- **The persisted marker** lives in WKWebView's localStorage SQLite file, found by globbing the app's WebKit data
  directory for `WebsiteData/**/LocalStorage/*.localstorage` (path shape varies by app id and by store generation, so
  glob it rather than hard-coding). **[measured]**
- **Three traps in reading that file, all hit at least once:**
  1. Values are stored **UTF-16LE**, so `select cast(value as text) …` returns a string that looks empty or truncated
     at the first NUL. Read the blob and decode it as UTF-16LE (`cast(value as blob)`, then decode) instead.
     **[measured]**
  2. The database is in **WAL mode**. Copying only the `.localstorage` file yields a stale snapshot; the `-wal` sidecar
     must be copied alongside it and replayed (open the copy read-write once, or `PRAGMA wal_checkpoint`). Reading the
     live file in place while the app runs is not safe either. **[measured]**
  3. There is more than one candidate store on disk across app builds. Take the one whose mtime moved during the run.
     **[measured]**
- **Kill paths.** *Apple-Event quit* = the ordinary Cmd-Q path, delivered as a `kAEQuitApplication` Apple Event so the
  app runs its normal termination sequence. *SIGTERM* = `kill`, which in this app runs no handler at all and therefore
  serves as the floor: whatever a graceful quit does over and above "process disappears" must show up as a difference
  from this row. *SIGKILL* = `kill -9`, the ceiling.
- **Control.** Quit ≥6 s after read-marker advances stopped. If the harness can see a flush at all, it must see this
  one, because the trailing timer has long since fired.

## 2. Results

| Scenario | Reps | Median ms lost | Max ms lost |
|---|---|---|---|
| Apple-Event quit (the Cmd-Q path) | 11 | 100 | **240** |
| SIGTERM (runs no handler at all) | 6 | 140 | 255 |
| SIGKILL | 12 | 228 | 1750 |
| Control: quit ≥6 s after advances stopped | 2 | 0 | 0 |

**[measured]**, all four rows.

Three things follow.

1. **The graceful quit buys nothing.** Its median (100 ms) and max (240 ms) sit inside SIGTERM's spread (140 / 255) at
   these sample sizes. A listener that flushed at teardown would put the graceful row at or near 0, like the control
   row. It does not. **[measured]**
2. **Loss reaches the throttle ceiling.** 240 ms and 255 ms are the `flushDelayMs` window, near-full. A flush at
   teardown cannot leave a near-full window unwritten. **[measured]**
3. **The method is sound.** The control row is exactly 0 twice: when advances stop, storage catches up and nothing is
   lost. The harness sees a flush when there is one. **[measured]**

### The platform layer is not the leak

`SIGKILL` exceeded the 250 ms JS window twice, at **850 ms** and **1750 ms** — i.e. WebKit's own localStorage→SQLite
write-behind had that much in flight when the process was destroyed. A graceful quit **never** exceeded the window.
**[measured]** So on the path that matters, WebKit finishes what JS handed it; the missing writes are ones JS never
performed.

---

## 3. What changed in `src/attention.ts`

- The header comment now states the measurement instead of the old "the `pagehide` listener … covers that case". No
  claim in that file now rests on a listener the measurement says never runs. `visibilitychange` and `pagehide` are
  **kept** — they cost nothing and may fire in other lifecycle transitions such as display sleep or a hidden window —
  but they are no longer described as quit coverage.
- A flush on window **`blur`** was added. It demonstrably fires in this webview, it is user-paced rather than 60 Hz so
  it costs nothing on the hot path, and losing focus is the ordinary precursor to switching away or quitting.
  (`blur` does not bubble, so a `window` listener in the bubble phase sees only real window-focus loss, not focus
  changes between composer and editor. **[asserted]**, DOM spec.)
- One test added: `src/attention.test.ts`, "flushes a pending read marker when the window loses focus".

### Considered and rejected

- **Shortening `flushDelayMs`.** This trades back the ~45 durable writes/s the whole change exists to remove; 2,815→224
  writes is the measured win being protected. Rejected outright.
- **`beforeunload` / `unload`.** `beforeunload` disqualifies the page from the back/forward cache; Chrome is
  deprecating `unload`. Neither has any evidence of firing here that `pagehide` lacks.
- **A JS-side Tauri window `onCloseRequested` handler.** It arrives over an async IPC round-trip, so it cannot block
  teardown any better than the listeners that already fail, and verifying it needs an app launch this change did not
  have. The Rust-side variant below is the version worth building.
- **`mouseleave` / pointer-out on the document.** Fires far too often for the benefit and is not a quit signal.

### Residual risk after the fix

Up to `flushDelayMs` (250 ms) of read-marker progress, lost when the app is quit **while it still holds keyboard
focus** and the selected session is advancing. Cmd-Q from the focused app is exactly that case, so `blur` narrows the
window (quit after a Cmd-Tab, a click into another app, or a Dock quit is now covered) without closing it.
**[asserted]** — the `blur` path is measured to fire, but the post-fix quit distribution has **not** been re-measured.

User-visible consequence, unchanged in kind: an unread dot returns on the conversation the operator was looking at,
and re-selecting that conversation clears it for good. No marker ever moves backwards — `markSessionRead` refuses
anything not strictly greater (`src/attention.ts`) — so the failure mode is a stale dot, never a lost conversation or a
skipped approval.

## 4. What was not checked

- **Whether the two listeners never fire at all, or fire after the JS context is torn down.** The experiment measures
  the *effect* (nothing reaches storage), not the callback. Either explanation fits the data equally; nothing here
  distinguishes them, and no instrumented build was run to find out.
- **The size of WebKit's own localStorage→SQLite write-behind lag.** Bounded below at ~1.5 s by the SIGKILL tail
  (1750 ms) and known to be smaller than the JS window on a graceful quit, but never isolated or measured directly.
- **Post-fix quit loss.** The `blur` flush has not been re-run through the 31-run harness.
- **Non-macOS.** Every number here is macOS/WKWebView. Nothing was run on the Linux WebKitGTK or Windows WebView2
  backends.
- **Sample sizes are small** (11 / 6 / 12 / 2). The graceful-vs-SIGTERM claim is "indistinguishable at these n", not
  "identical".

## 5. Follow-up: the fix that would actually close the gap

Drive the flush from **Rust**, on the window's close/exit path, and make it synchronous with respect to teardown:

1. On `WindowEvent::CloseRequested` (and the app-exit / `RunEvent::ExitRequested` path, which is what an Apple-Event
   quit takes), take the close token so the window does not vanish yet.
2. Ask the webview to persist: either evaluate `flushSessionReads()` in the page and wait for an ack over IPC, or —
   better, because it does not depend on the JS context still being alive — keep the authoritative read map mirrored in
   Rust and write it from Rust directly, making the localStorage copy a cache rather than the record.
3. Release the close token (or time out on a short budget, ~100 ms) and let the quit proceed.

Option 2 is the one that removes the class of bug rather than the instance: it stops the durability of a read marker
depending on whether a webview lifecycle event fires during teardown, which this note shows is not something to rely
on. It also needs no change to `flushDelayMs`, so the 2,815→224 write reduction stands either way.

Whoever picks this up: re-run the harness in §1 against the new build, and expect the graceful-quit row to move to the
control row's 0, not merely to shrink.
