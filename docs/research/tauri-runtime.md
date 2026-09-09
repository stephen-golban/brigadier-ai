> **Status (2026-09-09): §1 and §2 are HISTORY, OVERRIDDEN by `CLAUDE.md` §3 "The sidecar is
> dead".** There is no Node sidecar and none is planned; Rust speaks the Claude Code CLI's stdio
> control protocol directly (`docs/research/claude-direct-spike.md`). Read the sidecar API notes
> for history only — never as an instruction to add one; the bun recipe, if it is ever needed
> again, is in `docs/research/sidecar-spike.md`.
> **§3–§4 (Rust → webview streaming, the `@tauri-apps/api` frontend) are live and required
> reading for the bb thread port** (`docs/plans/bb-thread-port-2026-09-09.md` §0.5 names §4), and
> §6 (git worktrees) is live too. Only the sidecar half is dead. Do not reopen it.

# Tauri v2 runtime: sidecar supervision, IPC streaming, worktrees

Date: 2026-09-02. Scope: what the session supervisor needs from Tauri, tokio and git.
Assumes `sidecar-spike.md` (bundling, bun, SDK landmines) and `substrate.md` (rAF coalescing,
virtualization, DOM is the wall). Nothing here repeats those.

Tags: **[docs]** vendor documentation · **[source]** read in the crate/package source ·
**[asserted]** reasoned, not directly verified.

## Versions verified

| Thing | Version | How |
|---|---|---|
| `tauri` | 2.11.5 | `src-tauri/Cargo.lock`; crates.io `max_stable_version` = 2.11.5 **[source]** |
| `tauri-runtime` / `tauri-runtime-wry` / `wry` | 2.11.3 / 2.11.4 / 0.55.1 | `src-tauri/Cargo.lock` **[source]** |
| `tauri-utils` | 2.9.3 | `src-tauri/Cargo.lock` **[source]** |
| `tauri-build` | 2.6.3 | `src-tauri/Cargo.lock` **[source]** |
| `tauri-plugin-shell` | **2.3.6** (latest; not yet a dependency) | crates.io API **[source]** |
| `tokio` | 1.53.1 (transitive today) | `src-tauri/Cargo.lock` **[source]** |
| `@tauri-apps/api` | 2.11.1 installed, 2.11.1 latest | `node_modules/@tauri-apps/api/package.json` **[source]** |
| `@tauri-apps/cli` | 2.11.4 latest | npm **[source]** |
| `@tauri-apps/plugin-shell` | 2.3.6 latest | npm **[source]** |
| `git2` | 0.21.0 | crates.io **[source]** |
| `gix` / `gix-worktree` | 0.87.1 / 0.56.0 | crates.io **[source]** |
| `git` (this machine) | 2.50.1 (Apple Git-155) | `git --version` **[source]** |

Source paths below are from the published `.crate` tarballs; each is also readable at
`https://docs.rs/<crate>/<version>/src/<crate_underscored>/<path>.html#<line>`.

## 1. `tauri-plugin-shell` sidecar API (2.3.6)

