# Frontend stack: test runner, Tailwind 4, Radix + shadcn/ui

Researched 2026-09-02 against the live npm registry, the live shadcn registry, and a throwaway
project in the scratchpad that reproduces this repo's build byte for byte. Nothing in this file
was answered from memory.

**Nothing in the repo was installed or modified.** Every `[measured]` line below was run in
`/private/tmp/claude-501/.../scratchpad/{probe,peer,shad,reg}`, a copy of `src/` plus the target
dependencies. The copy's baseline build is `262.69 kB` JS / `12.69 kB` CSS — identical to the
repo's own numbers, which is what makes the deltas here comparable.

---

## Bottom line up front

1. **`jsdom` gives `feedStore.ts` a real `requestAnimationFrame`, and Vitest's default fake timers
   already fake it.** `vi.useFakeTimers()` with *no* `toFake` list drives the drain loop at 16 ms
   steps and fakes `performance.now` too. `environment: "node"` fails on line 1 of `start()`.
   **[measured]**, end to end, against this repo's actual `src/feedStore.ts` — see §1.2.
2. **Test isolation needs no change to `feedStore.ts`.** `vi.resetModules()` in `afterEach` plus
   `const fs = await import("./feedStore")` per test gives a store with `version: 0` and empty
   rings. **[measured]** — §1.6.
3. **Tailwind 4 costs zero JS. shadcn costs 159.91 kB of it.** `262.69 kB → 262.69 kB` with
   Tailwind added; `262.69 kB → 422.60 kB` (+50.85 kB gzip) once the eight shadcn components are
   imported. CSS `12.69 kB → 31.88 kB`. **[measured]** — §2.5 and §3.4.
4. **A `@/` path alias is required, and its absence fails silently.** Without `paths` in
   `tsconfig.json`, `shadcn add button` exits 0 and writes to a literal directory named `@`.
   **[measured]** — §3.2.
5. **No peer conflict and no new install script.** The whole target set installs on npm 11.16.0
   defaults with no `ERESOLVE` and no `--legacy-peer-deps`; `esbuild@0.28.2` remains the only
   package needing `npm approve-scripts`. **[measured]** — §4.

---

## 0. Versions to pin

Every version confirmed with `npm view <pkg> version` on 2026-09-02 **[measured]**.

| Package | Pin | Lane |
|---|---|---|
| `vitest` | `4.1.11` | devDep |
| `@vitest/coverage-v8` | `4.1.11` | devDep, optional — must equal `vitest` exactly |
| `jsdom` | `30.0.1` | devDep |
| `happy-dom` | `20.13.1` | devDep, only if suite time becomes a problem |
| `@testing-library/react` | `16.3.3` | devDep |
| `@testing-library/dom` | `10.4.1` | devDep — a peer of the other three, must be explicit |
| `@testing-library/jest-dom` | `7.0.1` | devDep |
| `@testing-library/user-event` | `14.6.7` | devDep |
| `tailwindcss` | `4.3.3` | devDep |
| `@tailwindcss/vite` | `4.3.3` | devDep |
| `radix-ui` | `1.6.7` | dependency |
| `lucide-react` | `1.39.0` | dependency |
| `class-variance-authority` | `0.7.1` | dependency |
| `clsx` | `2.1.1` | dependency |
| `tailwind-merge` | `3.6.0` | dependency |
| `shadcn` | `4.20.0` | **not a dependency** — `npx shadcn@4.20.0`, a codegen tool |

Not pinned, unchanged: `vite ^7.0.4`, `react ^19.1.0`, `typescript ~5.8.3`,
`@vitejs/plugin-react ^4.6.0`.

Engines **[documented]**, `npm view <pkg> engines`, 2026-09-02: `vitest` `^20 || ^22 || >=24`;
`jsdom@30.0.1` `^22.22.2 || ^24.15.0 || >=26`; `shadcn` `>=20.18.1`; `tailwindcss` and
`radix-ui` declare none. This machine is **[measured]** `node v24.18.0`, `npm 11.16.0` — inside
every range, but `jsdom@30` excludes Node 20 and Node 23, which matters for CI.

`shadcn-ui` is the dead package name; its last publish is `0.9.5` **[measured]**. The live CLI is
`shadcn`.

---

## 1. Test runner

### 1.1 Vitest version and Vite 7 compatibility

- `vitest@4.1.11` is the current `latest`; `5.0.0-rc.4` exists but is a release candidate
  **[measured]** `npm view vitest versions --json`.
- `vitest@4.1.11` declares `"vite": "^6.0.0 || ^7.0.0 || ^8.0.0"` in **both** `dependencies` and
  `peerDependencies` **[measured]** `npm view vitest@4.1.11 peerDependencies dependencies --json`.
  Vite 7.0.4 is in range. Vitest bundles its own Vite copy as a dependency, so the peer is
  satisfied either way.
- React 19 is not Vitest's concern — Vitest has no React peer. React support comes from
  `@vitejs/plugin-react`, already in the repo at `^4.6.0`.
- `@vitest/coverage-v8@4.1.11` declares `"vitest": "4.1.11"` — an **exact** peer **[measured]**.
  Bumping Vitest without bumping coverage in the same commit breaks the install.

### 1.2 Environment for `feedStore.ts` — the load-bearing answer

**Use `environment: "jsdom"` with `jsdom@30.0.1`. Do nothing about `pretendToBeVisual`.**

The chain of facts, all **[measured]**:

- jsdom gates `window.requestAnimationFrame` behind `pretendToBeVisual`:
  `lib/jsdom/browser/Window.js:607` is `if (window._pretendToBeVisual) {` and the `rAF`/`cAF`
  definitions sit inside that block. jsdom's own default is `pretendToBeVisual: false`
  (`lib/api.js:262`).
- **Vitest overrides that default to `true`.** `vitest@4.1.11`,
  `dist/chunks/index.DC7d2Pf8.js:434` and `:502`:
  `const { html = "<!DOCTYPE html>", ..., pretendToBeVisual = true, ... } = jsdom;`. The public
  type in `dist/chunks/reporters.d.DtoKVV2s.d.ts:64` documents `pretendToBeVisual?: boolean` with
  `@default true`. So no config flag is needed — plain `environment: "jsdom"` is enough.
- Confirmed by running it. `npx vitest run --environment=jsdom` reports
  `{"rAF":"function","cAF":"function","perfNow":"function","localStorage":"object","document":"object"}`.
  `--environment=happy-dom` reports the same. `--environment=node` reports
  `{"rAF":"undefined","cAF":"undefined","localStorage":"undefined","document":"undefined"}` and
  `feedStore.start()` throws `ReferenceError: requestAnimationFrame is not defined`.
- **Vitest's default `toFake` already includes `requestAnimationFrame` and `performance`.** A bare
  `vi.useFakeTimers()` under jsdom, then `vi.advanceTimersByTime(100)`, produced callback
  timestamps `[16, 32, 48]`; `advanceTimersByTime(500)` moved `performance.now()` by exactly
  `500`. Passing `toFake: ["requestAnimationFrame", "performance", ...]` explicitly produced the
  identical `[16, 32, 48]`. **So do not pass `toFake`.** It changes nothing here and it is easy to
  get wrong (an explicit list silently *removes* everything not named).
- jsdom's rAF is implemented as `setInterval(..., 1000/60)` (`Window.js:611-618`), which is why
  Vitest's timer fakes reach it at all. That is the mechanism, and it is why "fake timers drive
  rAF" is a fact about this pair rather than a general one.

End-to-end proof against the real module, not a mock **[measured]**:

```ts
// vitest run, environment jsdom
vi.useFakeTimers();
const fs = await import("./feedStore");
fs.start();
fs.pushBatch(batchA); fs.pushBatch(batchB);   // two batches, one frame
vi.advanceTimersByTime(17);
// -> subscribers notified exactly 1 time; getSessionRows("s1").length === 2
```

Both assertions pass. This is exactly the invariant the module header claims ("ten channel
messages in one frame are ten tasks and would be ten renders without this"), and it is the right
first test in this repo.

`happy-dom@20.13.1` also works and is faster — environment setup `303–414 ms` vs jsdom's
`414–554 ms` per file **[measured]**, same probe, same machine. Take jsdom anyway: it is the
environment `@testing-library/react` is overwhelmingly exercised against, and a ~150 ms per-file
difference is not worth a second unknown while the suite is small. `happy-dom` is the named
fallback if suite time ever becomes the complaint.

**`environment: "node"` is not an option**, and not only because of rAF — see §1.3.

### 1.3 The import chain, `localStorage`, and `@tauri-apps/api`

`feedStore.ts:18` → `fps.ts:20` → `bridge.ts:12` → `@tauri-apps/api/core`, and `fps.ts:47` runs
`let enabled = readEnabled()` at module load. All **[measured]** under `environment: "jsdom"`:

- `localStorage` is `object` in jsdom and happy-dom, `undefined` in node. `readEnabled()` guards
  it with try/catch, so node would not throw here — but it throws four lines later on rAF anyway.
- `@tauri-apps/api@2.11.1` resolves and does not throw outside Tauri. `isTauri()` is
  `return !!(globalThis || window).isTauri;` (`core.js:278-281`) — a property read, no side
  effect. `globalThis.isTauri` is `undefined` under Vitest, so `bridge()` selects `mockBridge`.
- **`import.meta.env.DEV` is `true` under `vitest run`**, with `MODE: "test"` and `PROD: false`
  **[measured]**. Consequence: `fps.isEnabled()` returns `true` in tests, so once fake time
  crosses 1 s the meter `console.debug`s and calls `mockBridge.recordFrameStats`. That path was
  exercised — `vi.advanceTimersByTime(1500)` threw nothing and produced
  `{"hz":60,"frames":63,"dropped":0,"p50_ms":16,"worst_ms":16,"dom_nodes":3}` **[measured]** — so
  it is noise, not a failure. Silence it in the setup file:
  `localStorage.setItem("brigadier.fps", "off")`, which flips `isEnabled()` to `false`
  **[measured]**.

### 1.4 `@testing-library/react` and React 19

- React 19 support landed in **`@testing-library/react@16.1.0`** **[measured]**: `16.0.1` declares
  `"react": "^18.0.0"`, `16.1.0` declares `"react": "^18.0.0 || ^19.0.0"`. Pin the current
  `16.3.3`, which carries the same widened peer.
- `@testing-library/dom@10.4.1` is a **peer**, not a dependency, of `@testing-library/react`,
  `jest-dom` and `user-event` **[measured]**. It must appear in `devDependencies` explicitly or
  the three resolve against nothing.
- `@testing-library/jest-dom@7.0.1` peers on `vitest >= 0.32` and `@testing-library/dom >=10 <11`
  **[measured]**.
- `@testing-library/user-event@14.6.7` peers only on `@testing-library/dom >=7.21.4` **[measured]**.
- Proven together: `render(<Hello />)` + `screen.getByRole("button")` +
  `expect(...).toBeInTheDocument()` passes under React 19.2.8 / RTL 16.3.3 / jsdom 30.0.1 /
  Vitest 4.1.11 **[measured]**.

### 1.5 The `tsc` problem

`npx tsc --noEmit` was run against a copy of this repo's `tsconfig.json` (project reference
dropped) over a copy of `src/`. Baseline: **exit 0** **[measured]**. Then, one scenario at a time:

| Scenario | `tsc --noEmit` |
|---|---|
| Test file in `src/` using `import { describe, it, expect, vi } from "vitest"`, stock tsconfig | **exit 0** |
| Test file using bare `describe`/`it`/`expect` (globals), stock tsconfig | **exit 2** — `TS2582: Cannot find name 'describe'` |
| Same, plus `"types": ["vitest/globals"]` | **exit 0** |
| `expect(el).toBeInTheDocument()`, setup file `src/test/setup.ts` importing `@testing-library/jest-dom/vitest` | **exit 0** |
| Same, but the setup file moved **outside** `src/` (so outside `include`) | **exit 2** — `TS2339: Property 'toBeInTheDocument' does not exist on type 'Assertion<HTMLDivElement>'` |
| Setup file outside `src/`, plus `"types": ["@testing-library/jest-dom"]` | **exit 0** |

All **[measured]**. The minimal change, and the recommendation:

- **Do not set `globals: true`.** Import `describe`/`it`/`expect`/`vi` from `"vitest"` in every
  test file. That needs **zero** tsconfig change — no `types` entry, no `vitest/globals`
  reference. Explicit imports also keep `noUnusedLocals` honest about what a test file uses.
- **Put the setup file at `src/test/setup.ts`** so `include: ["src"]` already covers it, and give
  it one line: `import "@testing-library/jest-dom/vitest";`. Its module augmentation then applies
  to the whole program and `toBeInTheDocument()` type-checks with the stock tsconfig. A setup file
  under a top-level `test/` directory does *not* work without also adding a `types` entry.
- **Do not add `tsconfig.test.json`.** It buys nothing here, and it is the option that can break
  the gate: `src/vite-env.d.ts` is the single line `/// <reference types="vite/client" />`
  **[measured]**, and that reference is what types `import.meta.env` for `fps.ts:57` and
  `App.tsx:358`. A second tsconfig with a narrower `include` that drops `src/vite-env.d.ts` would
  fail on `import.meta.env` with the tests otherwise correct — a confusing failure for no gain.
  (Note it is a **triple-slash reference**, not a `types` entry, so it survives adding
  `"types": [...]` to `compilerOptions` — verified: `"types": ["vitest/globals"]` still gave
  exit 0 **[measured]**.)

**Test code and the production bundle.** `vite build` does **not** bundle `*.test.ts` under
`src/`. Proof: a file `src/marker.test.ts` exporting the string `UNIQUE_TEST_MARKER_ZZZ` was added,
`npx vite build` run, and `grep -rl UNIQUE_TEST_MARKER_ZZZ dist/` found nothing **[measured]**;
the bundle stayed at `262.69 kB`, transforming the same `48 modules`. Rollup walks the module
graph from `index.html` → `src/main.tsx`; a test file nothing imports is never in it. **No
`build.rollupOptions.external`, no exclude glob, and no separate tsconfig are needed to keep test
code out of the bundle** — only the discipline that production code never imports a test file.

The build gate `npx tsc --noEmit && npm run build` therefore keeps working with tests present, on
the stock `tsconfig.json`, with no edits at all.

### 1.6 Isolation between test cases

`feedStore.ts` holds all its state at module scope (`let buffer`, `const sessionRows = new Map()`,
`let state`, …) and exports no reset. Three options were considered; one was measured working.

**(a) `vi.resetModules()` + dynamic `await import("./feedStore")` per test — recommended.**
**[measured]**: with `afterEach(() => { vi.useRealTimers(); vi.resetModules(); })`, a first test
drained two batches into session `s1` and a second test's fresh import saw
`getSessionRows("s1").length === 0` and `getState().version === 0`. Cost: every test must be
`async` and must `await import()` rather than using a top-level `import`, and any type-only import
has to be written separately. That is a five-word idiom repeated per file, and it is the only cost.

**(b) Vitest `isolate` / per-file workers — not sufficient.** Vitest already isolates *files* by
default; it does not isolate *cases within a file*. It would force one test per file, which is a
worse tax than (a) and makes shared fixtures awkward. Reject.

**(c) A test-only `reset()` export on `feedStore.ts` — weakest, and it does not win.** It edits
production code to serve tests, adds an export that ships in the bundle, and creates a second
place that must list every piece of module state — a reset that forgets one field is a silent
cross-test leak, which is precisely the bug the option exists to prevent. (a) cannot drift,
because the module system does the resetting. Reject.

Recommendation: **(a)**. It also satisfies the "survive a full frontend rewrite untouched"
constraint better than (c) — it depends on nothing but the module's public exports.

### 1.7 Coverage

`@vitest/coverage-v8@4.1.11`. It ran clean under this exact stack **[measured]**
(`npx vitest run --coverage` printed a v8 coverage summary). Its peer on `vitest` is the exact
string `4.1.11`, so the two versions move together or not at all.

Worth adding, but it is not on the critical path: it reports nothing useful until there are tests
to report on. Add it in the same commit as the first real test file, not before.

### 1.8 The config that was actually run

**[measured]** — this exact pair produced `Test Files 1 passed / Tests 2 passed` on the real
`feedStore.ts`:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";      // NOT "vite" — vitest/config types `test`
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

