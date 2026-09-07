# THIRD_PARTY_NOTICES

Notices for third-party code **vendored** into this repository — source files copied from another
project and adapted in place, rather than resolved as a package by `npm` or `cargo`. It exists to
carry the notice conditions those projects' licences attach to redistribution.

**This file does not license brigadier.** `licenses/` holds other projects' licence texts only,
and nothing here declares a licence for this project.

brigadier's own licence metadata is partial and inconsistent, and this file does not resolve it
[measured, 2026-09-02]. `Cargo.toml:7` sets `license = "MIT"` on `[workspace.package]`, and six
crates inherit it — `crates/{claude-spike,claude-wire,core,proc,store,supervisor}/Cargo.toml:5`,
each `license.workspace = true`. `src-tauri/Cargo.toml`'s `[package]` does not inherit it: it has
no `license` and no `license.workspace = true`. `package.json` has no `license` field. No MIT text
exists anywhere in this repository. That is the owner's decision to settle; this file recommends no
resolution and no manifest was touched.

Package dependencies are not covered — see §3.

---

## 1. janhq/jan — Apache License 2.0

| | |
|---|---|
| Upstream project | `janhq/jan` — <https://github.com/janhq/jan> |
| Copyright | `Copyright 2025 Menlo Research` — upstream `LICENSE:3` [measured], `docs/research/jan.md` §1 |
| Upstream file taken | `web-app/src/providers/ThemeProvider.tsx` (79 lines) |
| Read at upstream commit | `9e12b2a80edb98a2776637f4ab2c5bee953c5cb3` (2026-08-29) |
| Local path | `src/providers/ThemeProvider.tsx` |
| Licence | Apache License, Version 2.0 |
| Licence text in this repo | `licenses/Apache-2.0.txt` |
| Modified | **yes** |
| Files taken from Jan, total | **1** |

**The file was modified.** Apache-2.0 §4(b) requires a changed file to carry a prominent notice
that it changed. `src/providers/ThemeProvider.tsx:1-41` carries that notice and lists the three
adaptations: React context plus `localStorage` in place of Jan's zustand store, a runtime user-agent
sniff in place of Jan's `IS_LINUX` build-time define, and every Tauri call behind `isTauri()`.
Jan's structure, its `applyIfAuto` race fix and its Linux desktop-portal fallback are theirs.

### 1.1 The directory boundary — read this before taking a second Jan file

Only `web-app/src/**` may be copied. `web-app/` declares no `license` field of its own, so the root
Apache-2.0 governs it (`docs/research/jan.md` §1) [measured].

**No file from `core/` or `extensions/` has been copied.** Those paths declare `AGPL-3.0` in their
`package.json` — `core/package.json:10` and six `extensions/*` [measured]. `docs/research/jan.md` §1
reads those strings as leftovers of the AGPL→Apache relicense at `e8ca7f3c`, which changed only the
`LICENSE` file; that reading is tagged **[asserted]** there, because no maintainer statement was
found. It is not settled. Treat `core/` and `extensions/` as AGPL-3.0 until it is.

### 1.2 Trademarks

Apache-2.0 §6 grants no trademark rights (`licenses/Apache-2.0.txt:139-144`). No Jan product name,
wordmark, logo or brand colour is shipped in this repository — `docs/plans/phase-4.md` records that
as a hard constraint on the frontend wave.

---

## 2. Where the licence copy reaches

`licenses/Apache-2.0.txt` reaches anyone who has the repository. **It does not reach the built
`brigadier.app`**: `src-tauri/tauri.conf.json`'s `bundle` block declares no `licenseFile` and no
`resources`. Two built bundle trees exist on this machine —
`target/release/bundle/macos/brigadier.app` (built 2026-09-02 20:52) and
`src-tauri/target/release/bundle/macos/brigadier.app` (built 2026-09-01 16:49). Each one's
`Contents/Resources/` holds `icon.icns` (98,451 bytes) and nothing else [measured, 2026-09-02].

Nothing is distributed yet — signing and notarization are out of phase (`docs/plans/phase-4.md`,
"Not in this phase"), so no recipient exists outside the repository. Whether the bundle must carry
the text is an owner decision, deferred, not answered here.

---

## 3. Not covered by this file

- **`npm` dependencies.** 7 packages in the production closure of `package.json`: 5 MIT, 2
  MIT/Apache-2.0 dual [measured, `package-lock.json` + `node_modules/*/package.json`]. No notice
  entry written for any of them.
- **`cargo` dependencies.** 500 entries in `Cargo.lock` [measured, `grep -c '^name = '`], not
  classified by licence. `cargo metadata --offline` fails on an uncached crate, so no breakdown was
  produced.
- Both carry notice conditions of their own on distribution. A full dependency-notice sweep is its
  own work order and has not been done.

---

## 4. What was not checked

- **No legal review. This is not legal advice.** Anything turning on interpretation — including
  whether §1.1's boundary is sufficient and whether §2's bundle question needs answering before
  release — is the owner's decision.
- Jan's `LICENSE` was not re-read for this file; the `LICENSE:3` quote is carried
  from `docs/research/jan.md` §1, which read it at the commit named in §1.
- No upstream issue was opened asking whether the `core/` and `extensions/` AGPL fields are stale.
  `docs/research/jan.md` §1 names that as the one-line de-risk.
- `src/providers/ThemeProvider.tsx` was not re-diffed against upstream for this file; the change
  list in §1 is that file's own in-file notice.

## Shared button — MIT

`src/components/ui/button.tsx` is adapted from ibelick/prompt-kit at `de80375967400aa0c6ebab9d3ba4f9258ab79fcc`. Source: https://github.com/ibelick/prompt-kit. Copyright (c) 2025 Julien Thibeaut. License: [prompt-kit-MIT.txt](licenses/prompt-kit-MIT.txt). It uses the existing desktop palette.

## shadcn/ui Input

`src/components/ui/input.tsx` is adapted from the shadcn/ui New York Input registry at https://ui.shadcn.com/r/styles/new-york/input.json (retrieved 2026-09-07). Copyright (c) 2023 shadcn. MIT licence: [shadcn-ui-MIT.txt](licenses/shadcn-ui-MIT.txt).
