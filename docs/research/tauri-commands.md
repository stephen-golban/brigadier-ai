# Tauri v2 command layer: `#[tauri::command]`, capabilities, managed state, run hooks

Date: 2026-09-02. Scope: the exact API for writing the Rust command layer of `brigadier_lib` and
calling it from the React/TS front end.

**This brief does not repeat `docs/research/tauri-runtime.md`.** That brief owns
`tauri::ipc::Channel` internals (§3: the 8192-byte eval/fetch cliff, the ordering `index`, the
`{end:true}` drop message), the frontend `@tauri-apps/api` surface (§4), `RunEvent` variants and
`Manager::manage` (§5), and `tauri::async_runtime` (§7). Sections here reference those by number
rather than restating them.

Tags: **[source]** read in the crate/package source · **[docs]** vendor documentation ·
**[measured]** compiled or executed on this machine today · **[asserted]** reasoned, not verified.

## Versions verified

| Thing | Version | How |
|---|---|---|
| `tauri` | 2.11.5 | `Cargo.lock` **[source]** |
| `tauri-build` | 2.6.3 | `Cargo.lock` **[source]** |
| `tauri-macros` | 2.6.3 | unpacked at `~/.cargo/registry/src/index.crates.io-*/tauri-macros-2.6.3` **[source]** |
| `tauri-utils` | 2.9.3 | `Cargo.lock` **[source]** |
| `tauri-plugin-opener` | 2.5.5 | `Cargo.lock` **[source]** |
| `wry` | 0.55.1 | `Cargo.lock` **[source]** |
| `tokio` | 1.53.1 | `Cargo.lock` **[source]** |
| `serde_json` | 1.0.151 | `Cargo.lock` **[source]** |
| `@tauri-apps/api` | 2.11.1 | `node_modules/@tauri-apps/api/package.json` **[source]** |
| `@tauri-apps/cli` | 2.11.4 | `node_modules/@tauri-apps/cli/package.json` **[source]** |
| React | 19.2.8 | `node_modules/react/package.json` **[source]** |
| TypeScript | 5.8.3 | `node_modules/typescript/package.json` **[source]** |
| Vite | 7.3.6 | `node_modules/vite/package.json` **[source]** |
| `rustc` on this machine | see `cargo check` below | probe crate compiled clean **[measured]** |

Crate paths below are relative to `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/<crate>-<version>/`
and are also readable at `https://docs.rs/<crate>/<version>/src/…`.

**Measurement method.** Every **[measured]** claim comes from a throwaway crate at
`<scratchpad>/tauricmd` (`tauri = "=2.11.5"`, `tauri-build = "=2.6.3"`, `thiserror = "2"`, one
capability file with `core:default`, no `permissions/` dir), driven with
`CARGO_TARGET_DIR=… cargo check --offline`; and from `<scratchpad>/envsize`, a binary with a path
dependency on this repo's `brigadier-core`, run with `cargo run --release`. Neither is in the repo.

---

## 1. `#[tauri::command]` signatures

### 1.1 Sync vs async, and which thread runs what

- The macro has three execution kinds: `sync` (plain fn), `async` (`async fn`), and
  `sync_threadpool` (plain fn annotated `#[tauri::command(async)]`).
  `tauri-macros-2.6.3/src/command/wrapper.rs:262-266` **[source]**
- Defaults when no attribute is given: `execution_context: Blocking`, `argument_case: Camel`,
  `rename: Keep`, `root: ::tauri`. `wrapper.rs:49-53` **[source]**
- `asyncness.is_some()` forces `ExecutionContext::Async` regardless of the attribute.
  `wrapper.rs:157-160` **[source]**
- The `async` body is `resolver.respond_async_serialized(async move { … })`
  (`wrapper.rs:369-395`), and `respond_async_serialized` → `crate::async_runtime::spawn`
  (`tauri-2.11.5/src/ipc/mod.rs:370-388`). So async commands land on Tauri's global multi-thread
  tokio runtime (`tauri-runtime.md` §7). **[source]**
- The `blocking` body calls `$path(...)` inline in the invoke handler (`wrapper.rs:400-431`), i.e.
  on whichever thread delivered the IPC message. Tauri documents that as the main thread:
  *"Commands without the _async_ keyword are executed on the main thread"*, *"Async commands are
  executed on a separate async task using `async_runtime::spawn`"*.
  **[docs]** https://v2.tauri.app/develop/calling-rust/
- Consequence: **any command that touches a `Mutex` the supervisor holds across await points, or
  does file/db I/O, must be `async` or `#[tauri::command(async)]`** — otherwise it blocks the UI
  thread and, per `tauri-runtime.md` §3, that is the same thread draining the `eval` queue that
  delivers the feed. **[asserted]**
- In `debug_assertions` builds the async response future is boxed and dynamically dispatched
  "for a faster compile time"; release builds monomorphize. `ipc/mod.rs:344-370` **[source]**

### 1.2 `State<'_, T>` and the `'_` lifetime

- `pub struct State<'r, T: Send + Sync + 'static>(&'r T)`; it `Deref`s to `T`, is `Clone`, and
  `inner()` returns `&'r T`. `tauri-2.11.5/src/state.rs:21-39` **[source]**
- `CommandArg for State` never fails on a type mismatch — it fails only when the type was never
  managed, with `"state not managed for field `{key}` on command `{name}`. You must call
  `.manage()` before using this command"`. `state.rs:60-68` **[source]**
- The `'_` is **rustc's rule, not Tauri's.** `State<Supervisor>` in an `async fn` is
  `error[E0726]: implicit elided lifetime not allowed here … help: indicate the anonymous
  lifetime: State<'_, Supervisor>`. In a *sync* command `State<Supervisor>` compiles (Tauri's own
  doc examples use it). **[measured]**
- The rule that **an async command with any borrowed argument must return `Result`** is enforced by
  the macro, not by rustc. The macro scans each typed argument for `syn::Type::Reference` or any
  path type carrying an explicit lifetime generic, and if it finds one it emits a
  `#[diagnostic::on_unimplemented]` trait check against the return type.
  `wrapper.rs:176-235` **[source]**
