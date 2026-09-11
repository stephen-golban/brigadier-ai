# Thread defect fixes — before / after, 2026-09-11

Eight defects found by **running the application and looking at it**. The suite was green while
every one of them shipped and is green now (707/707), so a green suite is not the evidence here;
these pairs are.

Every line below is **[M]** measured — I ran it today and read the number off the page — or
**[A]** asserted. §4 says what was not checked.

## 1. How these were produced

`npm run dev` at `http://localhost:1420/?rps=0&approvals=manual` — the same `src/` render path the
packaged app ships, against the repo's own browser mock (`src/mock.ts` → `seedConversation`) —
driven headless with Playwright 1.62.1 / Chromium 151.0.7922.34 at 1440×1000, DPR 2, dark.
`before-*` was captured with this session's `src/` changes stashed (`git stash push -- src/`) and
the branch otherwise identical, so the pairs differ only by the fix. Nothing was stubbed or faked
and there was **no component harness**: every state below is reachable from the fixture. **[M]**

The driver scripts are kept beside the shots as `capture-shoot.mjs.txt`,
`capture-collision.mjs.txt` and `capture-open.mjs.txt`. Raw per-run output is in
`before-observations.txt` / `after-observations.txt` and `before-escape.txt` / `after-escape.txt`.

Two changes to the fixture itself were needed and are part of the fix, not of the harness:
`workspaceApi.chatTurns` answered `[]` in the browser, and the seeded conversation carried no exit
codes and no failing command. Both are described under the defects they belong to.

## 2. The pairs

| # | defect | before **[M]** | after **[M]** | shots |
| --- | --- | --- | --- | --- |
| 1 | Vendored brand string | `ThreadState.tsx` served by the dev server contained `ChatGPT` (`grep -c` → **1**) | → **0**. `grep -rn ChatGPT src/` now matches only two prose citations in `src/index.css` comments | bundle grep, no shot: `ThreadLoadingState` has no mount site, so it was never on screen |
| 2 | Turn header shows no data | `.thread-turn-duration` textContent `"Worked"` | `"Worked for 1m 14s · done 5:08 AM"` | `before-/after-02-turn-header.png` |
| 3 | Approval card dumps raw JSON and clips | `.approval-body` scrollWidth **750** vs clientWidth **736**; body text is the excerpt verbatim including `"__mock__": "SYNTHETIC MOCK DATA…"` | scrollWidth **708** = clientWidth **708**; body reads `crates/store/src/feed.rs` / *clear the incremental cache* / two scope sentences / *Show the full request* | `before-/after-04-approval-card.png`, `after-05-approval-raw-open.png` |
| 4 | One Escape did two things | peek `true` → **`false`** *and* a deny prompt opened, from one keystroke | peek stays **`true`**, deny prompt opens. Control with no approval: peek `true` → **`false`**, unchanged | `before-/after-escape-collision.png`, `before-/after-escape-control.png` |
| 5 | Labels print internal values | reasoning collapsed label `"Reasoning"` | `"Thought for 4s"` | `before-/after-07-reasoning.png` |
| 6 | Turn header takes a hover fill | hover background `rgba(255, 255, 255, 0.08)` | hover background `rgba(0, 0, 0, 0)`; colour still goes `rgb(161,161,161)` → `rgb(227,227,227)` | `before-/after-03-turn-header-hover.png` |
| 7 | Failure is the same colour as success | one footer, `completed`, `"Exit code unknown"`, `rgb(127,127,127)` | `completed` → `"Success"` `rgb(127,127,127)`; `failed` → `"Exit code 1"` `rgb(224,122,122)` with a `rgb(224,122,122)` dot | `after-08-command-failed.png`, `before-/after-09-command-ok.png` |
| 8 | Approval stated twice at once | `.composer-approval-strip` count **1** while the card was on screen | count **0** while the card is on screen, **1** when a 1000×520 window puts it out of view | `before-/after-01-full.png`, `before-/after-10-short-window.png` |

Row 5's compaction and exit notices have no mount site the fixture can reach (`feedStore` never
mints a `notice` `ChatItem` in the browser mock), so those two are **[A]**: the change is a pure
string map in `ThreadView.tsx`'s `noticeSentence`, covered by reading, not by a screenshot.

## 3. Two fixture changes that are part of the fix

- **`workspaceApi.chatTurns` answered `[]` outside Tauri.** With no `ChatTurn`, `projectThread`
  finds no `evidence`, so `durationMs` and `completedAtMs` are both absent and the header has
  nothing to print. `WorkTrace`'s 60 s floor and `· done …` half were already correct and already
  committed — **defect 2 was a fixture gap, not a renderer gap**, and the previous session's note
  that "the code path is conditional on data, not broken" was right. `src/mock.ts` now records a
  `ChatTurn` per turn and spreads each seeded item's `at` across it. **[M]**
- **No shell result carried an exit code, and none failed.** The seeded results now carry
  `exit_code: 0` — matching what Rust puts on the wire as of `1709a99` — and one `npm run lint`
  call fails with `is_error: true, exit_code: 1`, which is what makes row 7's red state reachable
  from the fixture at all. **[M]**

## 4. What was not checked

- **Any timing number.** No burn, no exec→FCP p50, no dropped-vsync count. The brief excluded
  `npm run tauri build` and the burn, and none was run. Whether these changes move the paint
  budget is **unknown and not claimed**.
- **The packaged app.** Every shot is the dev server in Chromium, not WKWebView. Fonts,
  scrollbars and compositing can differ.
- **`cargo` gates.** A Rust worker holds `crates/`; only `npm test` and `npx tsc --noEmit` were run.
- **The compaction and exit notices on screen** — see §2.
- **Colour by pixel.** Every colour above is `getComputedStyle`, not a picker on the PNG.
- **Every approval shape.** The fixture's excerpts are a `command`/`description`/`file_path`
  object and an MCP `message` object. A truncated (non-JSON) excerpt takes the `input === null`
  arm and was exercised only by reading.