```ts
// src/test/setup.ts
import "@testing-library/jest-dom/vitest";
localStorage.setItem("brigadier.fps", "off");      // keeps the FPS meter quiet; DEV is true here
```

`"vitest/config"` is a real export of `vitest@4.1.11` **[measured]**, `npm view vitest@4.1.11
exports`. A per-file override exists if one file ever needs another environment:
`// @vitest-environment jsdom` as the first line **[documented]**
(https://vitest.dev/guide/environment, fetched 2026-09-02) and **[measured]** — that pragma won
over an explicit `--environment=node` on the command line.

Whether this config belongs in `vitest.config.ts` or in a `test` block inside `vite.config.ts` was
**not** decided here. A separate file is the safer default: `vite.config.ts` is an async factory
reading `process.env.TAURI_DEV_HOST` and is `include`d by `tsconfig.node.json`, and Vitest reads
`vitest.config.ts` in preference to `vite.config.ts` automatically.

---

## 2. Tailwind CSS 4

### 2.1 Versions and Vite 7

- `tailwindcss@4.3.3` and `@tailwindcss/vite@4.3.3` **[measured]**. They are released in lockstep;
  `@tailwindcss/vite@4.3.3` depends on `tailwindcss@4.3.3` exactly, plus `@tailwindcss/node` and
  `@tailwindcss/oxide` at the same version **[measured]**.
- `@tailwindcss/vite@4.3.3` peers on `"vite": "^5.2.0 || ^6 || ^7 || ^8"` **[measured]**
  `npm view @tailwindcss/vite@4.3.3 peerDependencies`. Vite 7 is supported.
- Because `tailwindcss` is a hard dependency of the Vite plugin, listing both is redundant for
  resolution but correct for intent; list both.

### 2.2 The v4 config model

- CSS-first. `@import "tailwindcss";` replaces the three `@tailwind` directives, and `@theme { }`
  replaces `theme.extend` **[documented]** https://tailwindcss.com/docs/theme, fetched 2026-09-02.
- **`tailwind.config.js` is not auto-discovered.** The `@config` and `@plugin` directives do exist
  in `tailwindcss@4.3.3` **[measured]** (both strings present in `dist/lib.mjs`), so a legacy
  config is read *only* when a stylesheet explicitly says `@config "./tailwind.config.js"`. This
  repo has no such file and should not create one.
- **`@theme` drops unused variables.** "By default only used CSS variables will be generated in
  the final CSS output" **[documented]**, same page. Verified: `@theme { --color-thread-bg: … }`
  with no utility referencing it emitted **zero** occurrences of `thread-bg` in the built CSS
  **[measured]**. Add a `className="bg-thread-bg"` anywhere and both the variable and
  `.bg-thread-bg{background-color:var(--color-thread-bg)}` appear.
- **`@theme static` emits everything.** Same tokens under `@theme static` emitted all of them
  **[measured]**, at a cost of `8660 → 8859` bytes for three tokens.
- This matters here because `src/index.css` today consumes its tokens as raw
  `var(--thread-bg)` in hand-written rules, not through utility classes. During any period where
  both styles coexist, a plain `@theme` will delete the variables the old rules depend on and the
  app will render unstyled with no error. **Use `@theme static`.**

### 2.3 The header `src/index.css` needs

```css
@import "tailwindcss";

@theme static {
  /* colours: --color-<name> so `bg-<name>` / `text-<name>` are generated */
  --color-thread-bg: oklch(0.2090 0 0);
  --color-sidebar-bg: oklch(0.3513 0.00137 197.09);
  /* …the other 16 colour tokens… */

  /* geometry and type keep their own namespaces */
  --radius-row: 8px;
  --radius-md: 12px;
  --radius-lg: 20px;
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui,
    sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

:root {
  color-scheme: dark;
}
```

The `--color-*` prefix is not decoration: it is the namespace that makes Tailwind generate
`bg-thread-bg`, `text-thread-bg`, `border-thread-bg` from the token **[measured]** — a token named
`--thread-bg` inside `@theme` generates no utility at all.

Values that are not colours (`--sidebar-w: 276px`, `--row-h: 30px`, `--thread-max: 736px`,
`--feed-row-h: 18px`) have no utility namespace that fits and are only read as `var()`. Leave them
in a plain `:root` block outside `@theme`; they survive untouched and are not renamed
**[asserted]** — Tailwind rewrites nothing outside `@theme`, and the existing `index.css` compiled
byte-identically with `@import "tailwindcss"` prepended (`12.69 kB → 21.21 kB`, all growth from
preflight, none from rewriting) **[measured]**.

### 2.4 Dark-only

**Recommendation: define the tokens once in `@theme static`, never write a `dark:` variant, and do
not declare `@custom-variant dark`.**

- Tailwind 4's `dark:` defaults to `@media (prefers-color-scheme: dark)` **[documented]**
  https://tailwindcss.com/docs/dark-mode, fetched 2026-09-02, and **[measured]** — with no
  `@custom-variant` anywhere, `class="dark:bg-thread-bg"` compiled to
  `@media(prefers-color-scheme:dark){.dark\:bg-thread-bg{background-color:var(--color-thread-bg)}}`.
- `@custom-variant dark (&:is(.dark *))` exists only to switch `dark:` from the media query to a
  `.dark` class, for a manual toggle. Jan needs it (`web-app/src/index.css:20`, per
  `docs/research/jan.md` §6) because Jan ships a light scheme. **This repo does not, so it is dead
  weight.** Declaring it and then never using `dark:` is harmless but misleading — a reader would
  assume a light scheme is coming.
- **Nothing breaks** if `dark:` is simply never used. The variant is generated on demand from
  scanned source; unused, it emits nothing. The tokens on `:root` / in `@theme static` apply
  unconditionally, which is exactly the current behaviour of `src/index.css`.
- Keep `color-scheme: dark` on `:root` — it is what makes native form controls and scrollbars
  dark, and Tailwind does not set it.
- One caveat: `shadcn init` writes a `@custom-variant dark` line and a matching `.dark { … }` block
  into the target CSS file. If `init` is ever run, delete both by hand.

### 2.5 Bundle-size consequence

All **[measured]** on the reproduction of this repo's build:

| Build | JS | CSS |
|---|---|---|
| Today (baseline, reproduced exactly) | 262.69 kB (gzip 82.88) | 12.69 kB (gzip 3.07) |
| `@import "tailwindcss"` prepended to the existing 1,059-line `index.css` | **262.69 kB** (gzip 82.88) | 21.21 kB (gzip 5.11) |
| `index.css` reduced to `@import "tailwindcss"` + 3 tokens, hand-written CSS deleted | **262.69 kB** | 8.66 kB (gzip 2.40) |

**Tailwind 4 adds exactly zero bytes to the JS bundle** — the plugin is build-time only and emits
CSS. The +8.52 kB CSS in row two is Tailwind's preflight plus the handful of utilities detected in
the existing `.tsx` files, sitting on top of the untouched hand-written CSS; row three is what
remains once the hand-written rules are actually replaced. Preflight alone is ~8.7 kB raw /
~2.4 kB gzip and is the floor.

A caution the numbers make visible: **Tailwind's oxide scanner walks the filesystem, not the module
graph.** CSS grew to 31.88 kB the moment the shadcn component files existed under `src/`, before
anything imported them **[measured]** (§3.4, both rows show 31.88 kB). Unused generated components
left lying in `src/components/ui/` cost CSS even though they cost no JS.

### 2.6 hex → oklch

**Tailwind 4 prefers oklch but does not require it.** Nothing in the toolchain rejects hex:
`@theme static { --color-x: #181818 }` compiles and the emitted variable is the hex string
**[asserted]** — the `@theme` block is copied through, and the measured `--radius-row:8px`
pass-through shows non-colour values are copied verbatim; I did not separately build a hex colour
token. v4's own default palette is oklch and its `color-mix()`-based opacity modifiers behave
better in a perceptual space, which is the reason to convert, not a requirement.

**Is hex→oklch lossless in the sRGB gamut?** Yes as mathematics — the sRGB↔OKLCH transform is a
bijection on real numbers, so every sRGB colour has an exact OKLCH representation. All loss is
decimal rounding **[asserted]**, from the transform's definition.

**Precision, measured.** All 18 colour tokens in `src/index.css` were converted with the standard
OKLab matrices and round-tripped back to 8-bit sRGB at four rounding levels **[measured]**:

| Rounding (L, C, H decimals) | Tokens round-tripping to the identical hex | Worst contrast-ratio drift |
|---|---|---|
| 2, 3, 1 | **7 of 18** | 0.109 (`--ok` on `--thread-bg`: 8.615 → 8.724) |
| 3, 4, 2 | **18 of 18** | 0.010 |
| **4, 5, 2** | **18 of 18** | **0.003** |
| 5, 6, 2 | 18 of 18 | 0.001 |

**Keep L to 4 decimals, C to 5, H to 2.** At that precision every token round-trips bit-exact and
every annotated contrast pair reproduces to within 0.003 — enough for a 2-decimal ratio except
where a ratio already sits within ~0.005 of a rounding boundary. **The `2, 3, 1` row is not
enough: it breaks 11 of 18 tokens and moves a contrast ratio by up to 0.11**, which is exactly how
a 4.50:1 pair silently becomes 4.39:1.

That sentence previously said "two-decimals-everywhere" while quoting the `2, 3, 1` row's numbers,
which are L 2dp / C **3**dp / H **1**dp. The table was right and the prose mislabelled it; the
mislabel was copied forward into `src/index.css` before being caught, which is why it is corrected
here rather than only there. **True `2, 2, 2` is worse than the sentence claimed, not better**:
**5 of 18** round-trip, 13 break, and the worst drift across the same eight annotated pairs is
**0.1045** (`--accent` on `--thread-bg`, 7.2369 → 7.3415). The direction of the argument is
unchanged.

Those `2, 2, 2` figures are **[measured]**, but **not by the run that produced the table above** —
they were measured on 2026-09-02 during the W4-B review, twice and independently: once by a blind
reviewer and once by the W4-B implementer, agreeing on both counts. See
`docs/research/oklch-tokens.md` §1. Worth knowing for the same reason: at `2, 2, 2`
`--text-muted-side` on `--sidebar-bg` drifts **4.4551 → 4.5572**, so a pair that genuinely fails
AA would read as passing.

One more discrepancy found in the same re-derivation and **left in the table above as originally
measured**: the `3, 4, 2` row's worst drift re-derives as **0.0185**, not `0.010` **[measured,
W4-B review, 2026-09-02]**. It changes no decision — that row is not the one we ship, and both
values are far above the `4, 5, 2` row's 0.003 — so the original measurement stands and this is a
footnote rather than an edit. The `2, 3, 1` and `4, 5, 2` rows both re-derived exactly (0.1097 and
0.0017 against the recorded 0.109 and 0.003).

