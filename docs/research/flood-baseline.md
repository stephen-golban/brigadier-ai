# Flood baseline: eight ordinary sessions, one flooder, one approval, three projects

Date: 2026-09-03. Scope: the stress test `docs/research/panel-review-2026-09-03.md` §5 proposed and
the repo had never run. Ten synthetic sessions, one of them flooding at the batch cap, one of them
raising a permission request, across three projects, with three gates on the result.

The store's reads run on the same thread as its writes (`crates/store/src/writer.rs`,
`spawn`/`run`), and that is **not** being changed. A second read-only connection is a documented
dead end: `docs/research/perceived-performance.md` trap 5 (lines 954-961) records that the writer
never holds a read for more than 8.03 ms even at 10 sessions by 2000 rows/s, that `Op::Query`
already closes the coalescing window early, and that the trap should be revisited only if
`feed_cap` grows by an order of magnitude. An order to build it was issued and withdrawn on
2026-09-03. The during-flood read column in §2 is reported as the evidence that would reopen that
question, not as a before-and-after.

The method is written to be re-run whatever changes, and it should be, because this run is a debug
build on a machine carrying five concurrent builds.

Tags: **[measured]** run on this machine today, command and number shown · **[source]** read in
this repo's code, file:line · **[asserted]** reasoned, not verified.

Assumes and does not repeat: `docs/research/feed-rendering.md` §4 (the burn harness, the batch
arithmetic, what must be measured to claim 60 fps), `docs/research/approvals.md` §6 (the two tables
of file:line the approval travels through), `docs/research/tauri-runtime.md` §3 (no backpressure
past the sink, the 8192-byte cliff).

---

## 0. Bottom line

| Gate | Verdict | Number |
|---|---|---|
| Approval visible in the UI within 100 ms of the harness receiving it | **PASS**, with a caveat | 3.2 / 4.2 / 10.6 / 14.2 / 14.9 ms, n=5, measured to the sink and no further |
| No growing backlog of durable events after the flood stops | **PASS** | store read round trip back to a 0.5 ms p50 within 100 ms of the flood stopping; worst 5.3 ms in the whole settle window |
| No lost rows | **PASS** | 9 sessions reconstructed row by row, `lost=0`, across 5 runs |

The caveat on gate 1 is the only one that matters: **the measurement ends at the sink**, which is
the Rust side of `tauri::ipc::Channel::send`. The eval hop, the rAF drain, the React commit and the
paint are not in the number. With 85 ms of the 100 ms budget unspent, they would all have to be
worse than the whole Rust path put together to break the gate, but that is an assertion, not a
measurement. **[asserted]**

Two things asked for are **not measured**, and neither can be without editing `src/`, which this
work order does not own:

- **The frame meter under this exact load in a real Tauri window.** What is here instead is the
  meter's own output under the browser mock in headless Chrome (§3), which is a different renderer,
  a different feed generator and a different process. Its p95 is on the wrong side of the gate in
  both the loaded arm *and* the idle control, so it says more about the machine than the feed.
- **Composer input to paint.** `beginInteraction` exists and works, and has exactly one call site
  in the repo (`src/App.tsx:316`, the B4 session switch). The composer has none. §4 gives the edit.

Two incidental findings, both **[measured]**:

- **Nothing is dropped at the batcher under this load.** The flooder's `rows_dropped` counter is
  `0` in every run: `PROJECT_ROW_CAP` never bites, because `pack` splits a frame into as many
  messages as it needs rather than one.
- **The byte re-check is the binding constraint, not the row count.** `max_message_bytes` lands at
  7,997–7,998 against the 8,000 ceiling in all five runs, with `max_rows_per_message` at exactly
  24. The packer fills to the byte ceiling by design and splits on the re-check
  (`crates/supervisor/src/batcher.rs`, `Packer`), so **a wider row means fewer rows per message,
  never an overflow**. Rows-per-message is the variable that absorbs a new field; the 8,000-byte
  message is not at risk from one. **[source]** + **[measured]**

---

## 1. Method

### The command

```
cd /Users/stephen/Development/brigadier-ai
cargo test -p brigadier-supervisor --test flood_baseline -- --ignored --nocapture
```

