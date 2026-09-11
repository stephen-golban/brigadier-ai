# Thread rebuild — visual evidence, 2026-09-11

Captured on `ui/codex-thread` at `c7bd5ff` + one uncommitted fix to `src/components/thread/thread.css`
(see §4). Every claim below is **[M]** measured (I ran it and read the output today) or **[A]**
asserted. §5 says what was not checked.

## 0. The headline

**Before the fix in §4 the application could not be built at all, so it had never launched.**
`npm run tauri build` exited **1**: `src/components/thread/thread.css` closed its header comment early
(`--color-*/` on two lines is a literal `*/`), Tailwind's parser then hit `Unterminated string: 's own
surface colour (row 12), the file-change'`, and `vite build` failed in 46 ms. `npm run dev` served a
500 for the stylesheet and the page rendered nothing but `Opening Brigadier…`. **[M]**

After the fix the packaged app launches: a direct run of
`target/release/bundle/macos/Brigadier.app/Contents/MacOS/brigadier` reached
`stage=fcp main_to_fcp_ms=292.68`, resolved `claude 2.1.268`, completed reconciliation over 7
projects and was still alive at 15 s. That is **one uninstrumented launch on a locked console**, not a
harness p50 — see §3. **[M]**

## 1. How these were produced

Two capture paths, deliberately distinguished:

- **`01`–`11`: the real application.** `npm run dev` (the same `src/` render path the packaged app
  ships), driven headless with Playwright 1.61.1 / Chromium 1243 at 1440×1000, DPR 2, dark. The
  fixture is the repo's own browser mock (`src/mock.ts` → `seedConversation`, `bridge.ts:354` selects
  it outside Tauri) at `?rps=0&approvals=manual`. Nothing was stubbed or faked.
- **`harness-*`: a component harness**, because the fixture cannot reach these states. It mounts each
  vendored `src/components/thread/` renderer with plausible props. **The props are mine; they are not
  a claim about what the wire produces.** Sources kept beside the shots as
  `renderer-harness.tsx.txt` / `renderer-harness.html.txt`; the live copies
  (`src/threadHarness.tsx`, `thread-harness.html`) were deleted, and `npx tsc --noEmit` and
  `npm test` were re-run clean afterwards. **[M]**

**Every renderer executed without throwing.** Across both passes Playwright recorded **zero**
`pageerror` and zero React console errors; the only console entry is a 404 for a favicon. The brief
flagged Notices/ThreadState/FileChangeGroup/ToolCallCard/McpToolCallGroup/SubagentActivity as never
having executed — they execute. **[M]**

## 2. Index

### Real application (browser mock fixture)

| file | what it shows |
| --- | --- |
| `01-thread-collapsed-full.png` | whole window: user bubble, `Worked` turn header, collapsed activity fold, assistant markdown answer, two pending approval cards, composer |
| `02-turn-header.png` | the turn header row — `Worked` + chevron + hairline |
| `03-user-message.png` | row 1, user message bubble (right-aligned, radius 22 px) |
| `04-assistant-answer.png` | row 2, final assistant answer through `Markdown.tsx` |
| `05-activity-group-collapsed.png` | row 6, activity fold collapsed |
| `06-activity-group-expanded-full.png` | whole window with the fold open |
| `07-activity-group-expanded.png` | row 6 open: nested subagent group, reasoning row, `Ran commands` group |
| `08-reasoning-collapsed.png` / `08-reasoning-expanded.png` | row 4, reasoning disclosure — label reads **`Reasoning`**, not `Thought for Ns` |
| `09-command-row-1.png` / `09-command-row-2.png` | row 7, `CommandExecution` with shell, `$ cmd`, stdout, and the footer |
| `10-approval-pending.png` | row 12, pending approval card (kit `ApprovalRequest`, Deny `esc` / Allow `⏎`) |
| `11-after-approval-allow-full.png` | after clicking Allow: the card cleared on `request-resolved`, new pending cards arrived |

### Component harness (states the fixture cannot reach)

| file | what it shows |
| --- | --- |
| `harness-turn-duration.png` | row 5 in all three statuses, including `Worked for 1m 32s · done …` above the 60 s floor |
| `harness-activity-collapsed.png` / `harness-activity-expanded.png` | row 6 with mixed `AgentActivity` kinds incl. a failed row |
| `harness-command-ok.png` / `harness-command-fail.png` / `harness-command-running.png` | row 7 — **`harness-command-fail.png` is the non-zero exit code**: `Exit code 127` with stderr |
| `harness-file-change.png` | row 8, `FileChangeGroup` with `+A −D` per file (**never mounted by the app**) |
| `harness-tool-call.png` | row 9, `ToolCallCard` + `McpToolCallGroup` (**never mounted**) |
| `harness-search.png` | row 10, `SearchActivity` code + web |
| `harness-subagent.png` | row 11, `SubagentActivity` + group chips (**never mounted**) |
| `harness-approval-pending.png` / `-file.png` / `-approved.png` / `-rejected.png` / `-expired.png` / `-loading.png` | row 12 in every decision state, including brigadier's `"expired"` Dismiss-only extension |
| `harness-compaction.png` | row 13, `ThreadContextOptimization` (**never mounted**) |
| `harness-notices.png` | row 14 — `StatusBanner` ×3 tones, `InlineNotice` ×2, `SystemErrorNotice`, `StreamNotice` ×2, `WorkingDirectoryNotice` |
| `harness-interruption.png` | row 14, `ThreadInterruptionSummary` (**never mounted**) |
| `harness-thread-state.png` | loading / reconnecting / thinking / skeleton / render-error / shimmer (**never mounted**) |
| `harness-agent-message.png` | rows 1–2 + the five `StatusIndicator` states |