Sample of the conversion **[measured]**:

```
--thread-bg        #181818  ->  oklch(0.2090 0 0)
--sidebar-bg       #3a3b3b  ->  oklch(0.3513 0.00137 197.09)
--text-muted       #848484  ->  oklch(0.6133 0 0)
--accent           #ef8c57  ->  oklch(0.7354 0.13858 47.76)
--ok               #5cc98c  ->  oklch(0.7558 0.13470 156.47)
--bad              #ef6a63  ->  oklch(0.6856 0.16581 25.41)
```

(Achromatic greys come out with a meaningless hue at C=0; write them `oklch(L 0 0)`.)

**Conversion route.** Do not hand-convert. Options confirmed to exist on npm today **[measured]**:
`culori@4.0.2` (small, tree-shakeable, `converter("oklch")`) or `colorjs.io@0.7.1` (larger, richer,
what the CSS WG demos use). A ~40-line script using the OKLab matrices directly also works and was
what produced the table above — it needs no dependency and can compute WCAG ratios in the same
pass, which is the actual requirement: **re-derive every AA pair from the oklch values and compare
against the ratio recorded in the comment, rather than trusting the conversion**. The current
annotated pairs and their hex-computed ratios, for that check **[measured]**:
`--text-muted`/`--thread-bg` 4.748, `--text-muted-side`/`--sidebar-bg` 4.455,
`--text-placeholder`/`--composer-bg` 5.101, `--text`/`--thread-bg` 17.756,
`--text-sidebar`/`--sidebar-bg` 8.594, `--accent`/`--thread-bg` 7.237, `--ok`/`--thread-bg` 8.615,
`--bad`/`--thread-bg` 5.844.

