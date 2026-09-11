# External-API facts behind the efficiency and rendering plan

Verification pass for `docs/plans/efficiency-and-rendering-plan-2026-09-11.md` §3, §4, P1, P3, P5, P7.
All web sources accessed **2026-09-11**. Local commands run **2026-09-11** on Darwin 25.6.0, in
`/Users/stephen/Development/brigadier-ai`.

Tags: **[documented]** = quoted from a primary doc/source at the cited URL. **[measured]** = I ran the
command or read the file on this machine. **[asserted]** = inference or secondary source; not proven.

---

## 1. `notify` crate

**1.1 Latest versions.** [measured, crates.io API]
`notify` max stable **8.2.0**; newest overall **9.0.0-rc.5**, published 2026-08-30 — a pre-release, so
`notify = "8"` resolves to 8.2.0. `notify-debouncer-full` max stable **0.7.0** (newest `0.8.0-rc.2`),
`notify-debouncer-mini` **0.7.0**, `notify-types` **2.1.0`.
Source: `https://crates.io/api/v1/crates/{notify,notify-debouncer-full,notify-debouncer-mini,notify-types}`.
`notify` is **not** in this repo's `Cargo.lock` today [measured: `grep -n '^name = "notify' Cargo.lock` → no match].

**1.2 macOS backend.** [documented]
`https://docs.rs/notify/latest/src/notify/lib.rs.html` —

```rust
#[cfg(all(target_os = "macos", not(feature = "macos_kqueue")))]
pub type RecommendedWatcher = FsEventWatcher;
```

and `KqueueWatcher` only under `all(target_os = "macos", feature = "macos_kqueue")`. The crate docs list
`macos_fsevent` as "enabled by default, for fsevent backend on macos". **Default on macOS is FSEvents.**

**1.3 FSEvents subtree exclusion.** [documented + measured]
Apple provides `FSEventStreamSetExclusionPaths(FSEventStreamRef, CFArrayRef)` — from the SDK header
`$(xcrun --show-sdk-path)/System/Library/Frameworks/CoreServices.framework/Frameworks/FSEvents.framework/Headers/FSEvents.h`
lines 1419–1435 [measured]:

> "Sets directories to be filtered from the EventStream. **A maximum of 8 directories maybe specified.**"
> Availability: macOS 10.9+.

`notify` **never calls it**: no occurrence of `SetExclusionPaths` in `notify/src/fsevent.rs` on the
`notify-8.2.0` tag or on `main` [measured: `curl … | grep`]. **Therefore, with `notify`, excluding
`node_modules`/`target` is post-hoc callback filtering only, not an OS-level exclusion.** The plan's
sentence "Filtering a callback does not prove that the OS watcher avoided traversing that subtree" is
correct and, for `notify`, is settled: the OS watcher does not avoid it.
(Whether the 8-path cap and `FSEventStreamSetExclusionPaths` would suffice for a hand-rolled stream is
**asserted-untested** here; it would require dropping `notify` or patching it.)

**1.4 Rescan — the real name.** [documented]
Both spellings in the plan are real:
- Enum variant `notify::event::Flag::Rescan` — `https://docs.rs/notify/latest/notify/event/enum.Flag.html`:
  > "Rescan notices are emitted by some platforms (and may also be emitted by Notify itself). They
  > indicate either a lapse in the events or a change in the filesystem such that events received so far
  > can no longer be relied on to represent the state of the filesystem now." … "An application that
  > keeps an in-memory representation of the filesystem will need to care, and will need to refresh that
  > representation directly from the filesystem."
- Convenience method `Event::need_rescan()` exists on `notify::event::Event`
  [measured: present in the method list at `https://docs.rs/notify/8.2.0/notify/event/struct.Event.html`
  and `https://docs.rs/notify-types/latest/notify_types/event/struct.Event.html`].

How it is produced on macOS [documented, `notify-8.2.0/notify/src/fsevent.rs` lines 116–117]:

```rust
if flags.contains(StreamFlags::MUST_SCAN_SUBDIRS) {
    let e = Event::new(EventKind::Other).set_flag(Flag::Rescan);
```

annotated `"rescan: user dropped"` or `"rescan: kernel dropped"`. Apple's header (lines 398–414)
[measured] says `kFSEventStreamEventFlagUserDropped`/`KernelDropped` accompany `MustScanSubDirs` to say
where buffering failed, and:

> "the client **must do a full scan** of any directories (and their subdirectories, recursively) being
> monitored by this stream. If you asked to monitor multiple paths with this stream then you will be
> notified about all of them."

So a rescan is **stream-wide, not path-scoped**. A P3 design that maps a rescan to "the affected root"
must treat every root sharing that stream as dirty.

**1.5 Watched-root delete/rename — a real gap in 8.2.0.** [documented, and this contradicts the plan]
Apple header lines 437–448 [measured]:

> `kFSEventStreamEventFlagRootChanged` … "Events with this flag set will **only** be sent if you passed
> the flag `kFSEventStreamCreateFlagWatchRoot` to `FSEventStreamCreate…()` when you created the stream."

`notify` **8.2.0 never passes `WatchRoot`**. The only create-flags site is
`notify-8.2.0/notify/src/fsevent.rs:301`:

```rust
flags: fs::kFSEventStreamCreateFlagFileEvents | fs::kFSEventStreamCreateFlagNoDefer,
```

and `grep -i 'watchroot\|watch_root'` over that file returns nothing [measured]. The crate's
`ROOT_CHANGED` handling at lines 137–142 is therefore unreachable for streams it creates.
`notify` **`main` (9.0.0-rc) does** pass it — `fsevent.rs:396`: `| fs::kFSEventStreamCreateFlagWatchRoot`
[measured].
**Consequence: on notify 8.2.0 + macOS, a renamed or deleted watched root produces no root-changed
signal.** The crate docs only say: "If you want to receive an event for a deletion of folder `b` for the
path `/a/b/..`, you will have to watch its parent `/a`"
(`https://docs.rs/notify/latest/notify/`). P3 needs either the parent-watch workaround, the 9.0.0-rc, or
an explicit existence re-check.

**1.6 FSEvents latency.** [documented + measured]
Apple header lines 764–768 [measured]: the `latency` argument is

> "The number of seconds the service should wait after hearing about an event from the kernel before
> passing it along to the client via its callback. Specifying a larger value may result in more effective
> temporal coalescing, resulting in fewer callbacks and greater overall efficiency."