- `ShellExt::sidecar(&self, program: impl AsRef<Path>) -> Result<Command>` → `Command::new_sidecar`; takes the **filename only**, not the `externalBin` path. `src/lib.rs:67` **[source]**, **[docs]** v2.tauri.app/develop/sidecar/
- Sidecar path resolution is `platform::current_exe()?.parent()` joined with the name; the `deps/` dir gets one extra `..`; on non-Windows a `.exe` extension is stripped. `src/process/mod.rs:120-153` **[source]**
- Builder methods are all `#[must_use]` by-value: `.arg`, `.args`, `.env`, `.envs`, `.env_clear`, `.current_dir`, `.set_raw_out(bool)`. `src/process/mod.rs:185-244` **[source]**
- There is **no** `.stdin/.stdout/.stderr`, no `.process_group`, no `.pre_exec`, no `.kill_on_drop`. `Command` → `StdCommand` is one-way (`impl From<Command> for StdCommand`), so you cannot reach the inner `std::process::Command` before spawn. `src/process/mod.rs:155-159` **[source]**
- `spawn(self) -> Result<(Receiver<CommandEvent>, CommandChild)>`. `src/process/mod.rs:305` **[source]**
- The receiver **is a tokio mpsc receiver**: `tauri::async_runtime` re-exports `tokio::sync::mpsc::{channel, Receiver, Sender}` verbatim. `tauri-2.11.5/src/async_runtime.rs:13-19` **[source]**
- **Channel capacity is 1.** `let (tx, rx) = channel(1);` — one in-flight event, per child. `src/process/mod.rs:320` **[source]**
- `CommandEvent` is `#[non_exhaustive]` with exactly four variants: `Stdout(Vec<u8>)`, `Stderr(Vec<u8>)`, `Error(String)`, `Terminated(TerminatedPayload)`. `src/process/mod.rs:41-54` **[source]**
- `TerminatedPayload { code: Option<i32>, signal: Option<i32> }`; `signal` is always `None` on Windows and `status.signal()` on unix. `src/process/mod.rs:31-38`, `:342-349` **[source]**
- Stdout is **`Vec<u8>`, line-split, not raw**, by default. `set_raw_out(true)` switches to raw `fill_buf` chunks. `src/process/mod.rs:490-507` **[source]**
- The line splitter is `tauri_utils::io::read_line`: it scans the buffered chunk for `\n` first, else `\r`, and **includes the terminator byte in the returned buffer**. So `Stdout` payloads end in `\n`; trim before `serde_json::from_slice`. `tauri-utils-2.9.3/src/io.rs:12-46` **[source]**
- Consequence: `\r` only acts as a separator when no `\n` exists in the same `fill_buf` chunk, so CR-containing output splits nondeterministically. Irrelevant for NDJSON (JSON escapes `\r` as `\\r`). **[source]** + **[asserted]**
- Lines longer than the `BufReader` capacity are accumulated correctly (`read_line` loops and grows `buf`), so a multi-megabyte NDJSON line is not truncated. `tauri-utils-2.9.3/src/io.rs:14-44` **[source]**
- **`encoding` is not applied on the Rust path at all.** The plugin re-exports `encoding_rs::Encoding` and the doc example asks you to call `encoding.decode(&line)` yourself. The `encoding` option (`"raw"` or an encoding label) exists only on the JS `spawn`/`execute` commands. `src/process/mod.rs:25`, `:279-304`; `src/commands.rs:38-46`, `:158-175` **[source]**
- Three OS threads per child: one `std::thread` per pipe reader plus one for `child.wait()`. **N sessions = 3N blocking OS threads**, none of them on the tokio pool. `src/process/mod.rs:322-357`, `:497` **[source]**
- Each reader thread calls `tauri::async_runtime::block_on(tx.send(..))` per line — a full block_on per NDJSON line into a capacity-1 channel. That is the throughput ceiling of this path. `src/process/mod.rs:479` **[source]**
- Backpressure is real and correct: reader thread blocks → OS pipe fills (64 KB) → the child blocks on `write`. No events are dropped. **[source]** + **[asserted]**
- **`Terminated` is guaranteed to be the last event.** The `wait()` thread takes `guard.write()`, and both reader threads hold `guard.read()` for their whole lifetime, so `Terminated` cannot be sent until stdout and stderr have hit EOF. `src/process/mod.rs:318`, `:337-341`, `:498` **[source]**
- Corollary and landmine: if the sidecar leaks its stdout/stderr pipe to a grandchild, EOF is deferred until the grandchild exits, so `Terminated` is deferred with it. **[asserted]**
- `Terminated` fires on crash (`wait()` returns a signal status) and on `kill()` (SIGKILL → `signal: Some(9)`). If `wait()` itself errors you get `CommandEvent::Error(String)` instead and never a `Terminated`. `src/process/mod.rs:337-356` **[source]**
- `CommandChild::write(&mut self, buf: &[u8]) -> Result<()>` — synchronous `write_all` on an `os_pipe::PipeWriter`; blocking, and it will block the calling thread if the child is not reading. `src/process/mod.rs:72-75` **[source]**
- `CommandChild::kill(self)` **consumes self** — after a kill you no longer hold a handle, so you cannot `write` or read `pid`. Keep the pid before killing. `src/process/mod.rs:78-81` **[source]**
- `kill()` is `SharedChild::kill()` on the single pid — it does **not** kill a process group or any grandchildren. `src/process/mod.rs:78-81` **[source]** + **[asserted]** (`shared_child` 1.x)
- `CommandChild::pid(&self) -> u32`. `src/process/mod.rs:84-86` **[source]**
- No `CommandChild::wait()`; the only completion signal is the `Terminated` event. `src/process/mod.rs:70-87` **[source]**
- `Command::status()` / `Command::output()` exist but drain the whole stream, so they are useless for streaming. `src/process/mod.rs:381`, `:408` **[source]**
- Spawning a sidecar from Rust needs **no capability entry**: `ShellExt::sidecar` builds a `Command` directly and never consults `ShellScope`. Only the JS `plugin:shell|spawn`/`execute` commands take `CommandScope`/`GlobalScope`. `src/lib.rs:63-69` vs `src/commands.rs:104-140`, `:236-246` **[source]**; matches **[docs]** v2.tauri.app/develop/sidecar/
- You must still register the plugin (`.plugin(tauri_plugin_shell::init())`) and add `tauri-plugin-shell = "2"` to `Cargo.toml`; nothing else. `src/lib.rs:103` **[source]**

### Known issues (tauri-apps GitHub, verified open/closed state via `gh api` 2026-09-02)

