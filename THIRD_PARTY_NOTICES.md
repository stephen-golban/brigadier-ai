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

**Stale as of 2026-09-11, corrected here: the "Radix UI — MIT" entry.** The design-system
migration (`216d45e`, 2026-09-10) overwrote the one vendored file that used it —
`src/components/ui/collapsible.tsx` — with the assistant-ui kit's Base UI twin;
`src/components/ui/UPSTREAM.md` records "`radix-ui` was removed 2026-09-10 with the last Radix
import; nothing under `src/` imports it" [measured, `grep -rn "radix-ui\|@radix-ui" src/`: no
import site, only prose mentions in `UPSTREAM.md` and two source-code comments describing packages
*not* taken]. `package.json` carries no `radix-ui` dependency. The entry below is replaced by a
"Base UI — MIT" entry. `licenses/radix-ui-MIT.txt` is now unreferenced by this file but is **not
deleted by this edit** — this worker's owned path is `THIRD_PARTY_NOTICES.md` only; removing the
stale licence text is a follow-up.

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

Adapted components live in `src/components/assistant-ui/elements`: thread, composer, Markdown, reasoning, tool calls, approval cards, artifact cards, agent status and plans. The standalone Chat Panel, Message Actions, Reasoning Panel, Tool Call and Thinking Indicator were installed from the shadcn registry on 2026-09-09, together with surfaces and range. Brigadier supplies existing backend state, safe file navigation, independent phase states and approval decisions. `src/hooks/use-copy-to-clipboard.ts` is from the same registry.

The composer provider selector adapts the segmented button section of [Settings Panel](https://r.assistant-ui.com/elements-settings-panel.json) and the `field` token from [Elements surfaces](https://r.assistant-ui.com/elements-surfaces.json), retrieved 2026-09-09, under the same assistant-ui MIT license.

`src/components/ui/` is a second, larger vendored set copied 2026-09-10 from two sources under the same MIT terms: the assistant-ui kit's `base/` directory (`packages/ui/src/components/react/ui/base/`, same project and copyright as above) and the shadcn registry at style `base-nova`. 28 files, full per-file provenance (source, SHA/version, deviations) in `src/components/ui/UPSTREAM.md`. Its `collapsible.tsx` is the kit's `base/collapsible.tsx`, on Base UI — it **overwrote** the pre-port `radix-ui`-based file of the same name that day; brigadier's Collapsible has used Base UI, not Radix, since 2026-09-10.

## Base UI — MIT

`src/components/ui/`'s primitives (the migration replacing Radix, `216d45e`/`a4e46eb`, 2026-09-10/11) are `@base-ui/react` 1.8.0. Copyright (c) 2019 Material-UI SAS [from `node_modules/@base-ui/react/LICENSE` and `package.json`, 2026-09-11]. License: MIT — text not yet copied to `licenses/base-ui-MIT.txt` by this edit (out of scope; see the §1 note above), full text at `node_modules/@base-ui/react/LICENSE` in the meantime.

## @openai/apps-sdk-ui — MIT

[`@openai/apps-sdk-ui`](https://github.com/openai/apps-sdk-ui) 0.2.2 — MIT, Copyright 2025 OpenAI. The icons under `src/icons/` are generated copies of its SVG components; full licence text in `src/icons/LICENSE.md`.

## tw-shimmer — MIT

The assistant-ui Elements surface helpers use `tw-shimmer` 0.4.12. Copyright (c) 2025 AgentbaseAI Inc. License: [tw-shimmer-MIT.txt](licenses/tw-shimmer-MIT.txt).

## codex-ui-kit — MIT (pre-registered 2026-09-11; not yet vendored)

**No files from this project are in the tree as of this entry.** A later phase will vendor a
subset of its source files; this section is written to stay accurate both before and after that
lands, so it is not removed once the code arrives — only its "not yet vendored" framing needs
updating then.

Source: [codex-ui-kit](https://github.com/JaminZhou/codex-ui-kit), pinned at commit
`9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d`. Copyright (c) 2026 JaminZhou. License: MIT, reproduced
below from the upstream `LICENSE` file (not yet copied to `licenses/codex-ui-kit-MIT.txt` — out of
scope for this edit, see §1):

```
MIT License

Copyright (c) 2026 JaminZhou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

When the vendoring lands, the copied files will be **modified** from upstream: CSS custom
properties and class names are renamed from a `codex-ui-` prefix to brigadier's own. codex-ui-kit
is an unofficial, independent project, **not affiliated with, sponsored by, or endorsed by
OpenAI**; "Codex" and "OpenAI" are trademarks of OpenAI.

**Excluded from the vendoring:** the five subagent avatar SVGs under the kit's
`src/assets/subagents/` are not copied. The kit's own `src/assets/subagents/README.md` states they
were captured from the rendered Codex Desktop app, remain OpenAI's copyright, and are not
relicensed under the kit's MIT license. No OpenAI brand assets, fonts, logos, sounds or
illustrations are shipped by brigadier.