Environment: macOS 26.5.2, Apple M4 Pro, `cargo 1.98.0` / `rustc 1.98.0`, **debug build**, repo at
`c78a089` plus the two changes in §7. `c78a089` already contains `959bd0c`, which added the `k`
(`FeedKind`) field to `FeedRowWire`, so every byte figure below is for the row as it is today.
Every store and batcher number below carries a debug build's overhead, on a machine that was
running five other agents' builds throughout. **[measured]**

`#[ignore]` on purpose: this is an instrument that takes ~28 s and prints a report, not a gate that
should redden a suite when the machine is busy. The three structural invariants it does assert
(nothing over the byte cap, nothing over the row cap, every pure-script session reconstructed) are
not the gates.

### The shape

| Project | Sessions | Rate |
|---|---|---|
| `alpha` | 4 ordinary | 20 rows/s each |
| `beta` | 4 ordinary | 20 rows/s each |
| `gamma` | 1 flooder, 1 raising an approval | 1,500 rows/s, 20 rows/s |

The prompt is raised in the **same project as the flood**, ten seconds in, so it has to cross a
frame the flooder is already filling. Putting it in a quiet project would have measured nothing.

**1,500 rows/s is the batch cap, not a round number.** `MAX_ROWS_PER_MESSAGE` is 24 and
`DEFAULT_FRAME_INTERVAL` is 16 ms (`crates/supervisor/src/batcher.rs`), so 24 / 0.016 = 1,500
rows/s is the rate at which every frame's first message is exactly full. **[source]**

Flood 20 s, approval at t=10 s, settle 6 s after the flooder is killed, store probed every 100 ms
throughout.

### What the sessions replay

Every session runs a `ReplayDriver` over the script that `ReplayDriver::from_fixture` makes of
`crates/claude-spike/fixtures/s1-handshake-and-turn.ndjson`. That script is produced by driving the
**real Claude adapter** over duplex pipes with the captured NDJSON on one end, so the events are
the real translation and not a second implementation of it. No process is spawned. **[source]**

### How the approval is raised

The synthetic driver could not raise one. It can now, and the request is not hand-written:

- The test loads `crates/claude-spike/fixtures/s2-can-use-tool-allow.ndjson` through the same
  `from_fixture` path, finds the `Event::RequestOpened` the real adapter produced from that
  capture's `can_use_tool` frame, and hands its `RequestKind` to the flood driver. `tool_name` is
  `Bash`, printed by the test on every run. **[measured]**
- `ReplayDriver::with_approval` then parks that request in the session's real `ApprovalTable` and
  emits a real `Event::RequestOpened`, which is what
  `crates/core/src/claude/adapter.rs` `open_permission` does downstream of the CLI frame it
  decodes: park, spawn one forwarder per park, emit. **[source]**
- The answer travels the real route too. The test calls `Supervisor::respond`, the same call the
  allow button makes (`src/components/Approvals.tsx` → `src/bridge.ts` →
  `src-tauri/src/commands.rs` → `Supervisor::respond`), the park wakes, and the driver emits
  `Event::RequestResolved`. `respond_ok=true` and `answerable=true` in every run. **[measured]**

What is **not** exercised: the CLI's `control_request` decode, the `request_id` correlation, and
the `control_response` write. Those have their own replay tests
(`crates/core/tests/claude_adapter.rs`, s2/s3) and no `claude` process runs here.

### Where each number is taken

- **`t0` for the approval**: `Instant::now()` immediately before the park is opened, inside the
  driver. `RaisedApproval::at`. Not the wall clock, and not `PendingApproval::opened_at`, which is
  a `SystemTime` and coarser.
- **`t1` for the approval**: `Instant::now()` inside the sink, when the batch carrying the
  `request-opened` signal arrives. The sink is `FeedSink::send`, the trait whose only real
  implementation wraps `tauri::ipc::Channel::send`.
- **Durable backlog**: the round trip of `StoreHandle::feed_tail`. Reads and writes share one
  thread and one connection, and a `Query` closes the batch's coalescing window, so a read cannot
  answer until everything queued ahead of it has been applied. **The read's latency is the write
  queue's depth, in time.** No counter had to be added for this, behind a trace flag or otherwise.
  **[source]** + **[asserted]**