- plugins-workspace **#2152** (open) — *"Buffer of `Reciever<CommandEvent>` from `Command::new_sidecar::spawn` clogs if events go unhandeled"*: an undrained receiver stalls and can kill the sidecar. This is the capacity-1 channel observed from the outside; no issue names the `channel(1)` constant itself. https://github.com/tauri-apps/plugins-workspace/issues/2152 **[source]**
- plugins-workspace **#1632** (open) — *"[shell] Flushed data from spawned process is not sent to JS unless it ends in a newline"*: matches `read_line`'s behaviour exactly — a partial line is held until a `\n`/`\r` or EOF. Harmless for NDJSON, fatal for any prompt-style protocol. https://github.com/tauri-apps/plugins-workspace/issues/1632 **[source]**
- plugins-workspace **#1471** (open) — *"[bug][shell][v2]: incorrect stdout encoding"*: characters lost from Rust-side `CommandEvent::Stdout` on Windows when the child writes non-UTF-8 console output. Confirms that no decoding happens on the Rust path (§1). https://github.com/tauri-apps/plugins-workspace/issues/1471 **[source]**
- plugins-workspace **#3090** (open) — *"feat: allow collecting raw output from sidecars"*: `Command::output()` re-inserts `\n` between chunks, corrupting binary output. https://github.com/tauri-apps/plugins-workspace/issues/3090 **[source]**
- plugins-workspace **#3461** (open) — *"[shell] JavaScript errors thrown by stdout/stderr handlers fail silently"*: a throwing JS handler silently stops further reads. JS path only. https://github.com/tauri-apps/plugins-workspace/issues/3461 **[source]**
- tauri **#3508** (closed) — *"Receiver coming from `Command::spawn()` never gets stdout if child process uses output clearing"*: `rx.recv()` never resolves for a child that rewrites its line instead of emitting `\n`; everything dumps at exit. Same root cause as #1632. https://github.com/tauri-apps/tauri/issues/3508 **[source]**
- plugins-workspace **#1332** (open) — *"[shell] Add option to spawn command in process group"*: the feature we need for reliable teardown does not exist in the plugin. https://github.com/tauri-apps/plugins-workspace/issues/1332 **[source]**
- tauri **#14360** (open) — *"[feat] Add kill tree for sidecar"*: killing a sidecar leaves grandchildren orphaned; process-tree kill is requested, not shipped. Directly our `sidecar → claude` shape. https://github.com/tauri-apps/tauri/issues/14360 **[source]**
- tauri **#10377** (closed) — *"Sidecar not killed on app exit on Windows"*. https://github.com/tauri-apps/tauri/issues/10377 **[source]**
- **Negative results** (searched, nothing found): no issue about `CommandEvent::Terminated` failing to fire or firing late; no issue about `tauri::ipc::Channel` throughput, performance or ordering; no issue about `\r` vs `\n` splitting. Two GitHub search calls hit a 403 rate limit mid-run and were retried, so the `\r`/`\n` sweep is the least complete of the three. **[asserted]**

## 2. Alternative: `tokio::process::Command` on the resolved path

- **The sidecar path is obtainable in both dev and bundled builds, and it is next to the executable — not the resource dir.** `tauri-build`'s build script copies every `externalBin` into the cargo target dir, stripping the `-<target-triple>` suffix. Dev and release both. `tauri-build/src/lib.rs:58-87` and its call site (`copy_binaries(..., target_dir, ...)`) **[source]**
- So the correct Rust expression is `tauri::utils::platform::current_exe()?.parent().unwrap().join("sidecar")` — exactly what the plugin does internally. `tauri-plugin-shell-2.3.6/src/process/mod.rs:120-153` **[source]**
- **`app.path().resource_dir()` is the wrong directory on macOS**: it resolves to `${exe_dir}/../Resources`, whereas sidecars are staged in `Contents/MacOS/` next to the binary. `tauri-2.11.5/src/path/desktop.rs:224-233` **[source]**
- `tauri::utils::platform::current_exe()` is a snapshot of the starting binary (`STARTING_BINARY`), hardened against later `argv[0]`/symlink games and AppImage-aware; prefer it over `std::env::current_exe()`. `tauri-utils-2.9.3/src/platform.rs:172-174` **[source]**
- `tauri-build` refuses a sidecar whose filename equals the cargo package name (`brigadier`). Name it something else. `tauri-build/src/lib.rs:73-78` **[source]**
- `tokio::process::Command` (tokio 1.53.1) has `process_group(i32)` (unix; `0` = new group with pgid = pid), `pre_exec`, `kill_on_drop(bool)`, `uid`/`gid`, plus the usual `arg/args/env/envs/current_dir/stdin/stdout/stderr`. **[docs]** https://docs.rs/tokio/1.53.1/tokio/process/struct.Command.html
- `kill_on_drop` docs warn it cannot reap synchronously; tokio reaps "on a best-effort basis... no additional guarantees", and recommends `child.wait().await` / `child.kill().await` instead of relying on drop. **[docs]** same page
- **Cleaner for backpressure: tokio, decisively.** With `BufReader::new(child.stdout.take()).lines()` (or `read_until(b'\n')`) you own the buffer size, you can batch N lines per poll, you never pay a `block_on` per line, and you use zero extra OS threads per child. The plugin gives you a capacity-1 channel, three OS threads per child, and a `block_on` per line. **[asserted]** from the sources above
- tokio also gets you `process_group(0)` + `killpg` (or `kill(-pgid)`), which is the only way to reliably take down the sidecar *and* the `claude` CLI it spawns. The plugin cannot express this. **[asserted]**
- Neither path needs a capability entry when driven only from Rust; the ACL only guards the JS-facing commands. `tauri-plugin-shell-2.3.6/src/commands.rs:236-246` **[source]**
- Cost of going tokio: you add `tokio = { version = "1", features = ["process", "io-util", "rt-multi-thread", "sync", "macros"] }` as a direct dependency and you re-implement `relative_command_path`'s five lines. That is the whole delta.

