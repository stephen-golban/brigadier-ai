# Compact conversation work blocks

Implemented and revised 2026-09-09 in the main checkout. The revision follows the owner's five screenshots and direct inspection of the installed application bundle.

## Installed source inspected

The reference application is `/Applications/ChatGPT.app`, bundle ID `com.openai.codex`, version **26.901.51231**. Its frontend is in `Contents/Resources/app.asar`. Read-only inspection extracted only relevant packaged JavaScript into `/tmp/codex-reference`; application files were not changed. No private server source, account data, or internal model instructions were inspected. Brigadier's implementation is independently written; vendor source is not copied into the repository.

Reproducible source anchors within the archive:

| Asset | Function / identifier | Behavior established |
| --- | --- | --- |
| `webview/assets/app-initial-cadb12d4a15e.js` | `hna`, `_na`, `gna`, `Cna` | Working/Worked labels, one-second clock, elapsed-time divider, trailing disclosure arrow |
| Same | `dQn`, `fQn`, `gQn` | Placement of the worked-for item, explicit final-answer phase, final-answer start timestamp |
| `webview/assets/subagent-activity-chip-group-985efc2d5846.js` | `$E`, `tD`, `GE` | Turn collapse conditions, retained interactive items, expansion preferences |
| Same | `OE`, `AE`, `ME`, `g_` | Current activity label, completed summary, tool details and disclosure state |
| `webview/assets/content-reference-markers-d681e6741f57.js` | `Z`, `Le`, `Q`, `_e` | Adjacent activity groups, current-item state, category aggregation |

These are minified function names from this installed build, not stable public APIs. The owner's screenshots corroborate their visual behavior.