- The exact error, reproduced: **[measured]**

      error[E0277]: async commands that contain references as inputs must return a `Result`
         --> src/lib.rs:166:55
      166 | async fn bad_no_result(sup: State<'_, Supervisor>) -> u64 {
          |                                                       ^^^ the trait
          |    `_::AsyncCommandMustReturnResult` is not implemented for `u64`

- The check is textual and admits false negatives: it only fires when the *token stream* shows a
  reference or an explicit lifetime. `State<Supervisor>` (no `'_`) skips it — and then fails with
  E0726 instead, so nothing slips through in practice for `State`. `wrapper.rs:182-207` **[source]**
  + **[measured]**
- Upstream tracking issue named in the macro comment: tauri-apps/tauri#2533. `wrapper.rs:176-180`
  **[source]**

### 1.3 Injected argument types

`CommandArg` is implemented for exactly these, plus a blanket `impl for D: Deserialize<'de>`:

| Type | Impl site |
|---|---|
| `State<'r, T>` | `src/state.rs:60` **[source]** |
| `AppHandle<R>` | `src/app.rs:486` **[source]** |
| `Webview<R>` | `src/webview/mod.rs:2330` **[source]** |
| `WebviewWindow<R>` | `src/webview/webview_window.rs:1487` **[source]** |
| `Window<R>` | `src/window/mod.rs:1091` **[source]** |
| `Channel<TSend>` | `src/ipc/channel.rs:300` **[source]** |
| `Request<'a>` (raw body + headers) | `src/ipc/mod.rs:165` **[source]** |
| `CommandScope<T>` / `GlobalScope<T>` | `src/ipc/authority.rs:609`, `:656` **[source]** |
| anything `Deserialize` | `src/ipc/command.rs:62` **[source]** |

- `AppHandle`, `Window`, `WebviewWindow` and `Channel` are injected **by type, not by name** — the
  argument name is irrelevant, so `_w: Window` works. Compiled with `Window`, `WebviewWindow` and
  `AppHandle` in one signature. **[measured]**
- The generic parameter is optional in app code: `AppHandle` (not `AppHandle<R>`) resolves to
  `AppHandle<Wry>` via `#[default_runtime]`. Compiled. **[measured]**
- `self` is rejected: `"unable to use self as a command function parameter"`.
  `wrapper.rs:471-478`, `:496-502` **[source]**
- A missing JSON key produces `"command {name} missing required key {key}"`; `Option<T>` arguments
  are fine because the `Deserializer` impl hands the visitor a `None`. `ipc/command.rs:83-105`
  **[source]**

### 1.4 Argument naming

- Rust argument identifiers are converted to **lowerCamelCase by default** before being looked up
  in the JSON payload: `key = key.to_lower_camel_case()`. `wrapper.rs:505-511` **[source]**
- `#[tauri::command(rename_all = "snake_case")]` switches to `to_snake_case`; the only two accepted
  values are `"camelCase"` and `"snake_case"`, anything else is a compile error
  (`expected "camelCase" or "snake_case"`). `wrapper.rs:62-77` **[source]**
- `_` (wildcard) arguments become the empty key, which then fails deserialization with
  `"command {name} has an argument with no name with a non-optional value"` unless the type is
  `Option`. `wrapper.rs:486`, `ipc/command.rs:84-89` **[source]**
- **This applies only to command *arguments*.** Return payloads are plain `serde`, so
  `brigadier_core::event::Envelope` reaches JS with its Rust field names (`instance_id`,
  `session_id`, `item_id`, `parent_item_id`) — see §9. **[measured]**
- Additional, undocumented-in-the-guide attribute: `#[tauri::command(rename = "some.name")]`
  changes the **IPC command name** (what JS passes to `invoke`) without renaming the Rust fn.
  `wrapper.rs:79-91`, `:298-304`, `:513-518`. Compiled with `rename = "sessions.end"`. **[source]** +
  **[measured]**

### 1.5 `Result<T, E>` — the bound on `E`, and what JS receives

- The return type is dispatched by autoref specialization in `tauri::ipc::private`. The `Result`
  arms are `impl<T: IpcResponse, E: Into<InvokeError>> ResultKind for Result<T, E>` and
  `impl<T: IpcResponse, E: Into<InvokeError>, F: Future<Output = Result<T, E>>> ResultFutureKind
  for F`. `src/ipc/command.rs:230-313` **[source]**
- So the real bound is **`E: Into<InvokeError>`**, and that is satisfied via the blanket
  `impl<T: Serialize> From<T> for InvokeError` — which does `serde_json::to_value(value)` and falls
  back to `InvokeError::from_error` if serialization fails. `src/ipc/mod.rs:240-247` **[source]**
- Net: **`E: serde::Serialize` is what you need.** `E: std::error::Error` is *not* required.
  `T` needs `IpcResponse`, which is blanket-implemented for `T: Serialize`
  (`serde_json::to_string` once). `src/ipc/mod.rs:176-187` **[source]**
- Two working patterns, both compiled: **[measured]**
  - A `thiserror` enum with a `#[from]` source that is not `Serialize` (e.g. `std::io::Error`)
    **cannot** `#[derive(Serialize)]`; write the manual impl that Tauri's docs show
    (`serializer.serialize_str(&self.to_string())`). JS then receives a plain string.
  - A `thiserror` enum whose variants hold only serializable data **can** `#[derive(Serialize)]`
    with `#[serde(tag = "kind", content = "message", rename_all = "camelCase")]`; JS then receives
    a tagged object it can switch on.
- Error transport: `InvokeError(pub serde_json::Value)` → `InvokeResponse::Err(e)` →
  `serde_json::to_vec(&e.0)` with `Content-Type: application/json` and header
  `Tauri-Response: error`. `src/ipc/mod.rs:224`, `src/ipc/protocol.rs:108-124` **[source]**
- On the JS side, `invoke` wires two one-shot callbacks and the error callback calls `reject(e)`
  with the **decoded JSON value itself** — not an `Error`, not wrapped.
  `tauri-2.11.5/scripts/core.js:81-92`; `ipc-protocol.js:43-58` **[source]**
- So `catch (e)` in TS receives a `string` (manual-impl pattern) or an object (derive pattern).
  `e instanceof Error` is **false**. Type your catch as `unknown` and narrow. **[source]** +
  **[asserted]**
- An unregistered command name rejects with the string `"Command {cmd} not found"`.
  `src/webview/mod.rs:1905`, `:1911` **[source]**

### 1.6 The `pub` landmine — commands cannot be `pub` at a lib crate root

`#[tauri::command]` emits, next to the function, two `macro_rules!` macros (`__cmd__<name>` and
`__tauri_command_name_<name>`) plus `#visibility use {…};` re-importing them at the same scope. If
the function is `pub` or `pub(crate)`, the macros also get `#[macro_export]`, which hoists them to
the **crate root** macro namespace. `wrapper.rs:162-168`, `:301-351` **[source]**

Measured consequences in a lib crate (ours is `brigadier_lib`): **[measured]**

| Shape | Result |
|---|---|
| `pub fn` / `pub async fn` command **in `lib.rs` (crate root)** | `error[E0255]: the name `__cmd__<name>` is defined multiple times` — 2 errors per command |
| non-`pub` command in `lib.rs` | compiles |
| `pub` or `pub(crate)` command **in a submodule**, unique fn name | compiles; `generate_handler![cmds::foo]` resolves |
| two commands with the **same fn name** in two submodules, both `pub` (even with different `rename`) | `error[E0428]: the name `__cmd__ping` is defined multiple times` |
| same, but both non-`pub` | `error[E0603]: macro import `__cmd__ping` is private` from the `generate_handler!` site |

**Rule: every command function identifier must be unique across the whole crate, and commands must
live in a submodule (not `lib.rs`) if they are `pub`/`pub(crate)`.** `rename = "…"` renames only the
IPC string, not the generated macros, so it does **not** fix an identifier collision. **[measured]**

---

## 2. `generate_handler!` and `invoke_handler`

- `generate_handler![a, b, c]` expands to a single closure
  `move |invoke| { let cmd = invoke.message.command(); match cmd { <name!()> => __cmd__a!(a, invoke), … , _ => return false } }`.
  `tauri-macros-2.6.3/src/command/handler.rs:139-179` **[source]**
- `Builder::invoke_handler<F: Fn(Invoke<R>) -> bool + Send + Sync + 'static>` **assigns**
  (`self.invoke_handler = Box::new(invoke_handler)`), so a second call silently discards the first.
  `tauri-2.11.5/src/app.rs:1658-1663` **[source]**; docs agree: *"Only the last call will be used"*.
  **[docs]** https://v2.tauri.app/develop/calling-rust/
- Commands may be paths: `generate_handler![sessions::interrupt, projects::list]`. The macro
  rewrites the last path segment to `__cmd__<ident>`. `handler.rs:44-58` **[source]** + **[measured]**
- The match arms are strings, so **command names are a flat global namespace**; docs: *"they must
  be unique even between modules"*. Use `rename = "…"` (§1.4) when two natural names collide, but
  note §1.6 — the Rust identifiers still must differ. **[docs]** + **[measured]**
- Per-command attributes are allowed inside the macro (e.g. `#[cfg(desktop)] my_command`).
  `handler.rs:11-23`, `:167` **[source]**
- `build.removeUnusedCommands` (`tauri.conf.json`, default `false`) makes the macro drop commands
  not named by any capability. It is a no-op for **application** commands when the app has no ACL
  manifest — `if plugin_name.is_none() && !allowed_commands.has_app_acl { return; }`.
  `handler.rs:88-101`; `tauri-utils-2.9.3/src/config.rs:3446-3447` **[source]**

**Recommended organization for `src-tauri`:** one `commands` module (or a `commands/` directory
with `mod.rs`), every command `pub(crate)`, unique identifiers, one `generate_handler!` in
`lib.rs`. See §10 for the shape that compiled.

---

## 3. Capabilities and permissions in 2.11

### 3.1 Do our own commands need a capability entry? **No.**

The gate is one condition in `Webview::on_message`:

```rust
// src/webview/mod.rs:1819-1826
// Check ACL on plugin commands, when the app defined its ACL manifest,
// or when the request comes from a non-local (remote) origin.
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
  && request.cmd != crate::ipc::channel::FETCH_CHANNEL_DATA_COMMAND
  && invoke.acl.is_none()
{ /* reject */ }
```

`tauri-2.11.5/src/webview/mod.rs:1819-1851` **[source]**

Reading it precisely:

- A command **without** the `plugin:` prefix (i.e. an application command), invoked from a **local**
  origin, is allowed with **no capability entry at all** — provided `has_app_acl_manifest` is false.
  **[source]**
- `has_app_acl_manifest` is true only if the build produced an app-level ACL manifest, which
  `tauri-build` creates only when `AppManifest::commands(&[…])` is set in `build.rs` **or** a
  `src-tauri/permissions/` directory yields at least one permission file.
  `tauri-build-2.6.3/src/acl.rs:264-334`, `:400-419`; `tauri-utils-2.9.3/src/acl/mod.rs:347-350`
  **[source]**
- **This repo has no `src-tauri/permissions/` and `build.rs` is bare `tauri_build::build()`**, so
  `has_app_acl_manifest` is false and every command we register is invokable from the `main` window
  today. **[source]** (checked: `src-tauri/build.rs`, `ls src-tauri` shows no `permissions/`)
- `is_local` is true for `tauri://` / the custom protocol, for anything relative to `devUrl`
  (`http://localhost:1420`) or `frontendDist`, and for user-registered custom protocols.
  `src/webview/mod.rs:1698-1738` **[source]**
- Docs agree: *"By default, all commands that you registered in your app … are allowed to be used by
  all the windows and webviews of the app."* **[docs]** https://v2.tauri.app/security/capabilities/
- In a `debug_assertions` build the rejection message is the long ACL diagnostic; in release it is
  `"Command {cmd} not allowed by ACL"`. `src/webview/mod.rs:1827-1850` **[source]**
- The channel large-payload pull command `plugin:__TAURI_CHANNEL__|fetch` is hard-coded exempt
  (`request.cmd != FETCH_CHANNEL_DATA_COMMAND`) — the `core:channel` permission set is commented
  out with a `TODO: Enable this in v3`. So the `Channel` fetch fast path needs no permission.
  `src/webview/mod.rs:1824-1825`; `src/ipc/channel.rs:31-33`; `tauri-2.11.5/build.rs:17-18`
  **[source]**

### 3.2 What `core:default` includes

`core:default` is generated at build time as the set `["core:path:default", "core:event:default",
"core:window:default", "core:webview:default", "core:app:default", "core:image:default",
"core:resources:default", "core:menu:default", "core:tray:default"]`, from the `PLUGINS` table.
`tauri-2.11.5/build.rs:16-345` (table), `:449-484` (set generation) **[source]**

Each `core:<x>:default` is the subset of that plugin's commands whose table flag is `true`
(`build.rs:387-414`). The ones that matter to us:

- `core:event:default` — `listen`, `unlisten`, `emit`, `emit_to`. Required for `listen()` from JS.
  **[source]**
- `core:webview:default` — the getters plus **`internal_toggle_devtools`**, which is what makes the
  ⌘⌥I devtools hotkey work (§8). All setters (`webview_close`, `print`, `reparent`,
  `clear_all_browsing_data`, …) are `false`, i.e. not in the default. **[source]**
- `core:window:default` — every getter, plus `internal_toggle_maximize`. Every setter
  (`set_title`, `close`, `minimize`, `set_size`, …) is `false`. **If the UI ever needs to
  programmatically resize/close the window from JS, that permission must be added explicitly.**
  **[source]**
- `core:app:default` — `version`, `name`, `tauri_version`, `identifier`, `bundle_type`,
  `register_listener`, `remove_listener`, `supports_multiple_windows`. `app_show`/`app_hide` are
  not included. **[source]**
- `core:path:default` — all eight path commands, including `resolve_directory` (which backs
  `appLocalDataDir()` etc. from JS). **[source]**

### 3.3 `opener:default`

- `src-tauri/capabilities/default.json` lists `"opener:default"`, `src-tauri/src/lib.rs:10`
  registers `tauri_plugin_opener::init()`, `Cargo.toml:19` depends on `tauri-plugin-opener`, and
  `package.json` depends on `@tauri-apps/plugin-opener`. **Nothing in the repo uses any of it**
  (`src/main.tsx` is an empty component). **[source]**
- **Removing the Cargo dependency without removing the capability entry breaks the build.**
  `tauri-build`'s `validate_capabilities` bails with `"Permission opener:default not found,
  expected one of …"`. `tauri-build-2.6.3/src/acl.rs:341-397` **[source]**
- So dropping it is a four-file change: the `.plugin()` call, the Cargo dep, the capability entry,
  and the npm dep. Keeping it costs one plugin's worth of binary and one registered command set.
  **[asserted]** — recommend dropping it; the harness has no reason to open URLs, and a supervisor
  that shells out is better served by an explicit command.

---

## 4. Managed state

- `Builder::manage<T: Send + Sync + 'static>(self, state: T) -> Self` **asserts** on a duplicate
  type: `"state for type '{type_name}' is already being managed"`.
  `tauri-2.11.5/src/app.rs:1943-1952` **[source]**
- `Manager::manage<T>(&self, state: T) -> bool` (available on `&App` / `&AppHandle` inside `setup`)
  **returns `false` and keeps the existing value** instead of panicking.
  `tauri-2.11.5/src/lib.rs:688-693` **[source]**
- `Manager::state::<T>()` panics `"state() called before manage() for {type}"`;
  `Manager::try_state::<T>()` returns `Option`. `src/lib.rs:729-747` **[source]**
- Storage is `HashMap<TypeId, Pin<Box<dyn Any + Sync + Send>>>` — **one value per concrete type**,
  and once inserted it is never moved or removed (`unmanage` is deprecated since 2.3.0 as unsafe:
  it dangles previously handed-out `&T`). `src/state.rs:99-125`, `src/lib.rs:697-720` **[source]**
- `State<'_, T>` `Deref`s to `T`, so `sup.feeds.lock()` works directly; `state.inner()` gives you
  the `&'r T` when you need to hold it past the guard. `src/state.rs:32-39` **[source]**

### 4.1 `setup` — signature, errors, and async initialization

- `Builder::setup<F: FnOnce(&mut App<R>) -> Result<(), Box<dyn std::error::Error>> + Send + 'static>`.
  `src/app.rs:1773-1780` **[source]**
- `setup` runs **on `RuntimeRunEvent::Ready`, from inside the event loop, after the configured
  windows have been created** — not during `Builder::build`. `src/app.rs:2521-2534`, `:1420-1427`
  **[source]**
- **An `Err` from `setup` panics the process**: `if let Err(e) = setup(&mut self) { panic!("Failed
  to setup app: {e}") }`. Both `App::run` and `App::run_return` document this. There is no
  graceful path. `src/app.rs:1420-1424`, `:1348`, `:1385` **[source]**
- Therefore: **do not `?` a recoverable failure out of `setup`.** Opening the SQLite store at
  `app.path().app_local_data_dir()?` is exactly the case that must not panic on a user's machine
  with a read-only home dir. Manage a `Result`-shaped or `Option`-shaped state and let a command
  report the failure to the UI. **[source]** + **[asserted]**
- `app.path()` is available inside `setup` (`Manager::path()`), and
  `PathResolver::app_local_data_dir()` exists on desktop. `src/lib.rs:766`,
  `src/path/desktop.rs:256` **[source]**. Per-platform values are already recorded in
  `docs/research/persistence.md` §5.
- `tauri::async_runtime::spawn` from `setup` compiles and is the documented pattern; clone
  `app.handle()` into the task and reach state with `handle.state::<T>()`. Compiled. **[measured]**
- Long synchronous work in `setup` blocks the event loop *after* the window exists, so the window
  is up but frozen. Prefer: `manage()` a cheap handle synchronously, then `spawn` the expensive
  open and have the front end poll a `ready()` command or wait on a `Channel`. **[asserted]**
  (restates `tauri-runtime.md` §5's last bullet with the corrected "after the window is created"
  detail — see §11.)

---

## 5. `build(context)?.run(callback)` vs `run(context)`

- `Builder::run(self, context) -> crate::Result<()>` is literally
  `self.build(context)?.run(|_, _| {}); Ok(())` — it discards every `RunEvent`.
  `src/app.rs:2445-2452` **[source]** — this is what `src-tauri/src/lib.rs:11` does today, so the
  app currently has **no exit hook at all**.
- `App::run<F: FnMut(&AppHandle<R>, RunEvent) + 'static>(self, callback: F)` — **never returns**;
  the process is exited by the runtime. `src/app.rs:1344-1374` **[source]**
- `App::run_return<F: FnMut(&AppHandle<R>, RunEvent) + 'static>(self, callback: F) -> i32` returns
  the intended exit code and lets you run code after the loop. Not supported on iOS.
  `src/app.rs:1405-1422` **[source]**
- Note `FnMut`, not `Fn`: the callback may own mutable state. It is **not** `Send` — it runs on the
  main thread only. `src/app.rs:1366` **[source]**
- Ordering, verbatim from `make_run_event_loop_callback`: on `Exit`, Tauri calls **your callback
  first**, then `app_handle.cleanup_before_exit()`, then optionally restarts.
  `src/app.rs:1428-1437` **[source]**
- `RunEvent::ExitRequested { code, api }`: `code` is `None` for a user-initiated quit and `Some(_)`
  when requested via `AppHandle::exit`/`restart`. `api.prevent_exit()` sends `Prevent` on a
  `std::sync::mpsc::Sender` and is **ignored when `code == Some(RESTART_EXIT_CODE)`**
  (`i32::MAX`). `src/app.rs:75-95`, `:220-231` **[source]**
- **Can the callback block?** Yes. It runs on the main/event-loop thread, synchronously, and
  `prevent_exit` is a synchronous channel send that the runtime reads after the callback returns.
  A `killpg(pgid, SIGTERM)` + short `std::thread::sleep` + `SIGKILL` sweep is exactly the intended
  use. Compiled a callback that sleeps and takes the supervisor mutex. **[source]** + **[measured]**
- **What it must not do:**
  - Do not call `AppHandle::exit()` from inside it — that re-enters `request_exit`.
    `src/app.rs:573-580` **[asserted]**
  - Do not use any Tauri API *after* `cleanup_before_exit`: *"You should always exit the tauri app
    immediately after this function returns and not use any tauri-related APIs."*
    `src/app.rs:1106-1120` **[source]**
  - Do not block for long on `ExitRequested`: the window is still on screen and the whole UI is
    frozen. Do the long wait on `Exit`, or do a `SIGTERM` on `ExitRequested` and the `SIGKILL`
    sweep on `Exit`. **[asserted]**
  - Do not `.await` — the callback is sync. `tauri::async_runtime::block_on` **is** legal here,
    because the main thread is not inside a tokio runtime (contrast `tauri-runtime.md` §7
    pitfall 4, which forbids it inside a task). Compiled. **[measured]**
- `RunEvent` is `#[non_exhaustive]` and so are `ExitRequested`/`WindowEvent`/`WebviewEvent`: always
  match with `..` and a `_ => {}` arm. `src/app.rs:216-231` **[source]**

---

## 6. `Channel<T>` on the Rust side

- The struct: `pub struct Channel<TSend = InvokeResponseBody> { inner: Arc<ChannelInner>, phantom:
  PhantomData<TSend> }`, where `ChannelInner { id: u32, on_message: Box<dyn Fn(InvokeResponseBody)
  -> crate::Result<()> + Send + Sync>, on_drop: Option<Box<dyn Fn() + Send + Sync + 'static>> }`.
  `src/ipc/channel.rs:50-83` **[source]**
- **`Clone` is implemented for every `TSend`** (hand-written, clones the `Arc`).
  `src/ipc/channel.rs:62-70` **[source]**
- **`Send`/`Sync` are auto-derived** and hold whenever `TSend: Send + Sync`, because both boxed
  closures are `Send + Sync` and the only other field is `PhantomData<TSend>`.
  Verified by compiling `fn assert<T: Send + Sync>()` against `Channel<Vec<Envelope>>` and against a
  `Mutex<HashMap<String, Channel<Vec<Envelope>>>>` inside a managed struct. **[source]** +
  **[measured]**
- **Storing channels in managed state behind a `Mutex`/`RwLock` compiles and is the intended
  pattern** (`tauri-runtime.md` §3: dropping the Rust `Channel` ends the JS stream). **[measured]**
- The bound on `TSend` is **only on `send`**: `pub fn send(&self, data: TSend) -> crate::Result<()>
  where TSend: IpcResponse`. The struct itself and the `CommandArg` impl are unbounded, so
  `Channel<Vec<Envelope>>` is a legal field type even where `Envelope` is not in scope as
  `Serialize`. `src/ipc/channel.rs:287-296`, `:300-316` **[source]**
- `IpcResponse` is blanket-implemented for `T: Serialize` as one `serde_json::to_string`.
  `src/ipc/mod.rs:176-187` **[source]** (see `tauri-runtime.md` §3)

### 6.1 `send` after a webview reload

- `Channel::send` → the `on_message` closure → `webview.eval(format_raw_js(callback_id, …))`.
  `format_raw_js` produces
  `window.__TAURI_INTERNALS__.runCallback(<id>, { message: <json>, index: <n> })`.
  `src/ipc/channel.rs:155-162`; `src/ipc/format_callback.rs:100-106` **[source]**
- `Webview::eval` → `dispatcher.eval_script`, which `tauri-runtime.md` §3 establishes is
  fire-and-forget and returns `Ok(())` regardless. `src/webview/mod.rs:1917-1923` **[source]**
- The JS callback registry is a plain `Map` created by the per-document init script; a reload wipes
  it. `runCallback` then hits the miss branch:

      console.warn(`[TAURI] Couldn't find callback id ${id}. This might happen when the app is
      reloaded while Rust is running an asynchronous operation.`)

  `tauri-2.11.5/scripts/core.js:22-46` **[source]**
- **So `send` after a reload is silent from Rust: `Ok(())`, one `console.warn` in the webview, the
  payload dropped.** There is no error, no callback, no way to detect it from the Rust side. This
  is the single most important operational fact about channels for a supervisor. **[source]**
- Worse: the Rust-side `counter: AtomicUsize` created by `JavaScriptChannelId::channel_on` keeps
  incrementing across the reload (`src/ipc/channel.rs:138-145`). Even if a fresh JS `Channel`
  somehow drew the same id, its `nextMessageIndex` restarts at 0 while Rust is at N, so every
  message would sit unfired in the TS `pendingMessages` array forever. **[source]**
- Channel ids on the JS→Rust path are **random**, not sequential: `transformCallback` is
  `registerCallback`, whose identifier is `window.crypto.getRandomValues(new Uint32Array(1))[0]`.
  So a collision is a ~2⁻³² accident, not a systematic risk. `scripts/core.js:6-33` **[source]**
  (The Rust-side `CHANNEL_COUNTER` at `channel.rs:41` only numbers channels created by
  `Channel::new` in Rust.)
- The reload is observable in Rust via `Builder::on_page_load(|webview, payload| …)` with
  `PageLoadEvent::{Started, Finished}`. `src/app.rs:1783-1790`;
  `src/webview/mod.rs:107-122` **[source]**

**Recommended re-establishment pattern.** The front end owns the handshake: on mount, call a
`subscribe(session_id, on_event: Channel<…>)` command that *replaces* whatever channel is stored for
that session and then replays a bounded tail (`StoreHandle::feed_tail`) before switching to live
messages. The Rust side must drop the old channel (which fires `{end:true}` to a page that no longer
exists — harmless) and must not assume the old one is dead. `on_page_load` is a useful belt-and-
braces to invalidate eagerly, but it is not a substitute: a `subscribe` call is the only signal that
the *new* document is ready to receive. **[asserted]**

**React 19 StrictMode caveat.** `src/main.tsx` wraps the app in `<React.StrictMode>`, which
double-invokes effects in development. A `useEffect` that calls `subscribe` will fire twice per
mount in `tauri dev`, creating two Rust `Channel`s. Make `subscribe` idempotent (replace-by-key, as
above) and return an unsubscribe from the effect. **[source]** (`src/main.tsx:11-13`) +
**[asserted]**

---

## 7. TypeScript side (`@tauri-apps/api` 2.11.1)

Import paths (package `exports` maps `./*` → `./*.js`, ESM; `"type": "module"`):

```ts
import { invoke, Channel, isTauri } from '@tauri-apps/api/core'
import { listen, emit } from '@tauri-apps/api/event'
```

`node_modules/@tauri-apps/api/package.json:20-35` **[source]**. `withGlobalTauri` is unset in our
config, so `window.__TAURI__` does not exist — ES imports only (`tauri-runtime.md` §4).

- `declare function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T>`
  where `InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array` and
  `InvokeOptions = { headers: HeadersInit }`. `core.d.ts:105-127` **[source]**
- `T` is **unchecked** — `invoke<Session[]>('list_sessions')` is a cast, not a validation. There is
  no generated binding; keep a hand-written `src/ipc.ts` that is the single place Rust command names
  and shapes are typed. **[source]** + **[asserted]**
- Argument casing: `invoke` passes `args` through verbatim; the camelCase convention is a *Rust-side*
  transformation (§1.4). So with a default command you write `invoke('start_session', { projectId,
  permissionMode })`; with `rename_all = "snake_case"` you write `{ project_id, permission_mode }`.
  `core.js:201-203` **[source]**
- `class Channel<T = unknown>` — `constructor(onmessage?: (response: T) => void)`, settable
  `onmessage`, `id: number`, `toJSON()`/`[SERIALIZE_TO_IPC_FN]()` → `"__CHANNEL__:<id>"`.
  Constructor-arg form is available in 2.11.1; the older `new Channel(); ch.onmessage = fn` also
  works. `core.d.ts:61-70`; `core.js:74-131` **[source]**
- Pass a channel as an ordinary argument: `invoke('subscribe', { sessionId, onEvent: ch })`. The
  Rust parameter is `on_event: Channel<Vec<Envelope>>` (camelCased to `onEvent`). Serialization to
  the `__CHANNEL__:<id>` string happens via `SERIALIZE_TO_IPC_FN`/`toJSON`.
  `src/ipc/channel.rs:300-316` **[source]**
- Detecting Tauri: `isTauri()` from `@tauri-apps/api/core` returns
  `!!(globalThis || window).isTauri`. That flag is set by a **main-frame-only** init script:
  `Object.defineProperty(window, 'isTauri', { value: true })`.
  `core.js:278-281`; `tauri-2.11.5/src/manager/webview.rs:166-180` **[source]**
- `window.__TAURI_INTERNALS__` is defined by the same script and is the lower-level check; prefer
  `isTauri()`. Note both are per-document init scripts, so they exist before your bundle runs but
  **not** in a plain `vite dev` browser tab — which is the case worth guarding for, since
  `npm run dev` serves the same app at `http://localhost:1420` outside Tauri. **[source]** +
  **[asserted]**
- `listen`/`emit`/`emitTo`/`once` and `UnlistenFn` are unchanged from `tauri-runtime.md` §4; they
  require `core:event:default`, which our capability already grants (§3.2).

---

## 8. Devtools / Web Inspector on macOS

- Enabled automatically in debug builds; in release it needs the `devtools` Cargo feature. The
  wry attribute default is `devtools: true` under `debug_assertions`, `false` otherwise, and the
  whole block is `#[cfg(any(debug_assertions, feature = "devtools"))]`.
  `wry-0.55.1/src/lib.rs:835-837`; `wry-0.55.1/src/wkwebview/mod.rs:537-551` **[source]**
- Our `src-tauri/Cargo.toml:18` has `features = []`, so **`npm run tauri dev` has the inspector and
  `npm run tauri build` does not.** To profile a release build, add `devtools` to the feature list —
  but Tauri's own warning applies: *"The devtools API is private on macOS. Using private APIs on
  macOS prevents your application from being accepted to the App Store."*
  **[docs]** https://v2.tauri.app/develop/debug/ ; **[source]** (`wkwebview/mod.rs:546-549` marks
  `developerExtrasEnabled` as a private KVC key)
