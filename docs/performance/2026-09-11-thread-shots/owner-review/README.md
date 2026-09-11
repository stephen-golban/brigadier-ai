# Owner review of the rebuilt thread — before / after, 2026-09-11

Six items the owner raised after looking at `10-approval-pending.png`,
`11-after-approval-allow-full.png` and the `fixes/after-*` shots. Every line below is **[M]**
measured — read off the running page today — or **[A]** asserted. §5 says what was not checked.

## 1. How these were produced

`npm run dev` at `http://localhost:1421/?rps=0&approvals=manual` — the same `src/` render path the
packaged app ships, against the repo's own browser fixture (`src/mock.ts` → `seedConversation`) —
driven headless with Playwright 1.62.1 / Chromium at 1440×1000, DPR 2, dark. The `before/` pair was
captured with this session's `src/` changes stashed (`git stash push -- src/`), the same script and
the same fixture, so each pair differs only by the fix. The stash was popped and the restored
`git diff -- src/` was byte-identical to the pre-stash one. Nothing was stubbed and there is no
component harness: every state below is reachable from the fixture. **[M]**

Drivers: `capture-shoot.mjs.txt`, `capture-open.mjs.txt`. Raw per-run output:
`before/observations.txt`, `after/observations.txt`.

## 2. The pairs

| # | item | before **[M]** | after **[M]** | shots |
| --- | --- | --- | --- | --- |
| 1 | Approval payload is not a code block | `pre.excerpt` — background `rgba(0,0,0,0)`, radius `0px`, padding `0px`, `overflow-x: visible`, no height cap | `.thread-approval-command__surface` — background `rgb(31,31,31)`, radius `6px`, `overflow-x: auto`, `max-height: 280px`, monospace, `scrollWidth === clientWidth` | `*/r1-approval-payload.png` |
| 2 | Stacked approval cards sit flush | gaps between three cards `[0, 0]`; `.approvals-body` `display: block`, `row-gap: normal` | gaps `[16, 16]`; `display: flex`, `row-gap: 16px` | `*/r2-approval-stack.png` |
| 3 | "Approval needed" rail jammed on the composer | strip bottom → composer top **7px** | **16px** | `*/r3r4-short-window.png` |
| 4 | Project/environment/branch rail after start | `[aria-label="Task workspace"]` present, `margin: 0 185.5px -12px` | absent (`railPresent: false`) in both window sizes | `*/r3r4-composer-dock.png`, `*/r3r4-short-window.png` |
| 5 | Red failure count in the turn header | header text `"Worked for 1m 14s · done 3:21 PM · 1 failure"`, one `rgb(224,122,122)` span | `"Worked for 1m 14s · done 3:19 PM"`, **zero** red spans. Row level unchanged: `failed` → `"Exit code 1"` `rgb(224,122,122)`, `completed` → `"Success"` | `*/r5-turn-header.png`, `*/r5-row-failure.png` |
| 6 | Changed-files card placement | **0** `.edited-files-card` on screen — `desktopApi.changes` answered `{files:[],turns:[]}` outside Tauri, so the card was unreachable in the browser | **1**, `insideThread: true`, `insideComposerDock: false`, top `352.75` against a composer top of `836`; rows read `src/components/ThreadView.tsx +19 −5`, left-aligned, `justify-content: space-between` | `after/r6-changed-files.png` |

## 3. Item 6 is a fixture change plus a styling fix, not a move

`ChangedFilesCard` already rendered **inside the thread**, as the `data-changed-files` part on a
turn's final answer (`src/components/ThreadView.tsx`, `ChangedFilesPart`); it has never been
mounted in the composer on this branch or on `main`. What was wrong is that it was invisible in
the browser and, once visible, drawn wrong:

- `desktopApi.changes` short-circuited to an empty list outside Tauri, and the card returns `null`
  on an empty list. `src/mock.ts` now answers it (`mockSessionChanges`), keyed by the user
  message's `provider_uuid ?? id` — the same key `Transcript` uses. Same class of fixture gap as
  `chatTurns` in the previous round. **[M]**
- With it on screen, `.edited-files-card` and `.edited-file` turned out to carry **no CSS rules at
  all**: every file row inherited the ghost button's `justify-center`, so paths sat centred, and
  the header totals ran into the word "files". Fixed in `thread.css`; layout only. **[M]**

## 4. Approval semantics, re-driven after the change **[M]**

`capture-keys.mjs.txt` → `after/keys.txt`. Nothing in this diff touches `approvalKeys.ts`,
`surfaceBlocked.ts` or the decision state machine, but the payload now carries extra focusable
children, so the four arms were driven rather than argued:

| arm | result |
| --- | --- |
| Enter in the card | pending cards **3 → 2**: Enter still approves |
| Escape with the peek sidebar previewed | deny prompts **0 → 1** *and* `data-sidebar-peek` stays **`true`** — the approval wins Escape over the sidebar |
| Escape control, no approval on screen | peek **`true` → `false`** — the sidebar's own Escape is unchanged |
| Enter on a code block's Collapse control | not reachable from the fixture; see §5 |

The card is still non-optimistic: no local `submitted` flag was added, `decision` remains
`"pending"` until the store drops the row, and the `Expired` third state is untouched.

## 5. What was not checked

- **Any timing number.** No burn, no exec→FCP p50, no dropped-vsync count. The brief excluded
  `npm run tauri build` and the burn, and neither was run. Whether these changes move the paint
  budget is **unknown and not claimed**.
- **The packaged app.** Every shot is the dev server in Chromium, not WKWebView.
- **`cargo` gates.** `crates/` is another worker's; only `npm test` (672/672, exit 0) and
  `npx tsc --noEmit` (exit 0) were run.
- **The Collapse control inside a payload block.** Every payload in the fixture fits the block's
  12-line window, so no Expand/Collapse button is rendered and Enter-on-that-button was not
  exercised (`after/keys.txt`, line A). The kit's handler already excludes `button, a` from the
  Enter-approves path, so this is **[A]** by reading.
- **The MCP arm of the code block on screen.** The fixture's live approvals are `tool-permission`
  rows with a recognised shape; the MCP `arguments` block and the `input === null` (truncated
  excerpt) arm were covered by the unit test and by reading, not by a screenshot.
- **Colour by pixel.** Every colour above is `getComputedStyle`, not a picker on the PNG.
- **Light theme.** Every capture is `colorScheme: "dark"`.