[OpenAI's App Server documentation](https://learn.chatgpt.com/docs/app-server), fetched 2026-09-09, separately documents threads, turns, item lifecycle notifications, outcomes, and optional commentary/final-answer phases. The installed frontend establishes the disclosure policy that the public protocol documentation does not specify.

## How the reference actually works

There are three independent levels, not one generic accordion:

1. **Turn.** The header says Working, then Working for an elapsed duration after one second. A one-second clock measures from recorded work start. When the final answer starts, the work timer freezes at that timestamp; final-answer generation time is not part of that work duration. Work before the final answer can collapse into Worked for. The final answer remains outside it.
2. **Activity group.** Consecutive groupable items share a compact summary. Commentary and other standalone content break groups. Category counts choose singular/plural wording but normally do not appear as numbers: for example, Read files, ran commands, searched the web. Only the latest open activity slice is eligible for a live label. It uses the current incomplete action, or Thinking if none is active.
3. **Tool details.** Expanding a group reveals compact individual actions. Expanding an action reveals its arguments/output. The tool type supplies its icon; detail indicators are subtle until hover/focus or expansion. Large groups use contained scrolling.

Turn auto-collapse requires a final answer to have started, renderable preceding activity, and a turn that was not cancelled. Forced expansion and a prevent-auto-collapse flag can override the default; an explicit persisted preference also participates. Cancelled turns remain expanded. Some interactive content, including steering messages and qualifying app widgets, remains visible outside folded activity.

Activity disclosures have opening, expanded, closing, and collapsed states. Their detailed contents unmount once collapsed. This is display folding, separate from provider context compaction and separate from the model deciding to call tools.

“Thinking” is a UI fallback when no current action is active. More specific reasoning headings require provider-supplied summary content. They are not evidence that the client can access private internal model reasoning.

### Completed-turn reference supplied by the owner

The subsequent screenshot and expanded transcript show the same turn at **Worked for 15m 53s**. Collapsed, it displays one work divider followed by the final answer, web preview, and changed-file card. Expanded, it restores the chronological sequence of commentary and separate activity summaries; each summary can reveal individual tools and their outputs. Commentary boundaries must therefore survive folding: gathering every tool into a single flat list would lose the reference structure.

The ThreadView regression uses a recorded 15m 53s turn with three commentary-separated command groups. It checks that the parent initially hides all progress, the answer stays visible, groups open independently, and reopening the parent restores an expanded tool's output. The focused ThreadView suite passes all 11 tests. No production change was needed for this additional reference.

## Brigadier revision

The first pass incorrectly combined current activity with the parent timer and collapsed interrupted work. The revision fixes that:

- A separate turn divider carries Working for / Worked for timing, with a trailing arrow only when previous work can fold. Prose-only turns with recorded timing can show a divider without an empty disclosure.
- Commentary stays aligned with the final answer. Adjacent tools summarize categories; each group and its individual actions expand independently.
- Only the newest activity group shows live state. Thinking follows commentary when the session is active without a current tool. Earlier groups retain completed wording.
- Finalized preceding work folds. Interrupted, failed, and stopped work remains open. Tool failures remain visible; generic success checkmarks are removed.
- Historical expansion and nested details retain existing per-session persistence. Long traces render at most 40 groups initially; live traces favor the newest work, with earlier groups available on demand. Expanded tool batches have contained scrolling.
- Approval/request controls, edit/copy/file links, and final changed-file cards retain their handlers. The existing 2,000-item retention cap remains; closing a block does not alter retained bodies or model context.

Implementation: `src/threadProjection.ts`, `src/components/WorkTrace.tsx`, `src/components/ThreadView.tsx`, and the editable assistant-ui Tool Call Element.

## Remaining provider difference: exact final-start timing

Brigadier's current Claude adapter emits paired ItemStarted/ItemCompleted records after receiving a completed content block (`crates/core/src/claude/adapter.rs`, `emit_item`). Those are not first-token timestamps. Its normalized assistant items carry neither a commentary/final phase nor an explicit final-answer-start event.

Consequently, Brigadier currently identifies trailing main-session prose as the answer after the harness turn ends. Its duration uses recorded turn start/end; it cannot yet exclude final-answer generation time or collapse at the model's first final token. This is an explicit difference from the installed Codex frontend, not exact timing parity.

For exact event-level parity, the provider bridge needs stable item IDs plus incremental item state, explicit assistant phase (`commentary` or `final_answer`), and a trustworthy first-final-token timestamp. Persist that timestamp separately from turn completion. The renderer can then freeze the work timer and fold earlier work as soon as final-answer streaming begins, while keeping the overall turn active. Do not manufacture that marker from prose wording or use the current synthetic ItemStarted timestamp as a substitute. Codex's documented protocol supplies an explicit phase; the present Claude adapter does not.

## Durable data and verification

Schema 10 adds a bounded `chat_turns` table with harness turn identity, event sequence bounds, timestamps, and outcome. Updates use the existing writer queue. Session deletion cascades; forks retain complete lifecycle spans within their copied prefix. Replay cannot overwrite a terminal outcome. Old sessions and unfinished recovered turns omit durations without supporting evidence.

After the reference revision, `npm test` passed **397 tests across 45 files** and `npm run build` passed. Coverage includes turn grouping, tool correlation, categories, long-duration formatting, interrupted expansion, timed prose-only answers, nested disclosures, latest live activity, and preserved user actions. The preceding backend implementation passed **675 Rust tests, 8 ignored**, and `cargo check -p brigadier`; this revision did not change Rust code.

Browser inspection at port 1425 verified the updated divider, collapsed parent, aligned commentary, nested details, and contained tool groups using the existing simulated conversation. The installed Brigadier app was not replaced and a live native provider session was not run. Existing Vite browser-externalization and large-chunk warnings remain.

**Subsequent native verification:** [real-session QA and fixes](compact-work-native-qa-2026-09-09.md) supersede the earlier browser-only limit. Real Claude sessions verified completion, nested activity groups, requests/outputs, changed-file cards, interruption, and saved timing. Native testing added a background feed-drain fallback and strict checkpoint recapture retries. The [Claude protocol investigation](claude-final-start-2026-09-09.md) confirms the remaining first-final-token limitation.