- On macOS 13.3+ wry also sets the public `WKWebView.isInspectable = true` when the property
  responds; the private key is set unconditionally alongside it because *"this cannot be on an
  `else` statement, it does not work on macOS"*. `wkwebview/mod.rs:539-551` **[source]**
- Three ways in, all available in a `tauri dev` build:
  1. **Right-click → Inspect Element** in the webview.
     **[docs]** https://v2.tauri.app/develop/debug/ ; wry: *"or right click the page and open it
     from the context menu"* (`wry/src/lib.rs:710-712`) **[source]**
  2. **⌘⌥I** (macOS) / **Ctrl+Shift+I** elsewhere. Tauri injects a keydown listener that invokes
     `plugin:webview|internal_toggle_devtools`.
     `tauri-2.11.5/src/webview/scripts/toggle-devtools.js:5-21` **[source]**
     That command is in `core:webview:default` (`tauri-2.11.5/build.rs:151`,
     `("internal_toggle_devtools", true)`), which our `core:default` capability already grants —
     **if the capability were narrowed, the hotkey would silently stop working.** **[source]**
  3. Programmatically: `WebviewWindow::open_devtools()` / `close_devtools()` / `is_devtools_open()`,
     all `#[cfg(any(debug_assertions, feature = "devtools"))]`.
     `tauri-2.11.5/src/webview/mod.rs:2007-2088` **[source]**
