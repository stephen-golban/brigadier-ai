# The false "execution settings are unavailable" banner

Dated 2026-09-11, against `ui/followups` off `a4e46eb`. Every claim below is marked **[measured]**,
**[read]** (traced in the source, not run) or **[asserted]**. Nothing here was watched in a running
window: the app was never launched for this work, and that is the largest gap in it.

## 1. What the user saw

The composer printed, at every launch, with a healthy Claude Code install:

> The selected execution settings are unavailable. Open execution settings to choose a connected
> provider and model.

It cleared by itself a moment later. In auto mode there are no *selected* execution settings, so
the sentence was wrong twice: about the cause, and about what the user should do.

## 2. The trace [read]

Line numbers are `a4e46eb`, before this change.

1. `src/components/NewSession.tsx:128` renders the banner when `unavailable && preferences.loaded`.
2. `unavailable` (`:76`) in auto mode is `!providers.some(p => p.id !== "claude-code" || !claudeUnavailable)`
   — with `providers` empty, that reduces to `true` regardless of anything the user chose.
3. `providers` comes from `useProviderCatalog` (`src/providerCatalog.ts:9-20`): initial `[]`, **no
   loaded flag**, one `invoke("provider_catalog")` on mount, re-read only on a window `focus`
   event. Between mount and the first resolve, "no providers" and "not asked yet" are the same
   value.
4. `provider_catalog` (`src-tauri/src/provider_catalog.rs:28-37`) awaited
   `orchestration::discover` (`crates/supervisor/src/orchestration.rs:134-176`) **before**
   answering, and awaited a `codex::capabilities::refresh` per Codex driver inside the loop
   (`:53-65`), which spawns the `codex` binary.
5. `discover` spawns a full `claude` session to read the model list when the capability cache is
   empty, and the cache is an in-process `OnceLock` (`crates/core/src/claude/capabilities.rs:17`),
   so **every launch starts cold**.
6. Preferences resolve first — in the browser path straight out of `localStorage`
   (`src/taskSettings.ts:41-43`), on desktop a SQLite-backed command with no child process — so
   `preferences.loaded` is true while `providers` is still `[]`, and the banner fires.

Cost of the handshake the response was waiting on: spawn → `initialize` control response **719 ms**,
n=1 **[measured]**, `docs/STATUS.md` §4, citing `docs/research/claude-direct-spike.md:106`; the
spike also measured stdin-close → exit at 571 ms, and `discover` ends the probe session before
returning. Exec → first contentful paint is **287–295 ms** p50 **[measured]**, same table. The paint
therefore lands roughly half a second before the catalogue can, at best.

Secondary, permanent case: if both driver probes fail (`src-tauri/src/state.rs:271-288` for Claude),
no driver is ever registered, `provider_catalog` returns `[]` forever, and the old hook never
retried without a `focus` event. The banner was then permanently on — and still blamed the user's
saved settings for a missing CLI.

## 3. The fix

**Hook — `src/providerCatalog.ts`.** Returns `ProviderCatalogState { providers, error, loaded }`.

- `loaded` means *settled*: the read finished **and** no retry is outstanding. Not "the first
  promise settled" — that literal reading would flip `loaded` true on the empty first read and
  print the banner anyway, which is the bug.
- A read that comes back incomplete — no providers at all, or a provider whose
  `modelCatalogKnown` is `false` — schedules a retry. The schedule is **front-loaded: 300 ms,
  900 ms, 1500 ms, 1500 ms — four retries, 4.2 s of budget** (`RETRY_DELAYS_MS`). It was a flat
  3 × 1.5 s until the 2026-09-11 blind review; front-loading matters because the answer the retry
  is waiting for is a cache fill, not a fixed cost, and the first retry now lands at 300 ms —
  **sooner than the ~750 ms blocking read this whole change replaced** **[asserted]**, arithmetic
  against the 719 ms handshake measurement, not a stopwatch. The `modelCatalogKnown` condition
  matters: a registered driver whose model list has not arrived yet is the same "not known yet".
- **A Tauri event, `provider-catalog-refreshed`, is what actually settles it.** The budget alone
  could not: after four retries `loaded` flipped true with `providers: []` and nothing re-read
  until a window `focus` event — **which a launch never fires, because the window already has
  focus**. That was the bug the review found, and it is the permanent-empty case of §2 all over
  again. `src-tauri/src/provider_catalog.rs` now emits the event from the `AppHandle` when the
  background refresh task finishes, success or failure, through an `EmitOnDrop` guard so an unwind
  still wakes the client. The hook subscribes with `listen()` and re-reads **regardless of the
  budget**, unsubscribing on unmount.
- **A 15 s poll while unsettled**, cleared the moment a real catalogue arrives and on unmount. Belt
  to the event's braces: it also covers a CLI installed after launch.