## 3. Rust → webview streaming

- Three mechanisms, all of which ultimately reach the webview through `Webview::eval` → `Dispatcher::eval_script`. `tauri-2.11.5/src/webview/mod.rs:1917-1923` **[source]**
- `eval_script` from a non-main thread is `proxy.send_event(Message::Webview(.., EvaluateScript(..)))` — **fire-and-forget into tao's unbounded event-loop queue.** It returns `Ok(())` regardless of whether the UI thread is keeping up. There is no backpressure and no way to observe queue depth. `tauri-runtime-wry-2.11.4/src/lib.rs:235-255`, `:1854-1863` **[source]**
- (With the `tracing` feature enabled, `eval_script` instead uses `getter!`, which blocks the caller on a `std::sync::mpsc` reply. Do not enable `tracing` in a hot streaming path. `tauri-runtime-wry/src/lib.rs:197-204`, `:1839-1851` **[source]**)
- **`tauri::ipc::Channel<T>`** — `Channel::send(&self, data: TSend) -> crate::Result<()>` where `TSend: IpcResponse`; `Channel::id() -> u32`; obtained as a command argument (`fn cmd(on_event: Channel<MyEvent>)`) or from a `JavaScriptChannelId`. `tauri-2.11.5/src/ipc/channel.rs:153-158`, `:148`, `:134` **[source]**
- Serialization: `impl<T: Serialize> IpcResponse for T` does `serde_json::to_string(&self)` **once**, producing `InvokeResponseBody::Json(String)`. `tauri-2.11.5/src/ipc/mod.rs:99-103`, `:181-187` **[source]**
- **No double JSON encoding on the fast path.** The JSON string is interpolated *raw* into JS source — `{{ message: {json_string}, index: {i} }}` — so the JS engine parses it as a literal, not via `JSON.parse` of a quoted string. `tauri-2.11.5/src/ipc/channel.rs:155-162` **[source]**
- **Two size thresholds, with the maintainers' own measurements in the comments:** JSON payloads `< 8192` bytes go through `eval`; raw byte payloads `< 1024` bytes go through `eval`; anything larger is parked in a `ChannelDataIpcQueue` and pulled by the webview over the internal `fetch` command. Comments: *"8192 byte JSON payload runs roughly 2x faster through eval than through fetch on WebView2 v135"* and *"1024 byte payload runs roughly 30% faster through eval than through fetch on macOS"*. `tauri-2.11.5/src/ipc/channel.rs:35-39`, `:154-181` **[source]** — these are the only numeric IPC figures published anywhere in the Tauri tree.
- **`Channel` guarantees ordering, explicitly.** Rust stamps a monotonic `index` per message; the TS `Channel` class delivers `index == nextMessageIndex` immediately and parks anything else in a sparse `pendingMessages` array until the gap fills. `tauri-2.11.5/src/ipc/channel.rs:144-146`, `:189-192`; `@tauri-apps/api/core.js:74-116` **[source]**
- Corollary: one message that crosses the 8 KB threshold takes the slower `fetch` path and **head-of-line blocks every later message**, which pile up unbounded in `pendingMessages`. Staying under 8 KB per message is a latency property, not just a throughput one. **[source]** + **[asserted]**
- Ordering only exists for channels created by `JavaScriptChannelId::channel_on` (i.e. passed as a command argument). `Channel::from_callback_fn` — the internal invoke-response path — sends no index. `tauri-2.11.5/src/ipc/channel.rs:105-145` **[source]**
- Dropping the Rust `Channel` fires an `{ end: true, index }` message and the TS side unregisters the callback. Hold the `Channel` in your supervisor state for the session's lifetime. `tauri-2.11.5/src/ipc/channel.rs:186-192`; `core.js:84-92`, `:117-119` **[source]**
- **`app.emit` / `emit_to`** — `Emitter::emit<S: Serialize + Clone>(&self, event: &str, payload: S)`, `emit_to<I: Into<EventTarget>, S>(target, event, payload)`, plus `emit_str`/`emit_str_to` taking a **pre-serialized `String`**. `tauri-2.11.5/src/lib.rs:933-1000` **[source]**
- Events serialize once (`serde_json::to_string`) and are interpolated into `"(function () { const fn = window['..']; fn && fn({event: '..', payload: <json>}, [ids]) })()"`, then `eval`'d. Again no double encoding — but **events have no fetch fast path, so every event of any size is a JS source string the engine must parse.** `tauri-2.11.5/src/event/mod.rs:124-141`, `:194-206` **[source]**
- Emit also allocates the script once and evals it per matching webview, having filtered listener ids in Rust. `tauri-2.11.5/src/event/listener.rs:269-301` **[source]**
- Tauri's own guidance: *"The event system was designed for situations where small amounts of data need to be streamed... The event system is not designed for low latency or high throughput situations."* and *"Channels are designed to be fast and deliver ordered data. They are used internally for streaming operations such as download progress, child process output and WebSocket messages."* **[docs]** v2.tauri.app/develop/calling-frontend/
- **Raw `WebviewWindow::eval` is what the other two are built on.** Using it directly buys nothing except skipping the `index` bookkeeping, and costs you ordering guarantees, JS-side escaping safety and the fetch fast path. No reason to reach for it. **[asserted]**
- **Batching guidance: none exists in the Tauri docs.** There is no published statement about sending one array per frame. The 8192-byte constant is the only concrete number, and it argues for *many small batches* over *one big one*: a 60 fps batch of ~40 terse rows fits under 8 KB and stays on the `eval` fast path; a 500-row catch-up batch does not. **[source]** + **[asserted]**
- No per-small-message Tauri IPC benchmark exists (unchanged from `substrate.md`). The 8192/1024 comments are the closest thing to one. **[asserted]**