- **Lost rows**: for every session that runs pure script, the exact set of `seq` values that should
  carry a feed row is reconstructed with `brigadier_store::feed::terse_line`, the same function
  `feed::apply` uses to decide whether an event contributes a row at all, and compared element by
  element against `feed_tail`. Not a count. **[source]**

### Two ways the reconstruction can lie, and what was done about them

- **The store's ring trims on purpose.** `StoreConfig::feed_cap` is 500 per session
  (`crates/store/src/lib.rs`), and the flooder produces ~25,000 rows in 20 s, so ~24,900 of them
  are deliberately deleted. The comparison is therefore against the **tail** of the expected list,
  and the trimmed count is reported separately. A gate that read "rows in the store equal rows
  emitted" without this would fail by construction. **[source]** + **[measured]**
- **The terminal event is not in the script.** `from_fixture` filters `SessionExited` out and the
  replay mints its own, so folding the exit `seq` into the `(seq - 1) % len` script mapping charges
  it against whatever slot it lands on. The first cut of the test did exactly that and reported
  `lost=-3` on one run: three sessions whose exit landed on a `ContentDelta` came out one row
  short in the model, not in the store. Fixed, and the fix is why the reconstruction is worth
  trusting. **[measured]**

---

## 2. The three gates

Five runs of the same test at `c78a089`, which already contains the `k` (`FeedKind`) field on
`FeedRowWire` (`959bd0c`, corrected by `1d23df9`). The fifth ran after a behaviour-neutral
refactor of the driver's argument list and is reported with the rest. The machine was running five
other agents' builds throughout, which is where the spread in gate 2 comes from.

### Gate 1: the approval reaches the UI within 100 ms

| Run | park → sink | answerable | `respond` accepted |
|---|---|---|---|
| 1 | 14.85 ms | yes | yes |
| 2 | 3.18 ms | yes | yes |
| 3 | 14.21 ms | yes | yes |
| 4 | 10.57 ms | yes | yes |
| 5 | 4.15 ms | yes | yes |

**PASS**, 6.7× under budget at the worst sample. **[measured]**

The distribution is what the frame interval predicts: a signal raised at an arbitrary point in a
16 ms frame waits 0–16 ms for the flusher, and nothing else in the path is slower than that. The
flood does not delay it, because `pack` puts counters and signals into the message **before** any
row (`crates/supervisor/src/batcher.rs`, `pack`), so a `request-opened` rides in the first message
of its project's frame however many rows are queued behind it. **[source]**

What is not in this number, and would have to be added to claim the budget end to end: the `eval`
hop into the webview, the `onmessage` push, the rAF drain, the React commit, and the paint. On the
evidence of `docs/research/perceived-performance.md` §2.7 those are tens of milliseconds, not
hundreds, but this run did not measure them. **[asserted]**

### Gate 2: no growing backlog of durable events after the flood stops

Store read round trip, milliseconds, per run.

| Run | during flood p50 | p95 | worst | after stop p50 | p95 | worst | +2 s onward worst |
|---|---|---|---|---|---|---|---|
| 1 | 2.41 | 6.68 | 9.43 | 0.60 | 2.32 | 3.46 | 3.46 |
| 2 | 2.89 | 8.34 | 9.82 | 0.67 | 4.98 | 5.29 | 5.29 |
| 3 | 2.37 | 3.92 | 7.81 | 0.53 | 2.27 | 3.41 | 0.67 |
| 4 | 2.30 | 2.60 | 5.99 | 0.48 | 0.57 | 2.31 | 0.61 |
| 5 | 2.56 | 8.66 | 9.65 | 0.50 | 2.14 | 2.97 | 2.97 |

**PASS.** The queue drains inside one probe interval: the first read after the flooder is killed
costs 2.3 ms, the next 0.5 ms, and it stays there. There is no run in which the read cost is
higher at the end of the settle window than at the start of it, which is the shape a growing
backlog would have. **[measured]**

A sixth run, discarded because its gate-3 model was defective in a way that could not touch the
store path, saw a heavier tail: during-flood p50 6.06, p95 14.12, p99 37.89, worst 43.22 ms. Five
runs are not enough to bound this tail, and the five above should not be read as if they were.
**[measured]**

The load-bearing observation is the **during-flood** column, not the after: at ~1,560 rows/s of
durable writes, a UI read already costs a few milliseconds, and its tail reaches 9.82 ms in the
kept runs and 43.22 ms in the discarded sixth, against a 16 ms frame.