## 3. What could not be produced, and why

| wanted | status |
| --- | --- |
| turn header with **elapsed time and completion time** | **Not from the fixture.** `.thread-turn-duration` textContent is exactly `"Worked"`: the mock supplies no `ChatTurn.ended_at`, so `row.completedAtMs` is null and `WorkTrace.tsx:97`'s `done` string is empty; the turn is also under the 60 s floor so `Worked for` is correctly suppressed. The code path is conditional on data, not broken. Shown with data in `harness-turn-duration.png`. **[M]** |
| command row with **non-zero exit code** | Not from the fixture (the mock emits no failing shell result). `harness-command-fail.png`. **[M]** |
| **file-change card** | Not reached in the app: `FileChangeGroup` has no mount site in `src/`; what the app draws under a final answer is `ArtifactCard`. `harness-file-change.png` is the kit component, unmounted. **[M]** |
| approval **resolved** and **expired** | Not from the fixture: the mock writes no `composer_approval_history`, so no `ApprovalResolution` row appears after Allow (`11-…png`). Both states shown in `harness-approval-*.png`. **[M]** |
| **notice row** | Not from the fixture: the mock seeds no `notice` `ChatItem`. `harness-notices.png`. **[M]** |
| **streaming answer mid-turn** | Not producible. The mock resolves a turn synchronously; there is no delta path in it. **[A]** |
| **burn / 60 Hz / exec→FCP p50** | **Not measurable this session.** `IOConsoleLocked = Yes` continuously from 04:37 to 04:45; `scripts/measure-native-startup.py:28` refuses and returns `{"p50_ms": null, "pass": false}` (exit 1) — recorded in `startup-refusal-2026-09-11.json`. **[M]** |

## 4. The fix that made the build honest

`src/components/thread/thread.css`, two lines, comment text only, no rule changed:

- `:22` `… existing --color-*/` + newline `* --radius-* layer …` → `--color-* /` + `--radius-*`
- `:39` `/* ---- aliased onto brigadier's existing --color-*/--radius-* layer ---- */` → `--color-* / --radius-*`

`/*` and `*/` counts went 17 / **19** → 17 / 17. `npm run tauri build` then exited **0** and produced
`Brigadier.app` and `Brigadier_0.1.0_aarch64.dmg`. **[M]**

## 5. Defects visible in these shots

1. **`Exit code unknown` on every successful command.** `09-command-row-1.png` and `-2.png` both show
   it. Rust sets `exit_code` only on a failing shell result
   (`crates/core/src/claude/adapter.rs:1132-1136`), and `CommandExecution.tsx:244-246` falls through to
   `` `Exit code ${exitCode ?? "unknown"}` `` for anything that is not `exitCode === 0`. §3 row 7
   expects `Success`. **[M]**
2. **A non-zero exit is not red.** `.thread-command-execution__footer` has one colour,
   `var(--thread-text-tertiary)` (`thread.css:1957-1966`), and no failure rule; `harness-command-fail.png`
   renders `Exit code 127` in the same grey as everything else. §3 row 7: "Non-zero exit → red". **[M]**
3. **The reasoning row is still `reasoning-panel.tsx`.** Collapsed label is `Reasoning`, not
   `Thought for Ns` (`08-reasoning-collapsed.png`). §3 row 4 called for the aui `reasoning` element. **[M]**
4. **Upstream product copy leaked.** `ThreadState.ThreadLoadingState` with `kind="reconnecting"`
   renders **"Reconnecting to ChatGPT…"** (`harness-thread-state.png`). The component is unmounted
   today, so no user sees it, but the string is in the bundle. **[M]**
5. **Approval body overflows its card by 14 px.** Measured in-page: `.approval-body` (brigadier's own
   markup, not the kit's) `scrollWidth 750` vs `clientWidth 736`, driven by `.suggestion`
   `white-space: pre`. It is `overflow-x: auto`, so the text is reachable by scrolling, not lost —
   but it reads as clipped (`10-approval-pending.png`). **[M]**
6. **The turn header takes a hover fill.** `.thread-activity-timeline__toggle:hover` sets a background
   (`thread.css:251-254`); §3 row 5 says hover is text-only (60 % → 100 %). **[M]**

## 6. What was not checked

- **Any timing number.** No burn, no dropped-vsync count, no exec→FCP p50: the console was locked the
  whole session and both harnesses refuse by design. The 292.68 ms in §0 is one launch's internal
  `main → fcp`, not the gate's `pre-spawn → FCP`, not a p50, and not activated to the foreground.
- **The packaged app's own UI.** The `01`–`11` shots are the dev server in Chromium, not WKWebView.
  Fonts, scrollbars and compositing can differ. The packaged binary was only observed to boot.
- **Isolation of that boot.** The launch in §0 used the default data directory
  `~/Library/Application Support/ai.brigadier.app` and ran its normal startup reconciliation against
  the user's real projects (pruned/repaired worktrees, 7 projects). No isolated identifier was used.
- **Every state at the same time.** The fixture regenerates approvals every 4 s under
  `?approvals=manual`, so the approval cards differ between shots taken minutes apart.
- **Token measurement by pixel.** Conformance claims here are read out of CSS and computed style, not
  measured off a screenshot with a colour picker.