- Implementation note for anyone profiling: `open_devtools` is
  `msg_send![webview, _inspector]` then `show` — the WebKit inspector, so **Safari's Web Inspector
  is the profiler**, including its Timelines/frame-rate instrument. It is a separate window, not the
  Chrome DevTools protocol; there is no CDP endpoint to script against.
  `wry-0.55.1/src/wkwebview/mod.rs:900-908` **[source]** + **[asserted]**
- For automated FPS numbers, measure **inside the page** with `requestAnimationFrame` deltas and
  report them out over a command; do not plan on scraping the inspector. **[asserted]**

---

## 9. Serde across IPC, and how to measure batch size

- Confirmed: a `Vec<Envelope>` sent through `Channel::send` is serialized exactly **once** with
  `serde_json::to_string` (`impl<T: Serialize> IpcResponse for T`, `src/ipc/mod.rs:181-187`) and the
  resulting string is interpolated raw into `{ message: <json>, index: <n> }`
  (`src/ipc/channel.rs:155-162`). No `JSON.parse` of a quoted string, no double encoding — as
  `tauri-runtime.md` §3 states. **[source]**
- The `> 10 KiB → JSON.parse('…')` optimization in `format_raw` is **not** on the channel path;
  channels call `format_raw_js` directly. `src/ipc/format_callback.rs:93-106` **[source]**