## 4. Frontend (`@tauri-apps/api` 2.11.1)

- `class Channel<T = unknown>` — `new Channel<T>()`, `id: number`, settable `onmessage: (response: T) => void`, `toJSON()`/`[SERIALIZE_TO_IPC_FN]()` returning the `__CHANNEL__:<id>` string. `node_modules/@tauri-apps/api/core.d.ts:61-71` **[source]**
- Usage is: construct, set `onmessage`, pass it as an `invoke` argument; the Rust command declares the parameter as `Channel<MyEvent>`. **[docs]** v2.tauri.app/develop/calling-frontend/
- `invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T>`. `core.d.ts:127` **[source]**
- `listen<T>(event, handler, options?): Promise<UnlistenFn>`; `once<T>(...)`; `emit<T>(event, payload?): Promise<void>`; `emitTo<T>(target, event, payload?): Promise<void>`; `UnlistenFn = () => void`; `Options.target?: string | EventTarget`. `event.d.ts:34-145` **[source]**
- **Our config uses ES imports, not `window.__TAURI__`.** `withGlobalTauri` is `#[serde(default)]` on a `bool` (so `false`) and our `src-tauri/tauri.conf.json` does not set it. `tauri-utils-2.9.3/src/config.rs:3073-3075`; `src-tauri/tauri.conf.json` **[source]**
- The React 19 + Vite frontend therefore imports `{ invoke, Channel }` from `@tauri-apps/api/core` and `{ listen }` from `@tauri-apps/api/event`. **[source]**
- The channel callback runs on the webview's main JS thread, invoked synchronously from the eval'd script — so `onmessage` must do nothing but push into a buffer that a `requestAnimationFrame` loop drains. **[source]** (`core.js:82-115`) + **[asserted]**

## 5. Process lifecycle

