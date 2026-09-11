# The compaction notices, from the running app — 2026-09-11

What a compaction looks like after the owner's ruling of 2026-09-11
(`docs/research/compaction-and-long-sessions-2026-09-11.md` §A10): informational, drawn as a
timeline separator, carrying its measured numbers, and saying **response** rather than
conversation. The failure beside it stays a warning.

Every line here is **[M]** measured — produced by the run whose console output is
`observations.txt` — unless marked **[A]**.

## How these were produced

`npm run dev` on port 1427 (the same `src/` render path the packaged app ships), driven headless
with Playwright 1.63.0 / Chromium 1243 at 1440×1000, DPR 2, dark. The fixture is the repo's own browser
mock (`src/mock.ts`, selected outside Tauri by `bridge.ts`) at `?rps=0&approvals=manual`. Nothing
was stubbed: the rows go through `workspaceApi.chat` → `projectThread` → `NoticePart` → the
vendored `InlineNotice`, the same path a real `session-compacted` takes. The driver is scratch
(the `openApp` helper from `../fixes/capture-open.mjs.txt` plus a screenshot pass) and is not in
the tree; Playwright is not a project dependency and was installed outside the repo.

**Both rows were unreachable from this fixture until now.** `src/mock.ts` emitted no compaction, so
the wording, the level and the numbers had only ever been drawn by a throwaway component harness —
the third state this fixture has hidden from review. `seedCompactionNotices` seeds them mid-turn,
which is the only place a compaction can occur on this product: every user message spawns a fresh
child, so nothing accumulates across messages and only one response's own tool output can fill the
window (`docs/research/does-a-session-accumulate-2026-09-11.md` §0). `projectThread` holds a
mid-turn notice until the work row flushes, which is why both land directly under the activity
fold rather than splitting it.

## Index

| file | what it shows |
| --- | --- |
| `compaction-rows-in-context.png` | both rows under the turn header, above the final answer |
| `compaction-row.png` | the compaction row alone — rule, centred label, rule |
| `compact-failed-row.png` | the failure row alone, in the warning colour |
| `compaction-thread-full.png` | the whole window |
| `observations.txt` | the run's own console output |

## What the run recorded

- The two rows, read back from the DOM by `data-tone` and `innerText` **[M]**:

  ```
  0 "warning" "Could not compact this response's context: too_few_groups"
  1 "neutral" "This response's context was compacted · 12s · 70,633 → 1,379 tokens"
  ```

- `12s`, `70,633` and `1,379` are the real capture's values
  (`crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`, CLI 2.1.268), not placeholders.
  `cumulative_dropped_tokens: 69254` is carried in `detail` and deliberately not drawn: it is every
  compaction in the provider session added together, not this one's loss. **[M]**
- **Zero `pageerror`** and zero React console errors across the run. **[M]**
- No currency anywhere: the whole body text was regex-checked for `$`/`USD` and came back `false`.
  **[M]**

## What was not checked

- **A live CLI.** No `claude` child was spawned; these are the fixture's rows. That the Rust side
  mints exactly these two bodies and levels is covered by `crates/store/tests/feed.rs`
  (`lifecycle_events_project_to_notices_with_deterministic_ids`), not by this run.
- The **manual**-trigger sentence (`This response's context was compacted on request`) has no shot:
  the fixture seeds `auto`, which is the only trigger reachable here.
- Light mode, narrow widths, and `npm run tauri build` / the burn — none were run.