- Our `Event` is `#[serde(tag = "type", rename_all = "kebab-case")]` and `Envelope`/its fields carry
  no `rename_all`, so the wire shape is snake_case fields with kebab-case variant tags.
  `crates/core/src/event.rs:114-138`, `:164-167` **[source]**

### 9.1 Measured sizes (this repo's real types)

Serialized with `serde_json::to_string` against `brigadier-core` at HEAD: **[measured]**

```
{"seq":1,"at":1788000000000,"instance_id":"claude-default","session_id":"01J9ZQ7H8K2M4N6P8R0T2V4X6Z",
 "event":{"type":"content-delta","item_id":"itm_01H9ZQ7H8K2M","text":"Reading src-tauri/src/lib.rs …"}}
```

| Payload | Bytes |
|---|---|
| one `ContentDelta` envelope (43-char text) | **217** |
| …of which per-envelope framing (`seq`/`at`/`instance_id`/`session_id`/`"event":`) | **110** |
| one `ItemStarted{ToolCall}` envelope with a 59-char summary | **300** |
| batch of 20 `ContentDelta` | 4 371 — under 8192 |
| batch of 30 | 6 561 — under 8192 |
| batch of 40 | 8 751 — **over** |
| one envelope carrying a full `raw` excerpt (`RAW_EXCERPT_LIMIT` = 4 KiB) | **4 279** |