- `RunEvent` variants relevant here: `Exit`, `ExitRequested { code: Option<i32>, api: ExitRequestApi }`, `WindowEvent`, `WebviewEvent`, `Ready`, `Resumed`, `MainEventsCleared`, plus platform ones. `tauri-2.11.5/src/app.rs:220-...` **[source]**
- `ExitRequested.code` is `None` for user-initiated quit and `Some(_)` when requested via `AppHandle::exit`/`restart`; `api` lets you `prevent_exit()`. `tauri-2.11.5/src/app.rs:223-231` **[source]**
- **`tauri-plugin-shell` does kill children on `RunEvent::Exit` — but only children spawned from JavaScript.** Its `on_event` hook drains `Shell.children` and kills each; that map is populated *only* by `commands::spawn` (the JS command). A child spawned from Rust via `ShellExt::sidecar().spawn()` is never registered and is **never killed**. `src/lib.rs:135-145` vs `src/commands.rs:283-285` **[source]**
- So the supervisor must own the kill loop itself, hooked on `RunEvent::Exit` (and defensively on `ExitRequested`). **[asserted]**
- Nothing in Tauri sets a die-with-parent flag on child processes. There is no such call anywhere in `tauri-plugin-shell` or `tauri-runtime-wry`. **[source]** (absence)
- **macOS has no `prctl(PR_SET_PDEATHSIG)`.** `man 2 prctl` does not exist on darwin 25.5.0 and there is no `PR_SET_PDEATHSIG` in the SDK headers. **[source]** (checked locally)
- The macOS equivalents are: (a) the child watches the parent with `kqueue`/`EVFILT_PROC`+`NOTE_EXIT`, or (b) the child polls `getppid() == 1`, or (c) the parent puts children in their own process group (`process_group(0)`) and `killpg`s them, plus a pid-file sweep at startup for the crash case. Only (a)/(b) survive a `SIGKILL` of the Tauri process. **[asserted]**
- Recommended shape: sidecar spawned with `process_group(0)`; supervisor writes `{session_id, pid, pgid, started_at}` to an app-data pid file; `RunEvent::Exit` → `killpg(pgid, SIGTERM)` then `SIGKILL` after a grace period; startup sweep reads the pid file and kills any pgid still alive whose start time predates this launch. Belt-and-braces: the bun sidecar itself watches its parent via `process.ppid` polling and self-exits. **[asserted]**
- `Builder::setup(|app| ...)` runs on the main thread before the event loop; `Manager::manage<T: Send + Sync + 'static>(&self, state: T) -> bool` and `Builder::manage<T>(self, state: T) -> Self` (the latter `assert!`s on a duplicate type). `tauri-2.11.5/src/lib.rs:688-693`, `src/app.rs:1943-1949` **[source]**
- `manage` stores by type id, one value per type — wrap the supervisor in a newtype so a second `manage` of an inner type cannot collide. `tauri-2.11.5/src/app.rs:1947-1949` **[source]**
- Correct shape: `manage(Supervisor)` where `Supervisor` holds an `Arc<...>` of session handles; spawn tokio tasks from `setup` (or lazily per session) and keep their `JoinHandle`s inside the managed struct so exit can `abort()` them. `tauri::async_runtime::JoinHandle::abort()` exists. `tauri-2.11.5/src/async_runtime.rs:156` **[source]**
- Do not put long-running work *in* `setup` itself — it blocks the main thread before the window appears. **[asserted]**

## 6. Git worktrees (git 2.50.1)

All behaviours below were reproduced in a scratch repo on this machine unless marked otherwise.

- `git worktree add [-f] [--detach] [--checkout] [--lock [--reason <s>]] [--orphan] [(-b|-B) <new-branch>] <path> [<commit-ish>]`. **[docs]** `git help worktree`, SYNOPSIS
- `-b <branch> <path> <base>` creates `<branch>` at `<base>` and checks it out at `<path>`. If `<base>` is omitted it defaults to `HEAD`. **[docs]** OPTIONS
- **If the branch already exists, `-b` fails**: `fatal: a branch named 'existing' already exists` (after printing `Preparing worktree`). `-B` overrides and resets the branch to `<base>`. **[source]** (reproduced) + **[docs]**
- A branch already checked out in another worktree cannot be checked out again: `fatal: 'existing' is already used by worktree at '<path>'`. `--force` overrides. **[source]** (reproduced)
- `git worktree remove [-f] <worktree>` — refuses on an unclean worktree: `fatal: '<path>' contains modified or untracked files, use --force to delete it`. `--force` deletes it. `--force --force` is needed for a locked worktree. The main worktree cannot be removed. **[source]** (reproduced) + **[docs]**
- **`git worktree remove` on a worktree whose directory was deleted out from under it succeeds silently (rc=0)** and clears the admin files. **[source]** (reproduced)
- **Neither `remove` nor `prune` deletes the branch.** After removing worktrees for `feat-a` and `existing`, both branches were still listed by `git branch`. Session teardown must delete the branch separately if that is wanted. **[source]** (reproduced)
- A worktree whose directory was deleted stays registered and is reported as `prunable gitdir file points to non-existent location` in porcelain output / `prunable` in the human listing. Re-adding at that same path fails: `fatal: '<path>' is a missing but already registered worktree; use 'add -f' to override, or 'prune' or 'remove' to clear`. **[source]** (reproduced)
- `git worktree prune [-n] [-v] [--expire <time>]` removes stale `$GIT_DIR/worktrees` entries. Git also prunes automatically during gc per `gc.worktreePruneExpire`. **[docs]**
- `git worktree list --porcelain [-z]` output: one `label value` line per attribute, records separated by a blank line (or NUL with `-z`), the first attribute of every record is always `worktree <path>`. Booleans (`bare`, `detached`) appear as a bare label. Attributes seen: `worktree`, `bare`, `HEAD <40-hex>`, `branch refs/heads/<name>`, `detached`, `locked [reason]`, `prunable [reason]`. The main worktree is listed first. **[docs]** LIST OUTPUT FORMAT; **[source]** (reproduced)
- **Use `-z`.** Without it, "unusual" characters in a lock reason are escaped and the reason is quoted per `core.quotePath`, and a path containing a newline is unparseable. **[docs]** LIST OUTPUT FORMAT
- The porcelain format is explicitly promised stable: *"This format will remain stable across Git versions and regardless of user configuration."* **[docs]**
- Per-worktree refs (`HEAD`, `refs/bisect`, `refs/worktree`, `refs/rewritten`) are not shared; everything under `refs/` otherwise is. Reachable cross-worktree via the `main-worktree/` and `worktrees/<name>/` ref prefixes. **[docs]** REFS
- **`git2` 0.21.0 supports worktree add.** `Worktree`, `WorktreeAddOptions::{new, lock, checkout_existing, reference}`, `WorktreePruneOptions::{valid, locked, working_tree}`, `Worktree::{open_from_repository, name, path, validate, lock, unlock, is_locked, prune, is_prunable}`. `git2-0.21.0/src/worktree.rs:16-260` **[source]**
- **`gix` 0.87.1 does not.** `Repository` exposes only `worktree()`, `worktrees()`, `worktree_proxy_by_id()` — read-only iteration via `worktree::Proxy` ("a stand-in to a worktree as result of a worktree iteration"). No add, no remove, no prune. **[docs]** docs.rs/gix/0.87.1
- **Recommendation: shell out to `git`.** `git2` can add a worktree but pulls in libgit2 (and vendored zlib/libssh2 build cost), and its worktree API does not cover `remove`, does not implement `add`'s conveniences (branch-name-from-basename, `--guess-remote`, `--track`), and does not give you the stable porcelain listing. The CLI is one dependency-free `tokio::process::Command` away and its output format is contractually stable. **[asserted]**
- Cost of shelling out: you must handle a missing/old `git` on PATH, and parse porcelain. Both are cheap. **[asserted]**

