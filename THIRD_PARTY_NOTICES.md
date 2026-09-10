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

Package dependencies are not covered — see §2.

---

## 1. Where the licence copy reaches

**Removed 2026-09-10: the janhq/jan Apache-2.0 entry and `licenses/Apache-2.0.txt`.** Its only
covered file, `src/providers/ThemeProvider.tsx`, was deleted when the app went dark-only (owner
decision 2026-09-10). No file under `src/`, `src-tauri/src/` or `crates/` cites janhq/jan, Menlo
Research or Apache-2.0 any more [measured 2026-09-10, `grep -rn`]. `docs/research/jan.md` and
`docs/research/oklch-tokens.md` still discuss Jan; they are notes on an upstream project, not
vendored code, and carry no notice condition.

The `licenses/` texts that remain reach anyone who has the repository. **They do not reach the built
`brigadier.app`**: `src-tauri/tauri.conf.json`'s `bundle` block declares no `licenseFile` and no
`resources`. Two built bundle trees exist on this machine —
`target/release/bundle/macos/brigadier.app` (built 2026-09-02 20:52) and
`src-tauri/target/release/bundle/macos/brigadier.app` (built 2026-09-01 16:49). Each one's
`Contents/Resources/` holds `icon.icns` (98,451 bytes) and nothing else [measured, 2026-09-02].

Nothing is distributed yet — signing and notarization are out of phase (`docs/plans/phase-4.md`,
"Not in this phase"), so no recipient exists outside the repository. Whether the bundle must carry
the text is an owner decision, deferred, not answered here.

---

## 2. Not covered by this file

- **`npm` dependencies.** 7 packages in the production closure of `package.json`: 5 MIT, 2
  MIT/Apache-2.0 dual [measured, `package-lock.json` + `node_modules/*/package.json`]. No notice
  entry written for any of them.
- **`cargo` dependencies.** 500 entries in `Cargo.lock` [measured, `grep -c '^name = '`], not
  classified by licence. `cargo metadata --offline` fails on an uncached crate, so no breakdown was
  produced.
- Both carry notice conditions of their own on distribution. A full dependency-notice sweep is its
  own work order and has not been done.

---

## 3. What was not checked

- **No legal review. This is not legal advice.** Anything turning on interpretation — including
  whether §1's bundle question needs answering before release, and whether removing a notice for a
  deleted file is the right call — is the owner's decision.
- The removal of the Jan entry was checked by grep over `src/`, `src-tauri/src/` and `crates/` only.
  Nothing was re-diffed against upstream, and `docs/` was not swept for stale Jan citations beyond
  the two research files named in §1.

## assistant-ui — MIT

Source: [assistant-ui Elements and registry](https://github.com/assistant-ui/assistant-ui), retrieved 2026-09-07. Copyright (c) 2025 AgentbaseAI Inc. License: [assistant-ui-MIT.txt](licenses/assistant-ui-MIT.txt).

Adapted components live in `src/components/assistant-ui/elements`: thread, composer, Markdown, reasoning, tool calls, approval cards, artifact cards, agent status and plans. The standalone Chat Panel, Message Actions, Reasoning Panel, Tool Call and Thinking Indicator were installed from the shadcn registry on 2026-09-09, together with surfaces, range and the Radix Collapsible dependency. These conversation disclosures use Radix; other controls retain their existing native implementations. Brigadier supplies existing backend state, safe file navigation, independent phase states and approval decisions. `src/hooks/use-copy-to-clipboard.ts` is from the same registry.

The composer provider selector adapts the segmented button section of [Settings Panel](https://r.assistant-ui.com/elements-settings-panel.json) and the `field` token from [Elements surfaces](https://r.assistant-ui.com/elements-surfaces.json), retrieved 2026-09-09, under the same assistant-ui MIT license.

## Radix UI — MIT

The installed shadcn Collapsible uses `radix-ui` 1.6.7. Copyright (c) 2022 WorkOS. License: [radix-ui-MIT.txt](licenses/radix-ui-MIT.txt).

## @openai/apps-sdk-ui — MIT

[`@openai/apps-sdk-ui`](https://github.com/openai/apps-sdk-ui) 0.2.2 — MIT, Copyright 2025 OpenAI. The icons under `src/icons/` are generated copies of its SVG components; full licence text in `src/icons/LICENSE.md`.

## tw-shimmer — MIT

The assistant-ui Elements surface helpers use `tw-shimmer` 0.4.12. Copyright (c) 2025 AgentbaseAI Inc. License: [tw-shimmer-MIT.txt](licenses/tw-shimmer-MIT.txt).