Three conclusions, all measured:

1. **The 8 KB budget is ~37 `ContentDelta` envelopes, or ~27 item-lifecycle envelopes.** Cap the
   per-frame batch by *serialized bytes*, not by count.
2. **Framing is 51 % of a terse envelope** (110 of 217 bytes). `instance_id`, `session_id` and `at`
   are constant within one batch. Hoisting them into a batch header roughly doubles the events per
   batch for free.
3. **Two envelopes carrying `raw` blow the cliff on their own.** `Envelope::raw` must be stripped
   before the feed batch reaches the webview; it belongs in the store and the rotating NDJSON log,
   not in the IPC payload.

### 9.2 Byte-size measurement method for the front end

- `JSON.stringify(batch).length` counts **UTF-16 code units** and undercounts UTF-8 bytes for any
  non-ASCII content. Measured: a batch whose serde_json form is 79 bytes reports `.length === 68`
  (−14 %); the real `Envelope` example above is 182 serde bytes vs 171 UTF-16 units (−6 %).
  **[measured]** (node 2026-09-02; and `serde_json::to_string(...).len()` vs
  `.encode_utf16().count()` in Rust)
- The correct in-page byte count is `new TextEncoder().encode(s).length` (equivalently
  `new Blob([s]).size`) — both returned 79 for the case above. **[measured]**
- But even that measures *your* re-stringification, not Tauri's. **The only number the cliff
  actually compares against is `InvokeResponseBody::Json(json_string).len()` computed in Rust**
  (`src/ipc/channel.rs:156-158`). Measure in Rust, on the exact value you are about to `send`, and
  make the batcher's cap a Rust-side constant. Use the TS side only for cross-checking.
  **[source]** + **[asserted]**

---

## 10. Implications for the supervisor / commands layer

**Module shape.** Commands go in a `commands` module, `pub(crate)`, never in `lib.rs`, with
crate-unique identifiers (§1.6 — this is a hard compile error, measured). One
`generate_handler!`, one `invoke_handler` call (§2). This shape compiled clean:

```rust
// src-tauri/src/lib.rs
mod commands;
mod supervisor;

use supervisor::Supervisor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Supervisor::new())                       // asserts on a duplicate type
        .invoke_handler(tauri::generate_handler![
            commands::probe_claude,
            commands::list_projects,
            commands::start_session,
            commands::subscribe,
            commands::respond,
            commands::interrupt,
            commands::end_session,
        ])
        .setup(|app| {
            // Cheap and infallible only. An Err here PANICS (§4.1).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let sup = handle.state::<Supervisor>();
                sup.open_store(&handle).await;            // records its own failure for the UI
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } => {
                app_handle.state::<Supervisor>().sigterm_all();     // fast, non-blocking
            }
            tauri::RunEvent::Exit => {
                app_handle.state::<Supervisor>().reap_all();        // killpg + bounded wait; blocking is legal here
            }
            _ => {}
        });
}
```

