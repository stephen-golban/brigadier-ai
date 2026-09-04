# tauri-plugin-dialog and tauri-plugin-opener — the two plugins the project-open flow needs

Written 2026-09-04 for Order P ("the project-open flow"). Every line is tagged **[measured]** (I
ran it or read it out of a file on this machine), **[source]** (read in vendored code, `file:line`)
or **[documented]** (vendor docs, with the URL and the date I read it). Nothing here is from
memory, per `CLAUDE.md` §1.

What this file does **not** cover is stated in §5, and the largest gap is that **none of this has
been clicked in a real window**. Every claim below is about names, types and permission files, not
about a picker that opened on someone's screen.

---

## 1. Why a research file exists for what looks like an `npm install`

The order this file was written for warned that "a Tauri v2 plugin that is installed but not
permitted fails at runtime, not at build time — that is the trap." **Half of that is measurably
wrong on this repo, and the half that is right is the more dangerous half.**

### 1.1 A *misspelled* identifier fails at build time, loudly [measured 2026-09-04]

`tauri-build` resolves every string in `capabilities/*.json` against the ACL manifests of the
plugins actually in the dependency graph, from inside `build.rs`. I changed `dialog:allow-open` to
`dialog:allow-nonsense` and ran `cargo check -p brigadier`:

```
cargo exit 101
error: failed to run custom build command for `brigadier v0.1.0`
  Permission dialog:allow-nonsense not found, expected one of core:default, …,
  dialog:default, dialog:allow-ask, dialog:allow-confirm, dialog:allow-message,
  dialog:allow-open, dialog:allow-save, dialog:deny-…, opener:default,
  opener:allow-default-urls, opener:allow-open-path, opener:allow-open-url,
  opener:allow-reveal-item-in-dir, opener:deny-…
```

That error is worth more than any doc page: **it is the resolver enumerating the complete, live set
of identifiers this app can grant**, and it independently confirms every identifier §2 and §3
quote out of the crates' TOML. The capability file was restored and `cargo check -p brigadier` is
back to exit 0.

### 1.2 An *omitted* identifier fails at runtime, silently [documented, not measured]

The build-time check runs in one direction only. It rejects a permission that does not exist; it
has no way to know which permissions the webview's JavaScript is going to need, so a capability
that simply never mentions `dialog:allow-open` builds clean and rejects the first `open()` call at
runtime. **That is the real trap, and nothing in the toolchain catches it** — no test in this repo
does either, because reaching it needs a live webview.

So: a typo is caught by `cargo check`; a forgotten grant is caught by a person clicking the button.
Which is why §4 states the full permission list rather than only the line that changed.

---

## 2. `tauri-plugin-dialog` — the native directory picker

### Versions

- Rust crate `tauri-plugin-dialog`, newest release **2.7.3**, published 2026-08-31
  [documented, `https://crates.io/api/v1/crates/tauri-plugin-dialog`, read 2026-09-04].
- Resolved into this repo as `tauri-plugin-dialog v2.7.3` [measured, `cargo fetch` output,
  2026-09-04]. It pulls three new direct dependencies of its own: `rfd v0.16.0`,
  `tauri-plugin-fs v2.5.2`, and the `windows-*` family [measured, same run].
- npm package `@tauri-apps/plugin-dialog`, installed at **2.7.3**
  [measured, `node_modules/@tauri-apps/plugin-dialog/package.json`]. Its only dependency is
  `@tauri-apps/api ^2.11.0` [source, same file].

### Registration (Rust)

```rust
.plugin(tauri_plugin_dialog::init())
```

[documented, `https://v2.tauri.app/plugin/dialog/`, read 2026-09-04]. Added at
`src-tauri/src/lib.rs:110`, immediately after `tauri_plugin_opener::init()`.

### The JS call for a directory

```ts
import { open } from "@tauri-apps/plugin-dialog";
const picked = await open({ directory: true, multiple: false, title: "…" });
```

- The exported function is `open`, declared
  `declare function open<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>>`
  [source, `node_modules/@tauri-apps/plugin-dialog/dist-js/index.d.ts:294`].
- `OpenDialogOptions` carries `multiple?: boolean` and `directory?: boolean`
  [source, same file, lines 55 and 57], alongside `title`, `defaultPath`, `filters`, `recursive`,
  `canCreateDirectories`.
- The return type is computed:
  `T['directory'] extends true ? T['multiple'] extends true ? string[] | null : string | null : …`
  [source, same file, line 241]. So `{ directory: true, multiple: false }` is typed
  **`string | null`**.
- **`null` is the cancel signal.** The plugin's own doc comment reads
  `} else if (selected === null) { // user cancelled the selection`
  [source, same file, lines 264 and 283].

**Consequence for the code:** a cancelled picker is indistinguishable from a successful one except
by the `null`, and it must not be reported as an error. `src/App.tsx`'s `pickProject` returns
`null` (no error, no project) on that branch.

### Permission identifiers

The plugin defines exactly three command permissions, each with an allow and a deny form
[source, `~/.cargo/registry/src/index.crates.io-…/tauri-plugin-dialog-2.7.3/permissions/autogenerated/commands/`,
which contains `message.toml`, `open.toml`, `save.toml`]:

| identifier | command it unlocks |
| --- | --- |
| `dialog:allow-open` / `dialog:deny-open` | `open` — the file/directory picker |
| `dialog:allow-save` / `dialog:deny-save` | `save` |
| `dialog:allow-message` / `dialog:deny-message` | `message`, and the `ask`/`confirm` aliases |

`dialog:default` is `permissions = ["allow-message", "allow-save", "allow-open"]`
[source, `…/tauri-plugin-dialog-2.7.3/permissions/default.toml`].

**What this repo grants: `dialog:allow-open` only**, in `src-tauri/capabilities/default.json`.
`dialog:default` would additionally hand the webview `save` and `message`, and nothing in `src/`
calls either — `open` is the only name imported from the plugin anywhere in `src/`
(`src/bridge.ts:13`), re-checked by grep 2026-09-04 [measured]. Least privilege.

**Stated precisely, because the loose version of this sentence is the defect §1.2 exists to name:**
adding a `save()` call later would *not* fail at build time. Per §1.1 the resolver only rejects
identifiers that do not exist, so the capability would still build clean and the new call would be
rejected on the first click. Choosing `allow-open` buys a smaller granted surface, not an earlier
warning.

**Not needed:** no `fs:` permission. `tauri-plugin-fs` arrives as a transitive Cargo dependency of
the dialog plugin, but it is not registered as a plugin in `lib.rs` and no `fs:` identifier is in
the capability [measured, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`].
**Not checked:** whether a *file* (rather than directory) dialog with `fileAccessMode` set would
need one. This app never opens a file dialog.

---

## 3. `tauri-plugin-opener` — revealing a path in Finder

This was already a dependency and, until this order, **a dead one**: `tauri_plugin_opener::init()`
was registered at `src-tauri/src/lib.rs:109` and no file under `src/` imported the package
[measured by grep, 2026-09-04].

- Locked at **2.5.5** [measured, `Cargo.lock:3749–3750`]; npm `@tauri-apps/plugin-opener` also
  **2.5.5** [measured, `node_modules/@tauri-apps/plugin-opener/package.json`].
- Three exports: `openPath`, `openUrl`, `revealItemInDir`
  [source, `node_modules/@tauri-apps/plugin-opener/dist-js/index.js:95`].
- The reveal call is
  `export declare function revealItemInDir(path: string | string[]): Promise<void>`
  [source, `…/plugin-opener/dist-js/index.d.ts:58`]. It accepts an array; this app passes one
  string.

### Permission identifiers

```toml
[default]
permissions = [
  "allow-open-url",
  "allow-reveal-item-in-dir",
  "allow-default-urls",
]
```

[source, `~/.cargo/registry/src/index.crates.io-…/tauri-plugin-opener-2.5.5/permissions/default.toml`].

`allow-reveal-item-in-dir` unlocks the `reveal_item_in_dir` command "without any pre-configured
scope" [source, `…/permissions/autogenerated/commands/reveal_item_in_dir.toml`].

**Consequence: `opener:default` — already in `src-tauri/capabilities/default.json` — is enough for
`revealItemInDir`, and no scope entry is required.** No capability change was needed for P2.

Note the asymmetry, because it is the kind of thing that gets assumed the wrong way round:
`opener:default` includes `allow-reveal-item-in-dir` but **not** `allow-open-path`. If anyone later
wants `openPath` (open a folder *in* Finder rather than reveal it), that is a new identifier.

---

## 4. What went into the capability file

`src-tauri/capabilities/default.json`, complete:

```json
"permissions": ["core:default", "opener:default", "dialog:allow-open"]
```

`dialog:allow-open` is the one line added by this order. `opener:default` was already there and
already sufficient.

---

## 5. What was not checked, stated plainly

- **Nothing here has been clicked in a real window.** `npm run tauri build` is the lead's to run,
  not this order's, so no macOS picker has been opened, no Finder window has been revealed, and
  the capability has never been exercised by a running webview. The permission identifiers are
  read out of the crates' own TOML and confirmed by the resolver's own error message (§1.1),
  which is the strongest evidence available without a build — and it still does not prove that
  `dialog:allow-open` is *sufficient*, only that it is real and granted. Per §1.2, sufficiency is
  only ever proven by a click.
- Whether `open()` on macOS returns a path with a trailing slash, or a resolved symlink, was not
  determined. `add_project` in Rust does its own canonicalisation and its own
  is-this-a-repo-root check, and the front end deliberately does not second-guess it.
- The `pickerMode` and `fileAccessMode` options exist in `OpenDialogOptions` [source, `index.d.ts`]
  and are left unset. Their macOS behaviour was not investigated.
- No claim is made about iOS/Android, where the dialog plugin has a separate mobile path.

---

## 6. Sources

- `https://v2.tauri.app/plugin/dialog/` — read 2026-09-04.
- `https://v2.tauri.app/plugin/opener/` — read 2026-09-04.
- `https://crates.io/api/v1/crates/tauri-plugin-dialog` — read 2026-09-04.
- Vendored crate sources under
  `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/` for both plugins, and the two npm
  packages under `node_modules/@tauri-apps/`.