**This does not call for the second read connection.**
`docs/research/perceived-performance.md` §2.3 (line 386) measured the writer holding a read for
**8.03 ms worst case at 10 sessions by 2000 rows/s**, and trap 5 (lines 954-961) rules the second
connection out on that basis, to be revisited only if `feed_cap` grows by an order of magnitude.
An order to build it was issued from a reading of `writer.rs:329-335` and withdrawn the same day.

What this column is, then, is the one measurement that **exceeds** §2.3's 8.03 ms worst case: p95
up to 8.66 ms and worst up to 9.82 ms in the five kept runs, p95 14.12 ms and worst 43.22 ms in
the discarded sixth. Every one of those numbers comes from a **debug build on a machine running
five other agents' builds**, which is enough on its own to explain the gap. If it reproduces in a
**release build on an idle machine**, that is the evidence that reopens trap 5. If it does not, the
trap stands and this column is an artefact of how it was taken. Nothing here is a reason to build
the split now. **[measured]** + **[asserted]**

### Gate 3: no lost rows

| Run | sessions reconstructed | lost | trimmed by the 500-row ring |
|---|---|---|---|
| 1 | 9 | 0 | 24,941 |
| 2 | 9 | 0 | 24,782 |
| 3 | 9 | 0 | 25,115 |
| 4 | 9 | 0 | 25,215 |
| 5 | 9 | 0 | 25,070 |

**PASS.** Every `seq` the producer should have written a row at is in the store, in order, except
the ones the ring deleted on purpose. **[measured]**

The ninth session is the flooder; the tenth, which raises the approval, is excluded from the
reconstruction because its two out-of-band envelopes shift its `seq` numbering off the script. Its
rows are covered by the batcher's own `rows_total` counter, not by the element-by-element check.

### Load actually delivered

| Run | messages | max message bytes | max rows/message | rows to the sink | flooder `(rows_total, rows_dropped)` |
|---|---|---|---|---|---|
| 1 | 3,296 | 7,997 | 24 | 29,454 | (25,441, 0) |
| 2 | 3,089 | 7,997 | 24 | 29,293 | (25,282, 0) |
| 3 | 3,688 | 7,998 | 24 | 29,649 | (25,615, 0) |
| 4 | 4,450 | 7,998 | 24 | 29,743 | (25,715, 0) |
| 5 | 3,856 | 7,998 | 24 | 29,594 | (25,570, 0) |

`rows_dropped = 0` on the flooder in every run: nothing was coalesced away, so the gates are being
judged against the load that was asked for. **[measured]**

---

## 3. The frame meter: measured, but not on the thing under test

`src/fps.ts` was not run in a Tauri window for this baseline. What follows is the meter's own
one-second reports, captured out of `console.debug("fps", …)` over the Chrome DevTools Protocol,
with the app served by `vite` and the feed served by the **browser mock** (`src/mock.ts`), in
**Chrome for Testing 152.0.7977.54 headless** on macOS 26.5.2, Apple M4 Pro. No `src/` file was
edited to get it; the meter already logs these objects in a dev build.

Three arms, 30 s each after a 4 s settle.

| Arm | windows | hz | p95 med / max | p99 med / max | worst max | dropped total | longest drop run | DOM nodes | windows failing `windowPasses` |
|---|---|---|---|---|---|---|---|---|---|
| idle control, `?rps=20&sessions=1` | 33 | 60 | 17.3 / 19.3 | 18.2 / 31.3 | 31.3 | 4 | 1 | 323 | 5 / 33 |
| load, `?rps=1660&sessions=10` (a) | 34 | 60 | 17.6 / 19.7 | 18.8 / 80.9 | 80.9 | 12 | 1 | 413 | 11 / 34 |
| load, `?rps=1660&sessions=10` (b) | 33 | 60 | 18.4 / 18.7 | 18.7 / 20.2 | 20.2 | 0 | 0 | 413 | 18 / 33 |

`hz` was 60 with `hz_source: "p10"` in every window of every arm: the sub-multiple guard never
fired and the cadence never had to fall back to the median. **[measured]**

**These numbers should not be quoted as a result for brigadier.** Four reasons, in order of how
much they matter:

1. It is not WKWebView. `docs/research/feed-rendering.md` §5 turns on WebKit-specific facts
   (no scroll anchoring, no `contain: style`, a rAF cadence set by a preference we do not control)
   and none of them apply to Chrome.
2. It is not the Rust feed path. The mock generates rows in JS; the `Channel`, the eval hop and the
   8 KB cliff are all absent, which is most of what §4 of that brief says to measure.
3. The idle control fails 5 of 33 windows. A control that cannot hold the gate makes the loaded
   arms uninterpretable: the machine was running five other agents' builds throughout.
4. The load arms disagree with each other on the failure mode. Arm (b) dropped **zero** vsyncs and
   still failed 18 windows, on `p95 18.4 ms` against a `1.1 × 16.67 = 18.34 ms` threshold. That is
   the rounding failure `feed-rendering.md` §4 already documented, reappearing 0.06 ms wide.

The honest reading: nothing here shows the feed breaking, and nothing here shows it holding. The
real measurement is the burn panel in a Tauri window, and it needs a human to press the button.

---

## 4. Composer input to paint: no call site, so no number

`beginInteraction` in `src/paint.ts` is built, tested (24 tests in `src/paint.test.ts`) and proven
in a real window for B4 (`docs/research/perceived-performance.md` §2.7). It has **one** caller in
the repo, `src/App.tsx:316`. The composer has none, so there is nothing to measure and no way to
add one from this work order, which does not own `src/`.

The edit, exactly. Line numbers are the `Composer.tsx` of 2026-09-03 while another worker is
editing that file, so match on the code, not on the number.

- `src/components/Composer.tsx:326-327`, the send path. `onKeyDown` reads
  `if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();`. It becomes
  `const span = beginInteraction("b7_composer_send"); send(); span.painted();`, with `painted()`
  moved to whatever state settles the acknowledgement if `send` is asynchronous. This is **B7**,
  "any button to visible acknowledgement", which `docs/research/perceived-performance.md` lists as
  a guess with no call site.
- `src/components/Composer.tsx:324`, the keystroke path. `onChange={(e) => setText(e.target.value)}`
  becomes a `beginInteraction("b7_composer_keystroke")` before `setText`, with `.painted()` in a
  `useEffect` on `text`. This is the "input to paint" half of the question.
- `src/components/Composer.tsx:24-26`: add `import { beginInteraction } from "../paint";` beside
  the existing imports.

Note the floor before anyone reads the result: `beginInteraction`'s own double-`requestAnimationFrame`
costs ~33 ms at 60 Hz, and 8 of the 14 B4 samples sit within one frame of it
(`docs/STATUS.md`). A composer keystroke will not measure much above that floor.

---

## 5. Where the time goes

Nothing failed, so this is where the time went rather than where it was lost.

- **Feed path.** Free at this load. The flooder's rows never queue: `pack` splits one frame into as
  many sub-8 KB messages as the rows need, so `PROJECT_ROW_CAP` is never approached and
  `rows_dropped` stays 0. The cost is 3,000-odd `Channel::send` calls in 26 s, which the sink
  absorbs synchronously. **[measured]**
- **Store writer thread.** This is the only place with a visible cost. A UI read during the flood
  costs 2.3–2.9 ms p50 and 2.6–8.7 ms p95 across the five runs, and 6.1 p50 / 14.1 p95 / 43.2 worst
  in the discarded sixth, because the read waits behind the writes. Idle, the same read is
  0.5–0.7 ms. So the flood inflates a UI read by 4–12× at the median, and its tail crosses both the
  16 ms frame budget and §2.3's 8.03 ms worst case, in a debug build on a loaded machine.
  **[measured]**
- **Approval path.** Free. 3.2–14.9 ms, n=5, and the shape says the whole of it is the flusher's
  16 ms frame, not work. Signals are packed ahead of rows, so a flood cannot push a prompt back.
  **[measured]** + **[asserted]**

The one number to re-take, in a release build on an idle machine: the **during flood** column of
gate 2. It is the only figure in this file that contradicts a shipped measurement
(`docs/research/perceived-performance.md` §2.3 line 386, 8.03 ms worst case), and it is the only
thing that would reopen trap 5 (lines 954-961). Reproduce it before acting on it.

---