- A rejection retries on the same budget and its message is held back until the budget is spent.
  `provider_catalog` rejects with `startup_pending` ("Brigadier is opening",
  `src-tauri/src/state.rs:121-127`) while the app is still opening, and that is not an error worth
  showing anyone.
- `focus` still re-reads, and gives the retry budget back. One read at a time: a read already in
  flight swallows the next, because two overlapping reads would each schedule a retry on resolve
  and the second `setTimeout` would overwrite the handle, leaking the first past unmount.
- Worst case with no CLI installed: the honest message appears **4.2 s** after mount
  **[asserted]** — arithmetic, not a stopwatch.

**The feedback loop the event opens, and the cooldown that closes it.** Every read asks for a
background refresh, and every finished refresh now emits an event the client re-reads on — an
unbounded cycle, each turn of which re-spawns the `codex` binary and the Claude handshake. A
**2 s cooldown** in `claim_refresh` breaks it: the event-driven re-read lands milliseconds after
the emit, well inside the window, and starts nothing; a window `focus` seconds later still
refreshes. `claim_refresh_after(Duration)` exists so the two Rust unit tests can take the cooldown
out of the way; they share process-global statics and hold a `SERIAL` mutex. **[read]**, not
watched in a running window.

**Banner — `src/components/NewSession.tsx:80-85`.** Gated on `preferences.loaded && catalogLoaded`,
and the wording now depends on the mode:

| condition | message |
|---|---|
| custom mode | unchanged: "The selected execution settings are unavailable. …" |
| auto mode, no providers | "No provider CLI is connected. Install Claude Code or Codex and reopen." |
| auto mode, provider present but blocked | "The connected provider is unavailable. Check its CLI, or open execution settings to choose another provider." |

The third row is not in the original order for this work, which asked for one auto-mode sentence.
It is there because auto mode is also reached with a registered `claude-code` driver and
`disabled` (the `claudeError` probe failure, `src/App.tsx:1286`) true — telling that user to
install Claude Code would be false in front of an installed binary.

**Rust — `src-tauri/src/provider_catalog.rs`.** The command takes an `AppHandle` alongside its
`State` and answers immediately from the registered drivers and the capability caches;
`refresh_behind_the_answer` spawns `discover` plus the Codex refresh on the Tauri runtime instead,
and emits `provider-catalog-refreshed` when that task ends. The one non-command caller,
`src-tauri/src/peers.rs:748`, passes the handle it already holds. An `AtomicBool` claim, released by a `Drop` guard so a panic
cannot wedge it, keeps one refresh in flight no matter how many reads arrive;
`orchestration::discover` keeps its own global mutex, untouched. The client's retry is what turns
the background result into a visible catalogue.

Two consequences worth stating rather than hiding:

- The Codex usage window and model list now land **one read late** — the read that spawns the
  refresh returns the previous cache. The hook's retry and the focus re-read cover it.
- `src-tauri/src/peers.rs:748` calls this command to build the peer-settings payload and no longer
  awaits discovery either. On a cold cache it can serve an empty or partial catalogue where it
  used to block. Not exercised here **[not checked]**.

**Not done: persisting the capability map.** The order allowed swapping the in-memory `OnceLock`
for a data-dir file if it came in under ~60 lines. It was left in memory. The banner is fixed by
the two changes above, and a persisted model list is a *stale* model list: it would survive a CLI
upgrade, a re-login, or an account whose model access changed, and the first launch after any of
those would offer models the binary no longer accepts. The cost it saves is one 719 ms handshake
per launch that now happens behind the UI. If it is ever wanted, the invalidation key is the
`claude` binary path plus its `--version`, not an mtime.

## 4. Tests

- `src/providerCatalog.test.ts` — 11 cases: unloaded until the first resolve; the 300/900/1500/1500
  schedule asserted gap by gap with `loaded` false throughout; retry stops the moment a provider
  appears; no retry on a complete first read; a provider with `modelCatalogKnown: false` is
  retried; a rejection is held until the budget is spent; `focus` re-reads and restores the budget;
  `provider-catalog-refreshed` re-reads after the budget is spent; the 15 s poll runs while
  unsettled and stops on settle; a burst of focus events and emits does not stack reads; unmount
  unsubscribes and stops every timer.
- `src/components/NewSession.test.tsx` — 4 cases: silent while the catalogue is unsettled; the
  install sentence once it settles empty; silent with a provider; the blocked-provider sentence
  instead of the install sentence.
- `src-tauri/src/provider_catalog.rs` — two unit tests: a second read cannot start a second refresh
  and the claim comes back when the guard drops; and a refresh that just finished refuses the next
  claim, which is the loop-breaker above.

No test covers the Rust command end to end: it takes `State<AppState>`, which needs a built app,
and nothing in `src-tauri` builds one today **[read]**. That the response no longer waits on
`discover` is a claim from the source, **not a measurement**.