## 7. Async runtime

- **Yes, Tauri exposes its runtime.** `tauri::async_runtime` provides `handle()`, `spawn()`, `spawn_blocking()`, `block_on()`, `set(TokioHandle)`, plus `JoinHandle` with `abort()`/`inner()`, and re-exports `tokio::sync::{mpsc::{channel, Receiver, Sender}, Mutex, RwLock}` and `tokio::runtime::{Handle, Runtime}`. `tauri-2.11.5/src/async_runtime.rs:13-19`, `:255-296` **[source]**
- The default global runtime is created lazily by `OnceLock::get_or_init` as `TokioRuntime::new()` — i.e. **a multi-thread tokio runtime with all drivers enabled**, worker count = available parallelism. `tauri-2.11.5/src/async_runtime.rs:29`, `:226-234` **[source]** + **[docs]** (tokio: `Runtime::new` == `Builder::new_multi_thread().enable_all().build()`)
- **You can own the runtime**: build your own multi-thread runtime and call `tauri::async_runtime::set(handle)` *before* anything touches the global one. `tauri-2.11.5/src/async_runtime.rs:255-263` **[source]**
- **Pitfall 1:** `set()` panics with `"runtime already initialized"` if the `OnceLock` was already filled — and it is filled by the *first* call to `handle()`/`spawn()`/`block_on()` anywhere, including inside Tauri and inside `tauri-plugin-shell`. So `set()` must be the first thing in `main`. `tauri-2.11.5/src/async_runtime.rs:255-263` **[source]**
- **Pitfall 2:** when you `set()` a handle, `GlobalRuntime.runtime` is `None` — Tauri holds only a `Handle`, and *you* must keep the `Runtime` alive for the whole process. Dropping it kills every Tauri-spawned task. Doc: *"Note that you cannot drop the underlying `TokioRuntime`."* `tauri-2.11.5/src/async_runtime.rs:257-261` **[source]**
- **Pitfall 3 (the good news):** `tauri::async_runtime::spawn` is *literally* `h.enter(); tokio::spawn(task)` on the same handle. Mixing `tauri::async_runtime::spawn` and `tokio::spawn` is safe and they land on the same runtime — **provided** `tokio::spawn` is called from inside a runtime context; from a plain OS thread it panics where `tauri::async_runtime::spawn` would not. `tauri-2.11.5/src/async_runtime.rs:200-212` **[source]**
- **Pitfall 4:** `tauri::async_runtime::block_on` is `Handle::block_on`, which **panics if called from a thread already inside a tokio runtime**. `tauri-plugin-shell` gets away with it because its pipe readers are plain `std::thread`s. Never call it from a tokio task. `tauri-2.11.5/src/async_runtime.rs:215-217`, `:272-276` **[source]**
- Tauri's own internal escape hatch for this is `safe_block_on`, which detects an ambient runtime and bounces through `spawn_blocking` — it is `pub(crate)`, so you would have to reimplement it. `tauri-2.11.5/src/async_runtime.rs:298-315` **[source]**
- **Pitfall 5:** none of this changes that `Channel::send`/`emit` cross to the tao event loop by proxy. Being on the "right" runtime does not give you IPC backpressure. See §3. **[asserted]**
- Practical call: use the default runtime and `tauri::async_runtime::spawn`; do not `set()` your own unless you need custom worker counts. If you do own one, `set()` on line one of `main` and leak the `Runtime` (or store it in a `static`). **[asserted]**