```rust
// src-tauri/src/commands.rs
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[derive(Debug, thiserror::Error)]
pub(crate) enum CmdError {
    #[error("no such session: {0}")]
    NoSession(String),
    #[error("{0}")]
    Store(String),
}

// `#[from] std::io::Error` etc. make `#[derive(Serialize)]` impossible; serialize the message.
impl serde::Serialize for CmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub(crate) async fn start_session(
    project_id: String,                       // JS sends { projectId }
    model: String,
    sup: State<'_, Supervisor>,               // `'_` is mandatory in an async fn (E0726)
    app: AppHandle,
) -> Result<String, CmdError> {               // async + borrowed arg => MUST return Result
    sup.start(&app, &project_id, &model).await
}

#[tauri::command]
pub(crate) async fn subscribe(
    session_id: String,
    on_event: Channel<Vec<FeedRow>>,          // JS sends { sessionId, onEvent }
    sup: State<'_, Supervisor>,
) -> Result<(), CmdError> {
    sup.replace_feed(&session_id, on_event).await   // idempotent: StrictMode fires this twice
}
```

**Ten things that change the design:**

1. **A `pub` command in `lib.rs` does not compile.** Two E0255 errors per command. Submodule +
   `pub(crate)`, unique identifiers crate-wide. (§1.6, measured.)
2. **Every command that touches the supervisor mutex or the store must be `async`** — sync commands
   run on the main thread, which is also the thread draining the eval queue that carries the feed.
   (§1.1.)
3. **`setup` returning `Err` panics the process.** Open the store in a spawned task and surface the
   failure through a command, exactly as `probe_claude()` surfaces a missing `claude` binary.
   (§4.1.)
4. **Switch `.run(context)` to `.build(context)?.run(|h, e| …)`.** Today `src-tauri/src/lib.rs:11`
   uses the shorthand, which drops every `RunEvent` — there is currently no place to hang the kill
   sweep that `tauri-runtime.md` §5 says the supervisor must own. (§5.)
5. **Blocking in the `Exit` callback is legal and correct** — including
   `tauri::async_runtime::block_on`, because the main thread is not inside a tokio runtime. Do the
   SIGTERM on `ExitRequested` (window still visible, keep it short) and the killpg/SIGKILL sweep on
   `Exit`. (§5, measured.)
6. **`Channel<T>` is `Clone + Send + Sync` and lives happily in
   `Mutex<HashMap<SessionId, Channel<…>>>`** inside managed state. (§6, measured.)
7. **A reload silently eats every `send`.** `Ok(())` from Rust, one `console.warn` in the page. The
   front end must re-`subscribe` on mount, and `subscribe` must replace-by-key and replay a bounded
   tail. React StrictMode makes it fire twice in dev, so idempotence is not optional. (§6.1.)
8. **Strip `Envelope::raw` from the feed batch.** One envelope with a full 4 KiB excerpt is 4 279
   bytes; two of them cross the 8192 cliff on their own and head-of-line block the channel.
   (§9.1, measured.)
9. **Hoist `instance_id`/`session_id`/`at` into a batch header.** 110 of 217 bytes per terse
   envelope is constant framing; removing it roughly doubles events-per-batch. Cap the batcher in
   Rust by `serde_json::to_string(&batch).len()`, not by row count — `JSON.stringify().length` in
   the webview undercounts UTF-8 by up to ~15 %. (§9, measured.)
10. **No capability work is needed for our own commands** (§3.1) — but do not create
    `src-tauri/permissions/` or set `AppManifest::commands` in `build.rs` without also writing every
    capability entry, because either one flips `has_app_acl_manifest` and every unlisted command
    starts rejecting. And **drop `tauri-plugin-opener` in all four places at once** (Cargo dep,
    `.plugin()` call, capability entry, npm dep) or the build fails in `validate_capabilities`.
    (§3.3.)

---

## 11. Contradictions and corrections

- **`docs/research/tauri-runtime.md` §5, last bullet** — *"Do not put long-running work in `setup`
  itself — it blocks the main thread before the window appears."* The mechanism is right, the timing
  is wrong: `setup` runs on `RuntimeRunEvent::Ready`, **after** `WebviewWindowBuilder::from_config`
  has created every configured window (`tauri-2.11.5/src/app.rs:2521-2534`, called from
  `:1420-1424`). So the window is already on screen and the symptom is a frozen window, not a
  missing one. The advice stands; the reason changes. **[source]**
- **`docs/research/tauri-runtime.md` §5** cites `Builder::manage` at `src/app.rs:1943-1949` and
  `Manager::manage` at `src/lib.rs:688-693`. Both are correct in 2.11.5; §5 does not mention that
  `Manager::manage` returns `false` on a duplicate while `Builder::manage` **panics**. Noted here in
  §4. No contradiction.
- **`docs/plans/next-session.md`** — no contradictions found. Its command list
  (`list_projects`, `add_project`, `probe_claude`, `start_session`, `send_turn`, `respond`,
  `interrupt`, `end_session`, `kill`, `feed_tail`, `pending_approvals`) is implementable as written
  and needs no capability entries. Two additions it does not yet include: a **`subscribe(session_id,
  Channel)`** command (§6.1 — without one, a reload permanently silences the feed), and the
  `.build()?.run(|h, e| …)` switch its pid-file/kill-sweep item implicitly requires (§5, point 4
  above).
- **`CLAUDE.md` §2** — *"Never `claude -p` … Use the Agent SDK `query()` with an
  `AsyncIterable<SDKUserMessage>` prompt (streaming input mode)."* This is stale relative to
  `docs/research/claude-direct-spike.md` and the same file's own §2 first bullet (Rust speaks the
  stdio protocol directly, no Node, no SDK). Out of scope for this brief; flagged, not changed.

---

## 12. macOS ⌘Q reaches `RunEvent::Exit` without `RunEvent::ExitRequested`

Date: 2026-09-02. This section corrects the assumption §5 leaves standing — that `ExitRequested`
always precedes `Exit`, so the graceful teardown can hang off `ExitRequested` alone. On macOS it
does not, and the cost was a lost transcript and a session row stuck at `running`.

### The two ways `ExitRequested` is raised, and the one way `Exit` is

`tauri-runtime-wry-2.11.4/src/lib.rs` has exactly **two** `callback(RunEvent::ExitRequested …)`
sites and **one** `callback(RunEvent::Exit)` site: **[source]**

- **`ExitRequested`, path 1 — all windows closed.** `Event::WindowEvent` /
  `TaoWindowEvent::Destroyed` removes the window from the map, and *only if the map is then
  empty* fires `callback(RunEvent::ExitRequested { code: None, tx })`, reads `tx` for
  `ExitRequestedEventAction::Prevent`, and otherwise sets `ControlFlow::Exit`.
  `tauri-runtime-wry-2.11.4/src/lib.rs:4310-4326` **[source]**
- **`ExitRequested`, path 2 — `Message::RequestExit(code)`.** The user event
  `AppHandle::exit`/`restart` posts (`tauri-2.11.5/src/app.rs:573-580` →
  `tauri-runtime-wry-2.11.4/src/lib.rs:2748-2756`) is answered with
  `callback(RunEvent::ExitRequested { code: Some(code), tx })`, the same `Prevent` check, then
  `ControlFlow::Exit`. `tauri-runtime-wry-2.11.4/src/lib.rs:4354-4366` **[source]**