Note `src/index.css` defines **28** custom properties in `:root` **[measured]**
(`grep -cE '^\s*--[a-z-]+:' src/index.css`), of which **18 are colours**; the "56" in the brief
counts every declaration in the file, not the `:root` token set.

---

## 3. Radix + shadcn/ui

### 3.1 Unified `radix-ui` vs per-primitive `@radix-ui/react-*`

**Both exist today. Use the unified `radix-ui@1.6.7`.**

- `radix-ui@1.6.7` exists and re-exports 57 primitive packages as dependencies **[measured]**
  `npm view radix-ui@1.6.7 dependencies`. The per-primitive packages are alive and independently
  versioned: `@radix-ui/react-dialog@1.1.23`, `@radix-ui/react-dropdown-menu@2.1.24`,
  `@radix-ui/react-tooltip@1.2.16`, `@radix-ui/react-scroll-area@1.2.18`,
  `@radix-ui/react-switch@1.3.7`, `@radix-ui/react-separator@1.1.15`, `@radix-ui/react-slot@1.3.3`
  **[measured]**.
- **shadcn generates against the unified package for Tailwind 4.** The live registry, fetched
  2026-09-02 **[measured]**: `https://ui.shadcn.com/r/styles/new-york-v4/button.json` has
  `dependencies: ["radix-ui"]` and its source reads `import { Slot } from "radix-ui"`. The older
  `.../new-york/button.json` (Tailwind 3) has `dependencies: ["@radix-ui/react-slot"]` and
  `import { Slot } from "@radix-ui/react-slot"`. Same for every component checked.
- **Bundle size is not an axis — the two are within 0.17 kB.** The eight components were generated,
  built (`422.60 kB`), then mechanically rewritten to per-primitive imports with the seven
  `@radix-ui/react-*` packages installed, and rebuilt: **`422.77 kB`** **[measured]**. The unified
  package is 0.17 kB *smaller*. Rollup tree-shakes the barrel; the "unified package pulls in all of
  Radix" instinct is wrong for this bundler.
- So the decision is on maintenance, and the unified package wins: one dependency line and one
  version to bump instead of seven, and it is what `shadcn add` writes and will keep writing.

### 3.2 The shadcn CLI

- The package is **`shadcn`**, current `4.20.0` **[measured]**. `shadcn-ui` is dead at `0.9.5`.
- **It works with Tailwind 4 + React 19 with no `--force` and no `--legacy-peer-deps`**
  **[measured]**: `npx shadcn@4.20.0 add button separator switch tooltip scroll-area dialog
  dropdown-menu sidebar --yes` completed against `react@19.2.8` / `tailwindcss@4.3.3` /
  `vite@7.3.6`, installed `radix-ui`, `class-variance-authority` and `lucide-react`, and wrote
  12 files.
- **A `@/` path alias is REQUIRED.** Every generated file imports `@/lib/utils`, and `sidebar.tsx`
  imports `@/components/ui/{button,input,separator,sheet,skeleton,tooltip}` and `@/hooks/use-mobile`
  **[measured]**. Worse, the failure is silent: with `components.json` present but **no `paths` in
  `tsconfig.json`**, `shadcn add button` printed `✔ Created 1 file: @/components/ui/button.tsx`,
  exited 0, and created a **literal directory named `@`** at the project root **[measured]**.

  The exact two edits, both verified to fix it **[measured]** (files then landed in
  `src/components/ui/`):

  ```jsonc
  // tsconfig.json — inside compilerOptions
  "baseUrl": ".",
  "paths": { "@/*": ["./src/*"] }
  ```

  ```ts
  // vite.config.ts
  import path from "node:path";
  // …
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  ```

  Both are needed: `paths` for `tsc --noEmit` and the CLI, `resolve.alias` for the bundler and the
  dev server. `vite.config.ts` is an ESM module in this repo (`"type": "module"`), so `__dirname`
  needs `import.meta.dirname` (Node ≥ 20.11) or a `fileURLToPath` shim — **not checked** which of
  those this repo's Node/Vite pair prefers.