## Implications for the supervisor

- **Spawn sidecars with `tokio::process::Command` on `platform::current_exe()?.parent()?.join(<name>)`, not with `tauri-plugin-shell`.** You still keep `externalBin` staging (that is `tauri-build`, not the plugin), and you gain `process_group(0)`, your own buffer sizes, batched line reads, no `block_on` per line, and no three-OS-threads-per-child tax. The plugin's capacity-1 channel is the single biggest throughput constraint in the whole path, and the two features a `sidecar → claude` supervisor needs from it — a process-group option (plugins-workspace #1332) and a kill-tree (tauri #14360) — are open feature requests, not shipped behaviour.
- **Coalescing is not optional and Tauri will not tell you when it is behind.** `eval_script` from a worker thread is a fire-and-forget `proxy.send_event` into an unbounded tao queue. The supervisor must be the flow-control: buffer NDJSON events in Rust, drain once per frame, and drop/summarize when a session's buffer exceeds a cap.
- **Keep each per-frame batch under 8192 bytes of serialized JSON.** Under it, `Channel` takes the `eval` fast path; over it, the message detours through the `fetch` command and head-of-line blocks every subsequent message in the TS `pendingMessages` array. Prefer splitting a large frame into two sub-8 KB messages over one big one, and cap what a terse row carries.
- **Use `Channel<T>` per session, not `emit`.** Channels are the only path with an ordering guarantee and the only one with a large-payload fast path; events are documented as "not designed for low latency or high throughput". Hold the `Channel` in managed state — dropping it ends the stream.
- **The supervisor must kill its own children.** `tauri-plugin-shell`'s `RunEvent::Exit` sweep only covers JS-spawned children; Rust-spawned ones are never registered. And `kill()` on the direct child leaves the `claude` CLI grandchild alive — so put each session in its own process group and `killpg`.
- **macOS gives you no die-with-parent primitive.** Design for the crash case explicitly: process group + pid file in app-data + a startup sweep, and a `process.ppid` watchdog inside the bun sidecar. Anything less orphans multi-hundred-MB Node processes when the app is force-quit.
- **Terminated-is-last is a guarantee you can build on**, but it is contingent on EOF of both pipes; if a session's `Terminated` never arrives, suspect a grandchild holding the pipe, not a lost event. Time out on it rather than blocking teardown.
- **Trim the trailing `\n`** before `serde_json::from_slice` — Tauri's line splitter includes the terminator. (Moot if you read lines yourself with tokio, which is another reason to.)
- **Shell out to `git` for worktrees; use `--porcelain -z`.** `gix` cannot add worktrees at all and `git2` covers add-but-not-remove. Handle three specific states in code: branch already exists (`-b` fails, use `-B` or a unique name), directory deleted underneath (entry stays `prunable`, re-adding at that path fails until `prune`/`remove`), and unclean tree (`remove` needs `--force`). Deleting the worktree never deletes the branch.
- **Use the default `tauri::async_runtime` and spawn through it.** It is a multi-thread tokio runtime and `tauri::async_runtime::spawn` is `tokio::spawn` on the same handle. The only hard rule: never `block_on` from inside a task, and if you ever call `async_runtime::set`, do it on the first line of `main` and never drop the runtime.

## Not checked

- No code was written or run against Tauri: every Tauri/plugin finding is source-read plus the earlier spike, not measured here. In particular the 8192-byte threshold's real-world effect on our payloads is unmeasured.
- No throughput benchmark of `Channel::send` vs `emit` at 1k–10k msg/s. The 8192/1024 comments in `channel.rs` remain the only numbers in the Tauri tree; `substrate.md`'s "no published Tauri IPC benchmark" verdict stands.
- `tauri-plugin-shell` 2.3.6 is not yet a dependency of this repo; versions/APIs are from the published crate, not a resolved `Cargo.lock` entry.
- Windows and Linux: `\r`-splitting, `CREATE_NO_WINDOW`, `signal: None` on Windows, and the WebView2 8 KB threshold were read but not exercised. `process_group`/`killpg` is unix-only; the Windows equivalent (job objects) was not researched.
- Whether the bun sidecar leaks its stdout pipe to the `claude` grandchild (which would defer `Terminated`) was not tested.
- `git worktree` behaviour with submodules, `--relative-paths`, network/portable-device paths, and `worktree.useRelativePaths` was not exercised. All git reproductions used a single local repo with one commit.
- libgit2/`git2` was not built or run; its worktree API was read from source only.
- macOS `kqueue`/`NOTE_EXIT` parent-death watching was not prototyped.
- No Developer ID signing / notarization interaction with spawning sidecars in process groups.
- The GitHub issue sweep was delegated and partially rate-limited; the `\r` vs `\n` and `Channel`-ordering negative results are "nothing found", not "nothing exists". Nine cited issue numbers, titles and states were re-verified directly via `gh api`.