- **`Exit` — one site, `Event::LoopDestroyed`.** `Event::LoopDestroyed => callback(RunEvent::Exit)`.
  `tauri-runtime-wry-2.11.4/src/lib.rs:4185-4187` **[source]** Tauri forwards it unchanged
  (`RuntimeRunEvent::Exit => RunEvent::Exit`, `tauri-2.11.5/src/app.rs:2551`) and calls the app
  callback **before** `cleanup_before_exit` (`tauri-2.11.5/src/app.rs:1430-1437`).

So the two events are wired to structurally different sources. `ExitRequested` needs either a
window `Destroyed` or a `RequestExit` user event; `Exit` needs only tao's `LoopDestroyed`.

### ⌘Q emits `LoopDestroyed` directly, and neither `ExitRequested` source ever fires

`tao-0.35.3` implements **`applicationWillTerminate:`** on its app delegate and
**not `applicationShouldTerminate:`** — `grep -rn applicationShouldTerminate` over
`tao-0.35.3/src`, `tauri-runtime-wry-2.11.4/src` and `tauri-2.11.5/src` returns **nothing**.
`tao-0.35.3/src/platform_impl/macos/app_delegate.rs:62-65` registers the selector;
`:131-135` is the handler, whose whole body is `AppState::exit()`. **[source]**

`AppState::exit` fires `Event::LoopDestroyed` at the event handler and then drops the callback:
`HANDLER.handle_nonuser_event(EventWrapper::StaticEvent(Event::LoopDestroyed))`,
`tao-0.35.3/src/platform_impl/macos/app_state.rs:272-282`. **[source]**

⌘Q therefore runs `NSApplication.terminate:` → (no `applicationShouldTerminate:` override, so
AppKit proceeds) → `applicationWillTerminate:` → `LoopDestroyed` → `RunEvent::Exit`. The window is
torn down by AppKit's own termination, not by a tao `WindowEvent::Destroyed` delivered through the
loop, and nothing posts `Message::RequestExit`. **Neither** `ExitRequested` site is reachable on
this path. **[source]**

### Measured on the real app

Release build, macOS 26.5, ⌘Q with one live `claude` child and its session tracked. The log
carried exactly two lines: `brigadier_proc::tracker: shutdown kill …
action=Killed { members: 2, escalated: false }` and `brigadier_lib::state: exit sweep …`, both
emitted from `AppState::final_sweep` in the `RunEvent::Exit` arm. Nothing from the
`RunEvent::ExitRequested` arm ran — no `dropped on shutdown` debug line from
`Supervisor::shutdown_sync`, no teardown warning. The store row stayed `status=running` with no
`ended_at`, and the session's `RawLog` file was **0 bytes**: its 64 KB `BufWriter` was never
flushed, because the consumer task was aborted rather than allowed to finish. **[measured]**

### Consequences for this repo

- The graceful shutdown must run from the **`Exit`** arm, not only from `ExitRequested`. It is
  wired to both, and `AppState::shutdown_sync` is idempotent — an empty live map returns
  immediately — so the paths that *do* raise `ExitRequested` (last window closed, and the
  `SIGTERM`/`SIGINT` hook via `AppHandle::exit`) do not pay two grace periods.
  `src-tauri/src/lib.rs:112-126`, `src-tauri/src/state.rs:116-126`.
- Blocking in the `Exit` callback is legal (§5, "Can the callback block?"), and by
  `tauri-2.11.5/src/app.rs:1430-1437` it runs before `cleanup_before_exit`, so Tauri APIs are
  still usable there.
- Buffered per-session state cannot rely on a graceful path existing at all. The raw log now
  flushes on `TurnCompleted`, `TurnAborted`, `SessionExited` and `RequestOpened`, and otherwise at
  most once per 250 ms — `crates/supervisor/src/lib.rs:65-73` and `:558-604` (`LoggedRaw`).

### Not checked in §12

- **`ExitRequested` on ⌘Q was ruled out by source, not by instrumenting the arm.** The measured
  evidence is the *absence* of that arm's log lines, which is consistent with the source reading
  but is not the same as tracing `applicationWillTerminate:`.
- The AppKit step before `applicationWillTerminate:` (whether ⌘Q reaches it via
  `NSApplication.terminate:` and the default `NSTerminateNow`) is read from Apple's documented
  termination sequence plus the absence of an override; no Objective-C breakpoint was set.
- The dock-menu Quit, `killall`, and a force-quit were not tried; only ⌘Q was.
- Windows and Linux were not exercised. Their `LoopDestroyed`/`ExitRequested` ordering may differ
  and nothing here should be assumed to carry over.
- Whether Tauri's own tray or menu plugins can interpose an `ExitRequested` on ⌘Q was not
  investigated; this app registers neither.

---

## Not checked

- **No Tauri app was run.** Everything here is source-read or compile-checked. The probe crate
  passes `cargo check`; it was never `cargo run`, never bundled, and no IPC message was actually
  sent. The 8192-byte cliff's runtime effect on our payloads remains unmeasured, as
  `tauri-runtime.md` already said.
- The reload behaviour in §6.1 is derived from source (`scripts/core.js:39-46`, the callback map,
  the fire-and-forget `eval`) — **not reproduced in a running app.** Nobody reloaded a webview and
  watched a `send` disappear.
- `#[tauri::command(rename = "…")]` was compiled but the renamed command was never invoked from JS,
  so "JS must call the renamed string" is read from `handler.rs:139-179`, not observed.
- The thread on which a *sync* command body runs is Tauri's documented claim plus the macro
  expansion; the wry/WKWebView URL-scheme-handler dispatch queue was not traced to prove it is the
  main thread.
- Devtools: the ⌘⌥I hotkey, right-click Inspect, and `open_devtools()` were read in wry/Tauri
  source and the Tauri docs. **None was exercised** — `npm run tauri dev` has never been run in this
  repo (`docs/plans/next-session.md` step 6). Whether Safari's Web Inspector gives a usable
  frame-rate instrument for a WKWebView was not tested.
- `isTauri()` / `window.__TAURI_INTERNALS__` absence in a plain `vite dev` browser tab is reasoned
  from the init-script injection point, not observed.
- Windows and Linux: `is_local` URL rules, the WebView2 8192 threshold, `internal_toggle_devtools`
  behaviour and process-group teardown were read but not exercised. `killpg` is unix-only.
- The ACL: `has_app_acl_manifest = false` for this repo was established from the absence of
  `src-tauri/permissions/` and a bare `build.rs`, plus the `tauri-build` source. It was not proved
  by invoking a command from a running webview. Remote-origin behaviour (`!is_local`) was not
  exercised at all.
- `core:default`'s exact membership is derived from `tauri-2.11.5/build.rs`'s `PLUGINS` table, not
  from the generated `src-tauri/gen/schemas/acl-manifests.json` (which is 69 KB and was only
  spot-checked).
- `serde_json` key ordering vs `JSON.stringify` key ordering was not compared; the §9.2 advice
  ("measure in Rust") sidesteps it.
- No benchmark of async-command latency vs sync-command latency, and no measurement of how long a
  blocking `RunEvent::Exit` callback can run before macOS force-terminates the app.
- The React StrictMode double-invoke claim is standard React behaviour, asserted from the presence
  of `<React.StrictMode>` in `src/main.tsx:11-13`; the React 19.2 docs were not fetched.