- `components.json` fields the CLI read **[measured]**: `$schema`, `style`, `rsc`, `tsx`,
  `iconLibrary`, `tailwind: { config, css, baseColor, cssVariables, prefix }`, and
  `aliases: { components, utils, ui, lib, hooks }`. `tailwind.config` is the empty string for v4.
- **Run `shadcn init`, do not hand-write `components.json`.** Hand-writing it and going straight to
  `add` produced components that import `@/lib/utils` while **no `src/lib/utils.ts` was created and
  neither `clsx` nor `tailwind-merge` was installed** **[measured]** — those come from `init`'s base
  `utils` item, not from `add`. If `init` is skipped, create `src/lib/utils.ts` by hand
  (`twMerge(clsx(inputs))`) and install `clsx@2.1.1` + `tailwind-merge@3.6.0` yourself, and expect
  `init` to also rewrite `src/index.css` (see §2.4).

### 3.3 The components this repo needs

Live registry, `new-york-v4`, fetched 2026-09-02 **[measured]**. "LOC" is the file as generated.

| Component | LOC | npm deps | Radix primitive | Pulls in |
|---|---|---|---|---|
| `button` | 64 | `radix-ui`, cva | `Slot` | — |
| `separator` | 26 | `radix-ui` | `Separator` | — |
| `switch` | 35 | `radix-ui` | `Switch` | — |
| `tooltip` | 55 | `radix-ui` | `Tooltip` (→ Popper, Portal, Presence) | — |
| `scroll-area` | 58 | `radix-ui` | `ScrollArea` | — |
| `dialog` | 156 | `radix-ui` | `Dialog` (→ FocusScope, DismissableLayer, Portal) | **`lucide-react`** |
| `dropdown-menu` | 257 | `radix-ui` | `DropdownMenu` (→ Menu, Popper, RovingFocus) | **`lucide-react`** |
| `sidebar` | **726** | `radix-ui`, cva, **`lucide-react`** | `Slot` only | `button`, `input`, `separator`, `sheet`, `skeleton`, `tooltip`, `use-mobile` hook |

- **`sidebar` is the heavy one, and its weight is transitive, not Radix.** Its own Radix use is
  just `Slot`; what it costs is the six other components it drags in, chiefly `sheet` (141 LOC,
  `@radix-ui/react-dialog` under the hood — the mobile drawer) and `tooltip`. Total generated
  surface for `sidebar` alone: **1,571 LOC across 12 files** **[measured]** `wc -l`.
  (Jan's vendored copy is 859 lines vs the registry's 726 — Jan has modified it, per
  `docs/research/jan.md` §6.)
- `sidebar` also expects CSS variables the repo must define: `--sidebar-width`,
  `--sidebar-width-icon`, `--sidebar-border`, `--sidebar-accent` **[measured]**, plus the semantic
  utility classes `bg-sidebar`, `bg-sidebar-accent`, `text-sidebar-foreground`,
  `border-sidebar-border`, `ring-sidebar-ring`.
- Across all eight, the generated code references this semantic token set **[measured]**:
  `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`,
  `destructive`, `border`, `input`, `ring`, `sidebar`, `sidebar-accent`, `sidebar-border`,
  `sidebar-foreground`, `sidebar-ring` (each with its `-foreground` partner where applicable).
  **This is a second, parallel token vocabulary** to the repo's measured ChatGPT palette. Mapping
  one onto the other is the real design work in this migration and is not a copy-paste.
- No component pulls a heavy transitive dep beyond `lucide-react`. No `framer-motion`, no `vaul`,
  no `sonner` — those are Jan's additions, not shadcn's.

### 3.4 Icons: `lucide-react`

**It is not optional if `sidebar`, `dialog` or `dropdown-menu` are used.** `sidebar.tsx:5` is
`import { PanelLeftIcon } from "lucide-react"` **[measured]**; the registry lists `lucide-react`
in `sidebar`'s `dependencies`.

- `lucide-react@1.39.0`, published 2026-09-01, peers `react ^16.5.1 || ^17 || ^18 || ^19`,
  `"sideEffects": false`, ESM at `dist/esm/lucide-react.mjs` **[measured]**. (The `0.x` line the
  model expects is history; `1.3.0` sits on `next`.)
- **It tree-shakes per icon under Vite/Rollup** **[measured]**, three builds of the same trivial
  entry: 0 icons `192.49 kB`, 1 icon `194.04 kB`, 10 icons `195.43 kB`. So **~1.55 kB for the
  first icon** (the shared `createLucideIcon` runtime) and **~0.15 kB per additional icon**. No
  babel plugin, no `lucide-react/icons/...` deep import, no `optimizeDeps` tweak needed.
- Cost in context: the repo's current zero-icon-dependency position is worth ~1.5 kB and one
  dependency to give up, which is small. The larger cost is stylistic — replacing hand-placed
  Unicode glyphs with a 24×24 stroke icon set changes the look, and that is a taste decision the
  measured ChatGPT reference does not settle.

### 3.5 What the whole thing costs

**[measured]**, same probe, same baseline:

| Build | JS | gzip | CSS |
|---|---|---|---|
| Baseline (today) | 262.69 kB | 82.88 kB | 12.69 kB |
| + Tailwind 4, shadcn files present but **not imported** | 262.69 kB | 82.88 kB | 31.88 kB |
| + all eight components **imported and rendered** | **422.60 kB** | **133.73 kB** | 31.88 kB |