## 6. The `pgrep` proof

`pgrep -fl claude` before and after every run. The matching processes are the operator's own Claude
Code CLI sessions and Pen's MCP servers, which were running before this work started and are
unrelated to it. The point of the proof is not that no `claude` process exists, which is false on a
machine that is running Claude Code and always will be. The point is that **the set does not
change**.

Before the last run, filtered to the binary itself:

```
$ pgrep -fl claude | grep -E "^[0-9]+ claude$"
22589 claude
30298 claude
49077 claude
```

After it, byte for byte the same three. The unfiltered `pgrep -fl claude` also matches four
`mcp-server-darwin-arm64 --app desktop --agent claudeCodeCLI` processes (Pen's), and a shifting set
of other agents' `zsh -c` wrappers whose command line happens to contain the string `claude` in a
shell-snapshot or scratchpad path. None of those is a `claude` binary and none of them is this
run's.

Across the three consecutive runs taken in one batch, `pgrep` before and after each diffed clean:

```
A: identical -> 22589 claude 30298 claude 49077 claude
B: identical -> 22589 claude 30298 claude 49077 claude
C: identical -> 22589 claude 30298 claude 49077 claude
```

**[measured]** This is also true by construction: the only driver registered is `ReplayDriver`, and
`crates/core/src/claude/process.rs`, the only code in the repo that spawns `claude`, is never
reached. The `pgrep` is the check on that reasoning, not the reasoning.

---

## 7. What changed in the repo

| File | What |
|---|---|
| `crates/supervisor/src/replay.rs` | `ApprovalPlan`, `RaisedApproval`, the private `Prompt`, `ReplayDriver::with_approval`, `ReplayDriver::raised_approval`, two new `select!` arms in `run` that park a request and emit `RequestOpened`, then emit `RequestResolved` when it is answered, and the `sleep_until` helper |
| `crates/supervisor/tests/flood_baseline.rs` | new, `#[ignore]`, the whole measurement |

No counter was added anywhere, behind a trace flag or otherwise: the durable-backlog gate is read
off the store's existing read latency and the lost-row gate is reconstructed from the script. No
file under `crates/store/`, `crates/claude-spike/`, `src/`, `src-tauri/src/lib.rs` or
`src-tauri/src/state.rs` was touched.

`src-tauri/src/burn.rs` was **not** changed. It registers one `ReplayDriver` for every burn session
and would need a second driver kind to raise a prompt from the dev panel; that is one small edit
and it is not needed to take this measurement.

---

## 8. Not checked

- **The UI half of gate 1.** Everything past `FeedSink::send` (eval, `onmessage`, the rAF drain,
  the React commit, the paint) is outside the number. The 100 ms budget is met at the sink with
  85 ms unspent, and the rest is asserted to fit, not measured.
- **The frame meter in WKWebView, under this load, through the Rust path.** §3 is Chrome, the
  browser mock, and a machine under heavy foreign load. It is a floor on the instrument working,
  not a result about the app.
- **Composer input to paint.** No call site (§4).
- **A real `can_use_tool` frame.** The request's `RequestKind` comes from a real capture, but the
  CLI-side decode and the `control_response` write are not in this path. Those are covered by
  `crates/core/tests/claude_adapter.rs` s2/s3 and by `docs/research/approvals.md` §12's live run.
- **Sustained running.** ~28 s per run. Nothing here says what an hour looks like, and the store's
  `incremental_vacuum` after the ring's 25,000 deletes was not watched at all.
- **Memory.** No RSS, no heap, no DOM node count in a real window.
- **Anything but macOS 26.5.2 on an M4 Pro**, with cargo 1.98.0 and a debug build. A release build
  was not measured, and every store and batcher number here carries a debug build's overhead.
- **How many rows per message a wider `FeedRowWire` costs.** Messages land at 7,997–7,998 in every
  run at 24 rows, so the ceiling is doing its job, but no row width other than the one in the tree
  at `c78a089` was tried. That tree already carries the `k` (`FeedKind`) field added at `959bd0c`
  and corrected at `1d23df9`, so these five runs measure the row **with** `k`; the three discarded
  worktree runs at `ccc8955` predate it and are not in any table. A worst-case 24-row bound of
  6,813 B for the current row was computed by the coordinator and is **not** verified here.