`notify` 8.2.0 hardcodes `latency: 0.0` with `kFSEventStreamCreateFlagNoDefer`
(`fsevent.rs:300–301`) [measured]. `NoDefer` means the first event of a burst is delivered immediately
(header lines 224–236) [measured]. **There is no OS-level coalescing window on notify 8.2.0** —
`Config::with_fsevent_latency` is a **9.0.0-rc.5 feature only**
(`https://raw.githubusercontent.com/notify-rs/notify/main/notify/CHANGELOG.md`: "FEATURE: [macOS] add
`Config::with_fsevent_latency` to configure FSEvents stream latency [#930]", under `notify 9.0.0-rc.5`)
[documented]. Coalescing on 8.2.0 must be done in Rust.

**1.7 Debouncers.** [documented] `https://docs.rs/notify/latest/notify/`:
> "If you want debounced events (or don't need them in-order), see notify-debouncer-mini or
> notify-debouncer-full."
Note the parenthesis: the debouncers are documented as **not order-preserving**. Versions in 1.1.

**1.8 `.git` internals and file-level events.** [documented + asserted]
`notify` sets `kFSEventStreamCreateFlagFileEvents`, whose header doc (lines 269–275) [measured] says:

> "Request file-level notifications. Your stream will receive events about individual files in the
> hierarchy you're watching instead of only receiving directory level notifications. **Use this flag with
> care as it will generate significantly more events than without it.**"

So every `.git/index.lock`, `ORIG_HEAD` and `packed-refs` write under a watched root **will** be reported
[asserted — follows from the flag semantics; not separately measured with a running watcher].
**No notify or Apple documentation offers advice about ignoring `.git`.** [documented — absent]
Two self-trigger mitigations do exist in the OS API and are **unused by notify** [measured]:
`kFSEventStreamCreateFlagIgnoreSelf` (0x08) and `kFSEventStreamCreateFlagMarkSelf` (0x20); the header
warns `IgnoreSelf` "does not apply to RootChanged events". P3 must filter git's own writes in Rust.

---

## 2. tokio

**2.1 Current version and the repo's pin.** [measured]
crates.io max stable **1.53.1** (updated 2026-07-20). `Cargo.lock:4671` pins **tokio 1.53.1** — the repo
is already on the current release. Workspace dep is `tokio = { version = "1", features = ["full"] }`
(`Cargo.toml:10`); `full` deliberately excludes `test-util`, noted in `crates/core/Cargo.toml:31`.

**2.2 Minimum versions for the watch APIs.** [documented / measured]
| API | First available | Evidence |
| --- | --- | --- |
| `watch::Receiver::borrow_and_update` | **1.8.0** (2021-07-02) | tokio `CHANGELOG.md` line 3078, under `# 1.8.0` [documented] |
| `watch::Sender::send_modify` | **1.18.0** (2022-04-27) | `CHANGELOG.md` line 2566 [documented] |
| `watch::Receiver::mark_changed` | **1.34.0** (2023-11-19) | present in `docs.rs/tokio/1.34.0/…/watch/struct.Receiver.html`, absent in 1.33.0 [measured, docs.rs bisect]. The changelog entry for 1.34.0 spells it `watch::Receiver::mark_unseen` ([#5962], [#6014], [#6017]) — the method shipped under the `mark_changed` name; the changelog text is stale [asserted] |
| `watch::Receiver::mark_unchanged` | 1.36.0 | `CHANGELOG.md` line 1393 [documented] |

All four are far below 1.53.1: **no version bump is needed for P1/P2.**

**2.3 `changed()` on last-sender-drop.** [documented]
`https://docs.rs/tokio/latest/tokio/sync/watch/struct.Receiver.html`:
> "Waits for a change notification, then marks the current value as seen." … "Returns a `RecvError` if
> the channel has been closed **AND** the current value is seen." … "If the current value in the channel
> has not yet been marked seen when this method is called, the method marks that value seen and returns
> immediately. If the newest value has already been marked seen, then the method sleeps until a new
> message is sent by a `Sender` connected to this `Receiver`, **or until all `Sender`s are dropped**."

This is exactly the property P1 needs ("Last-owner drop must terminate a sleeping receiver without a
permanently retained sender") — and the AND matters: a final value sent just before the last sender drops
is still delivered once before `changed()` starts erroring. P1's "queued-but-unflushed final state" case
is covered by the channel, not by extra machinery.

**2.4 `borrow_and_update` / `mark_changed`.** [documented, same page]
- `borrow_and_update`: "Returns a reference to the most recently sent value and marks that value as seen.
  … Subsequent calls to `changed` will not return immediately until the `Sender` has modified the shared
  value again."
- `mark_changed`: "Marks the state as changed. After invoking this method `has_changed()` returns `true`
  and `changed()` returns immediately, **regardless of whether a new value has been sent**." — the primitive
  for P1's "schedule a single deadline when pending data arrives" and P3's dirty-generation follow-up.

**2.5 `interval` + `MissedTickBehavior::Delay` vs `sleep` in a loop.** [documented]
`https://docs.rs/tokio/latest/tokio/time/enum.MissedTickBehavior.html`:
> **Delay** — "Tick at multiples of `period` from when `tick` was called, rather than from `start`. When
> this strategy is used and `Interval` has missed a tick, instead of scheduling ticks to fire at multiples
> of `period` from `start` (the time when the first tick was fired), it schedules all future ticks to
> happen at a regular `period` from the point when `tick` was called."
> **Burst** (the default) — "Ticks as fast as possible until caught up."

`https://docs.rs/tokio/latest/tokio/time/struct.Interval.html`: `tick()` — "The first tick completes
immediately"; and Interval over a sleep loop "lets you count the time spent between the calls to `sleep`
as well." **The docs do not contain a sentence equating `Delay` to `sleep` in a loop** [documented —
absent]. The equivalence is behaviourally close (period measured from the end of the previous body) but
is **asserted**, and `Delay` still differs in that the first tick is immediate and the timer keeps
running while idle — which is the thing P1 is removing. Prefer an armed `sleep_until`/deadline over an
always-running `interval` for P1; `Delay` is the right knob only for the timers P5 keeps.

**2.6 `Notify::notify_one` permits.** [documented]
`https://docs.rs/tokio/latest/tokio/sync/struct.Notify.html`:
> "If a task is currently waiting, that task is notified. Otherwise, **a permit is stored** in this
> `Notify` value and the next call to `notified().await` will complete immediately consuming the permit."
> "**At most one permit may be stored** by `Notify`. Many sequential calls to `notify_one` will result in
> a single permit being stored."
> `notify_waiters()`: "no permit is stored to be used by the next call to `notified().await`."
> "The `Notified` future is **not** guaranteed to receive wakeups from calls to `notify_one()` if it has
> not yet been polled."

The single stored permit makes `notify_one` a safe wake-up for a "there is pending work" flag (it cannot
lose a wake that arrives between drains), and it coalesces bursts by construction — the alternative design
in P1 is sound. `notify_waiters` is **not** safe for that use: it drops wakes with no registered waiter.

---

## 3. Tauri v2

Repo is on **tauri 2.11.5** (`Cargo.lock:4252`) and `@tauri-apps/api ^2` (`package.json:37`) [measured].

**3.1 Channel ordering.** [documented, but only in the guide]
`https://v2.tauri.app/develop/calling-frontend/`:
> "Channels are designed to be **fast and deliver ordered data**." … "used internally for streaming
> operations such as download progress, child process output and WebSocket messages."

The API reference `https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html` documents the type as only
"An IPC channel" and `send` as "Sends the given data through the channel". **No ordering, buffering,
backpressure, size-limit or drop policy is stated in the API docs.** [documented — absent]

**3.2 How a Channel message actually travels.** [documented, source]
`https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri/src/ipc/channel.rs` — `send` calls
`(self.inner.on_message)(data.body()?)`, and the handler branches on size: a small JSON payload
(< 8192 bytes) and small raw data (< 1024 bytes) go straight through `webview.eval()`; **larger payloads
are parked in a `ChannelDataIpcQueue` keyed by a counter and pulled by the frontend over the fetch
command.** [documented]
Consequences for P5, all **asserted** from that code, not measured:
- The queue is **unbounded** — nothing in `send` blocks or rejects. "Do not replace polling with an
  unbounded IPC queue" (P5) is not satisfied by Channel alone; a bound must be enforced by the PTY
  reader side.
- Ordering is by the counter for queued items, but the small-payload fast path (`eval`) and the queued
  path are different mechanisms. Treat cross-size-boundary ordering as **unverified** and measure it with
  a mixed small/large terminal burst before relying on it.
- Data left in the queue when the Rust-side channel drops can be lost (`Drop` calls `on_drop` only).
  P5's "drain-before-exit reporting" needs its own acknowledgement, not Channel's.

**3.3 `listen()` is async; nothing documents the missed-event pattern.** [documented]
`https://v2.tauri.app/reference/javascript/api/namespaceevent/` — `listen` and `once` each return "A
promise resolving to a function to unlisten to the event"; `emit` is also a promise. The guide adds:
> "If you call `unlisten` synchronously before the Promise resolves, the handler will be removed
> immediately and you won't receive any events."

**There is no documented pattern for events emitted before a listener registers** — no `onceLoaded`, no
buffering note, nothing. [documented — absent] Plan invariant §4.1 ("Subscribe successfully before
fetching the initial snapshot. Await native listener readiness; merely calling an async `listen()` first
is insufficient") is therefore **correct and unsupported by any framework guarantee** — the app must
`await` the listen promise and only then request the snapshot. Nothing else will save it.

**3.4 Event payload serialisation.** [documented]
The guide states event payloads are "always JSON strings" and that the event system "directly evaluates
JavaScript code so it might not be suitable to sending a large amount of data", and that it is "not
designed for low latency or high throughput situations". **Whether serialisation happens once or
per-listener/per-window is not documented** [documented — absent]; treat the per-listener cost as
**asserted-unknown** and measure it if P2 fans one event to many windows.

---

## 4. React 19 `useSyncExternalStore`

Repo is on `react ^19.1.0` (`package.json:47`) [measured].
Source: `https://react.dev/reference/react/useSyncExternalStore`.

**4.1 Cached snapshot requirement.** [documented]
> "The store snapshot returned by `getSnapshot` must be immutable. If the underlying store has mutable
> data, return a new immutable snapshot if the data has changed. **Otherwise, return a cached last
> snapshot.**"

The error, verbatim: **"The result of `getSnapshot` should be cached"**, explained as:
> "React will re-render the component if `getSnapshot` return value is different from the last time. This
> is why, if you always return a different value, you will enter an infinite loop and get this error."

This is the mechanical backing for plan invariant §4.5 ("Unchanged complete snapshots retain identity").

**4.2 Transitions do not apply.** [documented — the plan's claim is confirmed]
> "If the store is mutated during a non-blocking Transition update, React will fall back to performing
> that update as **blocking**. Specifically, for every Transition update, React will call `getSnapshot` a
> second time just before applying changes to the DOM. If it returns a different value than when it was
> called originally, **React will restart the update from scratch, this time applying it as a blocking
> update**, to ensure that every component on screen is reflecting the same version of the store."

and

> "mutations to the external store **cannot** be marked as non-blocking Transition updates, so they will
> trigger the nearest Suspense fallback".

So `startTransition` around an external-store write is not merely ineffective — it can cost an extra
`getSnapshot` and a **restarted, blocking** render. The plan's "`startTransition` is not an external-store
scheduling fix" is right, and understated.

---

## 5. Claude Code CLI

Installed binary: **2.1.268 (Claude Code)** [measured: `claude --version`].

**5.1 Grep uses ripgrep.** [documented]
`https://code.claude.com/docs/en/tools-reference`:
> "Grep is built on ripgrep and uses ripgrep's regex syntax, not POSIX grep."
Also: "Grep respects `.gitignore`, so gitignored files are skipped. To search a gitignored file, Claude
passes its path directly." Output modes `files_with_matches` (default), `content`, `count`; `multiline:
true` for cross-line matches. §3 of the plan and P6's "Claude native Grep already uses it" are correct.

**5.2 Cache tokens in `usage`.** [documented]
`https://code.claude.com/docs/en/agent-sdk/cost-tracking`:
> "`cache_creation_input_tokens`: tokens used to create new cache entries (charged at a higher rate than
> standard input tokens)." / "`cache_read_input_tokens`: tokens read from existing cache entries (charged
> at a reduced rate)."

Two caveats P7 must honour:
- > "Per-step `output_tokens` is a placeholder" — read output tokens from the **result** message.
- > "`usage` … Excluded [subagent activity]. Counts only the top-level agent loop"; use `modelUsage` /
  `model_usage` for whole-tree accounting.
This also gives P7 the "provider cache-read/cache-write telemetry where available" it asks for, for free.

**5.3 `rate_limit_event`.** [measured in-tree; partially documented]
Documented existence: the Agent SDK emits a `RateLimitEvent` carrying `rate_limit_info`, `uuid` and
`session_id` when rate-limit status changes (e.g. `allowed` → `allowed_warning`), per
`https://code.claude.com/docs/en/agent-sdk/python` / `.../typescript` (found via site search; the
rendered reference pages truncate before the type table, so **the full field list was not read**).
**`unifiedWindows` is not named anywhere in the public docs I could fetch** [documented — absent].
It is, however, already measured in this tree: `crates/claude-wire/src/message.rs:81-82` decodes
`rate_limit_event` (citing `sdk.d.ts:4842`), `crates/core/tests/claude_adapter.rs:2028` feeds
`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":…}}`, and
`crates/core/src/claude/capabilities.rs:124` / `crates/core/src/allowance.rs:225` exercise
`unifiedWindows.{five_hour,seven_day}` [measured]. `docs/STATUS.md:591` and `docs/vision.md:175-184`
already record the measured frame. **Treat `unifiedWindows` as measured-in-this-repo, undocumented
upstream** — i.e. unversioned and liable to change.

**5.4 `--bare` exists.** [measured + documented]
Present in the installed help [measured]:
> "--bare  Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches,
> keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. Anthropic auth is strictly
> ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)."

Documented too, with a slightly different list
(`https://code.claude.com/docs/en/cli-reference`, `.../headless#start-faster-with-bare-mode`):
> "skipping auto-discovery of hooks, skills, custom commands, subagents, plugins, MCP servers, auto
> memory, and CLAUDE.md" … "In bare mode Claude has access to the Bash, file read, and file edit tools."
> "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a
> future release."

**The decisive fact for P7: bare mode never reads OAuth credentials or the keychain, so it does not run
on the user's subscription** — it needs `ANTHROPIC_API_KEY` or an `apiKeyHelper`. That is incompatible
with brigadier's settled "runs on the user's own subscription" (CLAUDE.md §2). P7's "No blanket `--bare`"
is right, and the reason is stronger than startup-cost neutrality: it is an auth-model conflict.

**5.5 MCP startup timing — documented, and richer than the plan assumes.** [documented]
`https://code.claude.com/docs/en/agent-sdk/mcp#connection-timing`:

| Server type | Delays the first turn? | First-turn wait timeout |
| --- | --- | --- |
| stdio server, or HTTP/SSE without a cached tool list | **Yes, until it connects** | `MCP_TIMEOUT`, 30 s default; the connection fails at that deadline |
| Remote server with a cached tool list | No; cached tools available from the first turn | none; **connects on its first tool call** |
| In-process SDK server | No; never delays the first turn | none |

Plus two documented knobs:
> "Set `MCP_CONNECTION_NONBLOCKING` to `0` to block on the whole connection batch. Claude Code caps that
> wait at 5 seconds by default. Adjust the cap with `MCP_CONNECT_TIMEOUT_MS` … Servers still pending at
> that deadline keep connecting in the background."
> "Set `alwaysLoad: true` on a server's config to make its tools available at their full schemas on the
> first turn, exempt from tool search deferral."

And `https://code.claude.com/docs/en/cli-reference` on `--mcp-config`:
> "When you pass this flag with `-p`, Claude Code waits for still-pending servers to connect before
> running the first turn, up to the `MCP_TIMEOUT` startup timeout, 30 seconds by default; a server with a
> cached tool list skips the wait and connects on first use. The wait requires Claude Code v2.1.221 or
> later."

**There is no flag that defers MCP process startup.** [documented — absent] MCP **tool search** ("enabled
by default … withholding tool definitions from context and loading only the ones Claude needs") is a
*context* optimisation; it does not stop a stdio server's process from starting. The plan's §3 line "MCP
schema deferral does not necessarily defer process startup" is **confirmed**. The only documented
deferral is the *remote-server-with-cached-tool-list* path — irrelevant to local stdio servers.
`--strict-mcp-config` is in the installed help ("Only use MCP servers from --mcp-config, ignoring all
other MCP configurations") [measured] but **is not on the public CLI reference page** [documented —
absent]; `crates/core/src/claude/process.rs` pins it, so this is a supported-but-undocumented surface.

---

## 6. git worktree discovery

git **2.50.1 (Apple Git-155)** [measured]. All of the following run on this repo, 2026-09-11.

**6.1 `.git` is a file in a linked worktree.** [measured]
```
$ file /Users/stephen/Development/brigadier-ai.worktrees/codex-thread/.git
… ASCII text
$ cat …/.git
gitdir: /Users/stephen/Development/brigadier-ai/.git/worktrees/codex-thread
```
In the main checkout `.git` is a directory. P3's "not an assumption that `.git` is a directory" is
correct and now measured in this tree.

**6.2 Admin dir vs common dir.** [measured]
In the linked worktree:
```
$ git rev-parse --git-dir          → /Users/stephen/…/brigadier-ai/.git/worktrees/codex-thread
$ git rev-parse --git-common-dir   → /Users/stephen/…/brigadier-ai/.git
```
Both already absolute here because the worktree is elsewhere; **do not rely on that** — in the main
checkout both return the relative string `.git` [measured]. Force absolute with the option **before** the
queries: `git rev-parse --path-format=absolute --git-dir --git-common-dir` [measured, works].

**6.3 The correct per-file resolver.** [measured]
`git rev-parse --git-path <name>` picks per-worktree vs common automatically — exactly what P3 needs so it
does not have to encode the split itself:
```
--git-path HEAD        → …/.git/worktrees/codex-thread/HEAD     (per-worktree)
--git-path index       → …/.git/worktrees/codex-thread/index    (per-worktree)
--git-path packed-refs → …/.git/packed-refs                     (common)
--git-path config      → …/.git/config                          (common)
```

**6.4 Enumerating worktrees.** [measured]
`git worktree list --porcelain` emits a blank-line-separated record per worktree with `worktree <abs
path>`, `HEAD <sha>`, and then `branch refs/heads/<name>` **or** `detached`; a locked worktree adds a
`locked <reason>` line (Supacode stores JSON there). Output on this machine included three worktrees, one
detached and two locked.

---

## 7. macOS process lifetime

**7.1 A process group does not contain a grandchild that calls `setsid`.** [documented, `man 2 setsid`]
> "The setsid function creates a new session. The calling process is the session leader of the new
> session, is the process group leader of a new process group and has no controlling terminal. **The
> calling process is the only process in either the session or the process group.**"

And `man 2 kill`:
> "if the process number is negative but not -1, the signal is sent to all processes whose process group
> ID is equal to the absolute value of the process number."

Together: `kill(-pgid, …)` reaches only processes still **in** that group. A grandchild that calls
`setsid()` (or `setpgid()` — `man 2 setpgid`: "setpgid() sets the process group of the specified process
pid to the specified pgid") has left it and **will not be signalled**. P8's "A macOS process group does
not automatically guarantee cleanup of descendants that detach" is **correct and documented**. Note
`setsid()` fails with `EPERM` if the caller is already a process-group leader — so a child the harness
already put in its own group cannot `setsid()` itself away without an intervening fork [documented].

**7.2 There is no `PR_SET_PDEATHSIG` on macOS.** [asserted — absence; `prctl` is Linux-only and no Darwin
man page for it exists on this machine]. The documented substitute is kqueue, `man 2 kqueue`:
> "`EVFILT_PROC` — Takes the process ID to monitor as the identifier and the events to watch for in
> fflags, and returns when the process performs one or more of the requested events. **If a process can
> normally see another process, it can attach an event to it.**"
> "`NOTE_EXIT` — The process has exited."
> "`NOTE_EXITSTATUS` — The process has exited and its exit status is in filter specific data. **Valid only
> on child processes** and to be used along with `NOTE_EXIT`."
> `NOTE_FORK`, `NOTE_EXEC` also available.

So a child can register `EVFILT_PROC|NOTE_EXIT` on the **parent's** pid and self-terminate on parent
death — the documented macOS kill-on-parent-death mechanism. Caveats, all **asserted**: it requires code
inside the child (the `claude` binary will not do this for us), it is a notification not a kernel-enforced
kill, and there is a pid-reuse race between fork and registration. `NOTE_FORK`/`NOTE_EXEC` could in
principle track a descendant tree, but that is a supervision design, not a guarantee. P8's "Immediate
force-quit cleanup requires an independently surviving mechanism and a separate verified design" stands.

---

## What this contradicts, or hardens, in the plan

1. **P3 / §4 — `need_rescan` is stream-wide, not root-scoped.** Apple documents `MustScanSubDirs` as
   requiring a full scan of *all* paths on that stream. "invalidate the affected cache broadly" is right;
   any per-root narrowing of a rescan is wrong. (§1.4)
2. **P3 — on notify 8.2.0, a renamed/deleted watched root emits nothing.** The crate never passes
   `kFSEventStreamCreateFlagWatchRoot`, so `RootChanged` cannot arrive. "root rename/delete … invalidate
   broadly" has no event to fire on. Either pin `notify = "9.0.0-rc"` (pre-release, MSRV 1.88, edition
   2024), watch the parent directory, or poll existence. (§1.5)
3. **P3 — "Measure native watch behavior" has a known answer: notify cannot exclude subtrees at the OS
   level.** `FSEventStreamSetExclusionPaths` exists (max 8 directories) but notify never calls it. Every
   `node_modules`/`target` event is delivered and filtered in Rust. Budget for that, or don't claim an
   OS-level exclusion. (§1.3)
4. **P3 — there is no coalescing latency to tune on notify 8.2.0.** `latency: 0.0` + `NoDefer` are
   hardcoded; `Config::with_fsevent_latency` is 9.0.0-rc only. All storm coalescing is P3's own code.
   (§1.6)
5. **P3 — git's own writes will be reported, and notify leaves the two OS mitigations unused.** No
   documentation anywhere advises on ignoring `.git`; `IgnoreSelf`/`MarkSelf` are available in the OS API
   but not through notify. Self-trigger suppression is entirely P3's problem. (§1.8)
6. **P1 — `MissedTickBehavior::Delay` is not documented as equivalent to `sleep` in a loop.** The claim is
   asserted, and `interval` still runs a timer while idle, which is the thing P1 removes. Use an armed
   deadline; reserve `Delay` for the timers P5 keeps. (§2.5)
7. **P1 — tokio needs no version work.** Every watch API the plan names shipped by 1.36.0; the repo is on
   1.53.1, the current release. And `changed()`'s documented "closed AND current value is seen" already
   delivers the final pre-drop value, so P1's "queued-but-unflushed final state" is a channel property,
   not new machinery. (§2.2, §2.3)
8. **P5 — `tauri::ipc::Channel` documents *ordering* in a guide sentence and nothing else.** No
   backpressure, no bound, no size limit, no drop policy in the API docs; the source shows an unbounded
   `ChannelDataIpcQueue` for payloads over ~8 KiB and a separate `eval()` fast path for small ones. P5's
   "Do not replace polling with an unbounded IPC queue" is **not satisfied by using a Channel** — the
   bound must live in the PTY reader. Ordering across the size boundary is unverified; measure it.
   (§3.1, §3.2)
9. **§4 invariant 1 is correct and stands alone.** Tauri documents `listen` as promise-returning and says
   nothing about events emitted before registration — no buffering, no replay, no recommended pattern.
   Awaiting the listen promise before requesting the snapshot is the only remedy. (§3.3)
10. **P4 — the React claim is confirmed and understated.** `startTransition` is not just ineffective for
    external stores; a store mutation during a Transition makes React call `getSnapshot` a second time and
    **restart the update as blocking**. (§4.2)
11. **P7 — `--bare` is not merely "not a full-capability optimisation": it breaks the auth model.** Bare
    mode never reads OAuth or the keychain and requires `ANTHROPIC_API_KEY`/`apiKeyHelper`, which
    contradicts the settled "runs on the user's own subscription". Rule it out on that ground. (§5.4)
12. **P7 / §3 — "MCP schema deferral does not necessarily defer process startup" is now documented, and
    the picture is sharper than the plan's hedge.** A stdio server always connects and always delays the
    first turn (up to `MCP_TIMEOUT`, 30 s). The only documented deferral is a *remote* server with a
    cached tool list. `MCP_CONNECTION_NONBLOCKING=0` / `MCP_CONNECT_TIMEOUT_MS` / `alwaysLoad` are the
    real knobs, and none of them stop a local process from starting. (§5.5)
13. **P7 — provider cache telemetry is available and its shape has two traps.** `cache_read_input_tokens`
    and `cache_creation_input_tokens` are documented, but per-step `output_tokens` is a placeholder and
    `usage` excludes subagents — use the result message and `modelUsage`. (§5.2)
14. **`unifiedWindows` is measured in this repo, not documented upstream.** The public docs name
    `RateLimitEvent`/`rate_limit_info` but never `unifiedWindows`. It is an unversioned surface; keep the
    decoder tolerant. (§5.3)
15. **P3 — git discovery has a better primitive than the plan names.** `git rev-parse --git-path <name>`
    resolves per-worktree vs common automatically; P3 does not need to encode the HEAD/index-vs-refs/config
    split itself. Add `--path-format=absolute` **before** the queries — in a main checkout `--git-dir` and
    `--git-common-dir` both return the relative string `.git`. (§6.2, §6.3)
16. **P8 — the process-group gap is documented, and so is the substitute.** `setsid(2)` makes the caller
    "the only process in either the session or the process group", and `kill(-pgid)` reaches only current
    members; `EVFILT_PROC|NOTE_EXIT` on the parent pid is the macOS kill-on-parent-death mechanism, but it
    requires cooperating code inside the child, which the `claude` binary does not provide. (§7)

### What I did not check

- No running `notify` watcher was built or measured; §1.3/§1.8 event-volume claims are read off the API
  contract, not observed.
- The `RateLimitEvent`/`RateLimitInfo` **field table** was not read: both rendered SDK reference pages
  truncate before the type definitions. `unifiedWindows` is backed only by this repo's own recorded
  frames.
- No `claude -p` invocation was run (that would be live spend); §5 rests on `--version`, `--help` and the
  public docs.
- Tauri Channel ordering across the small/large payload boundary was read from source, not measured.
- `FSEventStreamSetExclusionPaths` behaviour with `kFSEventStreamCreateFlagFileEvents` is undocumented in
  the header and untested here.