**+159.91 kB raw / +50.85 kB gzip of JavaScript** to adopt the shadcn shell, and it lands in one
step — Radix's primitives are interdependent enough that the first few components pull most of it.
That is a 61% increase on a bundle the owner has been holding at 262.69 kB. It buys a resizable,
persisted, accessible sidebar with focus management, a real dialog, a real dropdown and a real
tooltip, none of which exist today. It is a genuine trade, not a free upgrade, and the number above
is the honest price.

---

## 4. Install mechanics

**[measured]**, a fresh directory with this repo's exact `package.json`, then one
`npm install` of the full target set on npm 11.16.0 defaults:

- `added 263 packages in 11s`. **No `ERESOLVE`, no peer warning, no `--legacy-peer-deps`.**
- The only install-script warning was `esbuild@0.28.2 (postinstall: node install.js)` — the one
  `CLAUDE.md` §4 already records. **No new dependency adds a postinstall script.** In particular
  `@tailwindcss/oxide@4.3.3` ships its native binaries as optional platform packages, not via a
  build step, and installing `tailwindcss` + `@tailwindcss/vite` raised no new entry **[measured]**.
- `npm approve-scripts --allow-scripts-pending` therefore stays exactly as necessary as it is
  today, and no more.
- Plugin order in `vite.config.ts` **does not matter**: `[react(), tailwindcss()]` and
  `[tailwindcss(), react()]` produced **byte-identical output**, same content hashes
  (`index-DqjrMmSs.css`, `index-BemqnyVi.js`) **[measured]**.

---

## 5. What I did NOT check

- **Nothing was run inside the repo.** `git status` is clean apart from another worker's untracked
  `docs/research/async-subagent-results.md`. Every number here comes from a scratchpad copy whose
  baseline build matches the repo's byte for byte; that is strong evidence, not the same thing as
  running it in place.
- **No `cargo` or `npm run tauri build`.** Whether the Tailwind/shadcn CSS renders correctly in
  **WKWebView** — not Chrome, not jsdom — is untested. `oklch()` and `color-mix()` are the two
  things to check first; Safari has supported both for years, but this repo's own history says not
  to assume someone else's runtime.
- **No visual comparison.** Whether the shadcn token vocabulary can be mapped onto the measured
  ChatGPT palette without losing the match `docs/plans/ui-restyle-notes.md` records is a design
  question, not a research one, and I did not attempt it.
- **The 262.69 kB → 422.60 kB figure is one specific usage.** It imports all eight components from
  one module. A build that uses only `button` + `separator` + `switch` would cost far less; I did
  not measure the per-component curve.
- **`shadcn init` was never run to completion.** The `components.json` used was hand-written, so
  what `init` writes into `src/index.css` (its `@custom-variant dark`, `.dark` block, and default
  oklch palette) is inferred from the registry's `cssVars`, not observed.
- **`import.meta.dirname` vs `fileURLToPath`** in this repo's ESM `vite.config.ts` — I gave the
  alias recipe with `__dirname`, which is what the probe used successfully under
  `@vitejs/plugin-react`'s esbuild transform, but I did not verify it in this repo's own config
  file with its async factory and `TAURI_DEV_HOST` read.
- **Vitest 5.** Only release candidates exist (`5.0.0-rc.4`); I did not evaluate it, and pinning a
  4.x is the right call today.
- **`@testing-library/user-event` was installed but never exercised.** Its version is confirmed;
  its behaviour under jsdom 30 + React 19 is not.
- **Coverage thresholds, CI wiring and watch-mode ergonomics** are out of scope here.

---

## 6. The five riskiest gotchas

1. **`@theme` silently deletes unused tokens, so hand-written `var(--thread-bg)` rules go
   unstyled with no error** — use `@theme static`, verified to emit all tokens (§2.2).
2. **A missing `@/` alias makes `shadcn add` exit 0 while writing into a literal `@` directory** —
   add `"baseUrl": "."` + `"paths": {"@/*": ["./src/*"]}` to `tsconfig.json` *and*
   `resolve.alias` to `vite.config.ts` before the first `add` (§3.2).
3. **A jest-dom setup file placed outside `src/` breaks `npx tsc --noEmit` with a confusing
   `toBeInTheDocument does not exist` error** — put it at `src/test/setup.ts` so `include: ["src"]`
   already covers it, and never drop `src/vite-env.d.ts` from any tsconfig, since its
   `/// <reference types="vite/client" />` is the only thing typing `import.meta.env` (§1.5).
4. **`shadcn init` overwrites `src/index.css` with a light+dark palette and a `@custom-variant
   dark`, contradicting the dark-only decision** — run `init` on a branch, diff the CSS, and
   delete the `.dark` block and the custom variant by hand (§2.4).
5. **shadcn's `--sidebar-*` vocabulary sits beside this repo's existing `--sidebar-bg` /
   `--sidebar-w`, close enough to confuse and different enough to break** — no exact collision was
   found (`--sidebar-width` ≠ `--sidebar-w`, `--sidebar-border` ≠ `--sidebar-line`), so rename the
   repo's four to `--color-sidebar*` under `@theme static` in the same commit that adds `sidebar`,
   rather than letting two conventions coexist (§3.3).

Two more that were checked and turned out **not** to be risks, recorded so nobody re-checks them:
plugin order in `vite.config.ts` (byte-identical output either way, §4) and new postinstall
scripts (there are none; `esbuild` remains the only one, §4).
