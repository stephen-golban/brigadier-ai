# Codex Thread Anatomy — protocol and reference-client digest

Digest of a locally captured HTML reference page titled "Codex Thread Anatomy" (`openai/codex @ 713caa8`,
learn.chatgpt.com, dated 2026-09-10), gathered 2026-09-10. The source page itself was a session-local
download, not part of this repository, and will not survive past the session that produced this digest —
treat this file, not that page, as the citable artifact. Method: read the page's HTML source directly; line
numbers below are raw-HTML line numbers in that 903-line, 76 KB source, kept so a claim can be checked
against a fresh capture of the same page. Every claim below carries the source page's own provenance badge
(PROTOCOL / TUI / DOCS / REPORTED — see §1), which is the load-bearing signal for how firm it is.

**Authority.** This file is authoritative for the `codex app-server` protocol's data model, and for the
grouping/truncation/streaming rules and row taxonomy and copy of OpenAI's *open-source terminal reference
client* for that protocol — everything badged PROTOCOL or TUI. It is explicitly **not** authoritative for
the closed Codex desktop app's actual pixels, spacing, colour or motion: those claims are badged DOCS
(official desktop docs) or REPORTED (a GitHub issue from a desktop user), are second-hand at best, and §6
and §8 below enumerate exactly what is undocumented about the desktop app's visual design. For the desktop
app's measured pixels, see `codex-thread-tokens.md`, which reads the shipped Electron bundle directly. For
which component source best matches these row kinds and what data brigadier already has for each, see
`codex-thread-row-mapping.md`. This digest directly resolves `cli-steer-and-exit-codes.md`'s relevance to
ambiguity #13 below (steer vs queue).

All line numbers below are raw-HTML line numbers in that file. 903 lines, 76 KB, single self-contained page.

## 1. Document shape

- **Not screenshots.** It is an authored, styled HTML reference page: sticky TOC, a live filter box (`#q`, L179, JS at L888–899), 13 `<section>`s, prose + tables + two-column "catalog" entries whose right column is an **ASCII mock of the terminal reference client's output** (`<pre class="spec">`, e.g. L384–385, L446–451). There is no photograph or capture of the desktop app anywhere.
- Title `Codex Thread Anatomy`, eyebrow `Reference · openai/codex @ 713caa8 · learn.chatgpt.com · 10 Sep 2026` (L186–187). Dated **today**.
- **Sections (13):** `#where` Where the truth lives (L197) · `#wire` A turn on the wire (L228) · `#model` Thread · Turn · Item (L329) · `#items` Item catalog (L368) · `#live` Streaming & status (L581) · `#collapse` Grouping & truncation (L640) · `#composer` Composer & running turns (L658) · `#approvals` Approvals & questions (L728) · `#actions` Thread actions → API (L744) · `#around` Around the thread (L772) · `#keys` Shortcuts (L818) · `#gaps` Not documented anywhere (L840) · `#sources` Sources (L862).
- **Provenance tagging is the doc's spine.** Every claim carries one of four badges (L190–193): `PROTOCOL` exact, from app-server-protocol types · `TUI` OpenAI's reference client source · `DOCS` official desktop docs · `REPORTED` GitHub issue from a desktop user. Use the badge to know how firm a claim is.
- **Explicit instructions / opinions written into the doc (verbatim):**
  - L188: "The ChatGPT / Codex desktop app is **closed source**. … But everything that thread draws comes from an **open protocol**, and OpenAI also publishes an **open reference client** for that protocol. … This page collects it so you can rebuild it."
  - L223: "**Gives** the look. **Caution** its bundled JavaScript is proprietary. Study how it behaves; don't lift its code or assets."
  - L494: "For Brigadier, this is the pattern for letting an agent drive UI-owned capabilities without routing them through the CLI." (on `dynamicToolCall`)
  - L572: "No documented presentation for `functionCallOutput` or `sleep`. That one is your call."
  - L716: "It maps closely to Brigadier's pinned plan card." (on `/goal` / `ThreadGoal`)
  - L842: "These exist only as pixels in the closed app. Treat them as your own design decisions, or measure them from a screen recording."
  - L855: "Run a throwaway repo in the app and trigger each state on purpose: a read-only exploration, a failing command, an edit that needs approval, a steer mid-turn, a queued message, an interrupt, a plan, a fork. Screen-record at 60 fps and step through frames for timings; zoom screenshots for spacing. The protocol tells you which states exist, so you know when the list is complete."
  - L858: "**For Brigadier.** When you add Codex support, run `codex app-server` as a stdio JSON-RPC child, the same pattern you already use for Claude Code. `codex app-server generate-ts` writes these exact TypeScript types for your React side, so the item catalog above becomes your frontend's type definitions."
  - L882: "The desktop app changes weekly, so re-check REPORTED items against your installed version."
- **The load-bearing caveat:** the doc is an anatomy of the *protocol* and of OpenAI's *terminal* reference client. It is explicit (§Not documented anywhere, L840–852) that the desktop app's actual visual design is undocumented. "Present the thread exactly like Codex" is therefore only ~60% answerable from this document.

## 2. Row / block kinds (§Item catalog, L368–578; 19 `ThreadItem` variants per L347)

Data model first (§Thread · Turn · Item, L329–363): Thread{…, status: notLoaded|idle|active|waitingOnApproval|waitingOnUserInput|systemError} ⊃ Turn{items[], itemsView, status: inProgress|completed|interrupted|failed, durationMs} ⊃ Item{status: inProgress|completed|failed|declined} (L334–348). Item lifecycle is uniformly `item/started → *Delta… → item/completed` (L347).

| Kind | Visual treatment (reference client) | Default state | Grouping | Streaming vs done |
|---|---|---|---|---|
| **User message** `userMessage` (L375–385) | `› text` prefix; `text_elements` (mentions, placeholders) render as **atomic chips**; images as `[Image #1]` chips | expanded | none | Drawn **on submit**, not on server echo (L237–239); dedupe the echo by `clientId` (L378). Desktop: only the **last** user message is editable in place (L380). Steered messages become normal user bubbles (L381) |
| **Agent message** `agentMessage` (L390–401) | `•` bullet + markdown body | expanded | `phase: commentary \| final_answer \| null` splits interim from final | Streams via `item/agentMessage/delta`; on `item/completed` the streamed rows are **replaced by one markdown render of the final text** (L393, L602). Working line stays up after commentary, hides after final answer (L394). `questions[]` = non-blocking questions answerable while work continues (L395) |
| **Reasoning** `reasoning` (L406–415) | **Not a thread row at all** in the reference client. The last `**bold**` summary header becomes the live **status-line** text; full text only in the transcript view (L410) | n/a | n/a | Events `summaryTextDelta`, `summaryPartAdded` (new section), `textDelta` (raw, when enabled) (L409). Desktop 26.602: a **blinking "Thinking" label**, then the answer, **no visible summaries**; the IDE extension shows a collapsed "thinking…" section (L411). Shared snapshots do include reasoning summaries, so they are real content (L412) |
| **Plan — two different things** (L420–432) | (a) checklist `turn/plan/updated`: `• Updated Plan` + `└ explanation` + `✔ / □` steps. (b) `plan` item: a markdown proposal written in **Plan mode**, streamed by `item/plan/delta` | expanded | — | After a proposed plan: "Implement this plan?" → *Yes, implement this plan · Yes, clear context and implement · No, stay in Plan mode* (L424). Plan mode toggles `⇧Tab` or `/plan` (L425) |
| **Command** `commandExecution` (L437–451) | `• Ran <cmd>` with `│` continuation and `└` output rows; non-zero exit → **red bullet**; declined → red; interrupted → failed (L442) | collapsed to 5 rows | `commandActions[]` (server's parse: `read \| listFiles \| search \| unknown`) decides exploration vs real run (L440) | Live via `item/commandExecution/outputDelta`; `terminalInteraction` sends stdin to a background terminal (L441). Desktop "For coding" view collapses to sentences like "Edited 3 files, explored 2 files, 2 searches" / "Ran 2 commands", expandable on click (L443); a **Command output display** setting controls verbosity |
| **File change** `fileChange` (L456–470) | `• Edited N files (+A -R)`, per-file `└ path (+A -R)`, line numbers, `⋮` between hunks, red/green line tint (L650) | expanded | one file → `Edited path (+A -R)`; several → count row + per-file rows **sorted by path**; renames `old → new` | **Drawn at `item/started`, before approval** (L283, L460). On completion only a *failure* adds a row ("✘ Failed to apply patch"). Desktop: in-thread card "3 files edited" + counts + **Review** button opening the review pane; card counts come from turn data while the pane shows live git, **so the two can disagree** (L461); **Undo** button, partial failure dialog "There were issues reverting some files" / "Skipped (1)" (L462) |
| **MCP tool call** `mcpToolCall` (L475–483) | `• Called server.tool({args})` + dim `└` result, **capped at 5 lines**; errors as `Error: …` (L479) | collapsed | — | Progress via `item/mcpToolCall/progress`; label flips **Calling → Called** |
| **Client-side tool** `dynamicToolCall` (L488–494) | not specified | — | — | Server sends `item/tool/call` as a *request* and waits for the client's result; hook for UI-owned tools (browser, canvas, pickers) (L491) |
| **Web search** `webSearch` (L499–507) | Header line only, **never results**, in the reference client (L502): `• Searched the web for …` | — | — | Desktop: results and citations appear in the chat (L503) |
| **Sub-agents** `collabAgentToolCall` / `subAgentActivity` (L512–523) | `• Waiting for 2 agents` + `└ Robie [explorer]` / `Juno [tester]`; then `• Finished waiting` + `└ Robie [explorer] : Completed - Done` | expanded | — | Each sub-agent is **its own thread** (`parentThreadId`), so "open sub-agent" = navigate to that thread (L515). States `pendingInit\|running\|interrupted\|completed\|errored\|shutdown\|notFound`. Desktop: activity indicators in the main thread + a **Subagents panel** with Active/Done, open/steer/stop each; IDE shows active sub-agents above the composer with "stop all" (L516) |
| **Context compaction** `contextCompaction` (L528–537) | While compacting the status line takes its own header + timer; on completion **one notice row**: `• Context compacted · 12s` | — | — | Automatic, or `/compact`; notification `thread/compacted`, manual trigger `thread/compact/start` |
| **Review mode** `enteredReviewMode` / `exitedReviewMode` (L542–551) | **Banner rows bracketing** the review's items: `>> Code review started: uncommitted changes <<` … `<< Code review finished >>` | — | brackets a range | `review/start{target: uncommittedChanges \| baseBranch \| commit \| custom}`; desktop findings land as **inline comments in the review pane** |
| **Images** `imageView` / `imageGeneration` (L556–563) | `• Viewed Image` + `└ path` | — | — | Desktop viewer with Focused and Canvas views, multi-select, comments for targeted edits |
| **Plumbing** `hookPrompt` / `functionCallOutput` / `sleep` (L568–576) | Hooks **hidden for their first 300 ms**, then status-line only ("Running hooks"); stay in history only if they printed output or blocked: `• Blocked by hook └ reason` (L571) | hidden | — | "No documented presentation for `functionCallOutput` or `sleep`. That one is your call." (L572) |
| **Errors** (L362) | — | — | — | Carried on `turn/completed.error` / `error` / `warning`; `codexErrorInfo` enum: contextWindowExceeded, usageLimitExceeded, rateLimitExceeded, serverOverloaded, httpConnectionFailed, responseStreamConnectionFailed, sandboxError, unauthorized, badRequest, … |
| **Model change notices** (L363) | — | — | — | `model/rerouted`, `model/safetyBuffering/updated` |
| **Fork notice** (L751) | `• Thread forked from <name>` | — | — | — |
| **User-run shell** (L762) | `• You ran` row, **50-line cap** | — | — | TUI `!cmd`; protocol `thread/shellCommand` |

Side-state that lives next to the thread rather than in it (L352–363): plan checklist, `ThreadGoal`, turn diff, context meter, queue, sidebar section, errors, model changes.

## 3. Turn structure (§A turn on the wire L228–326; §Streaming & status L581–635)

- The whole worked example is L235–323: submit → `turn/started` (timer resets, `thread/status/changed → active` drives the sidebar spinner, L244–245) → reasoning → exploration group → plan update → diff row → approval → `turn/diff/updated` → command output → answer stream → `turn/completed`.
- **The working line** (L609–616) is the running summary, not a collapsed group: `• Preparing evidence report (1m 04s • esc to interrupt) · 1 background terminal running` with `└ cargo test -p parser`. Header source **in priority order**: a special state (compacting, waiting on a background terminal, auto-review, MCP boot, hooks, reconnecting) → the latest reasoning header → "Working". Elapsed format `0s · 59s · 1m 00s · 1h 02m 03s`. **The timer pauses while an approval or modal is open.** Hidden while answer text is revealing; shown again after a commentary message; stays hidden after the final answer.
- **End of turn** (L620–625): `Worked for 1m 14s · done 3:04 PM`. **"Worked for" appears only for turns longer than 60 s**; the "done" time always appears (`done Mar 3 at 3:04 PM` on other days). Then: send the next queued message, fire a desktop notification, and in Plan mode ask "Implement this plan?". Interrupted turns render `■ Conversation interrupted - tell the model what to do differently.`
- **Final answer vs working steps** is carried by `agentMessage.phase` (L394), not by layout — commentary keeps the Working line, final_answer hides it. How they differ *visually* on desktop is listed as undocumented (L852).
- **Collapse under a summary is a desktop-only behaviour and only REPORTED** (L443, L653): "Groups of activity become sentences: 'Edited 3 files, explored 2 files, 2 searches', 'Ran 2 commands', expandable. REPORTED #19891". The reference client instead has **two detail levels** — a compact form in the main thread and a full form in the transcript view (`ctrl T`), where reasoning, full output and exit codes live; "A desktop build of this is click-to-expand" (L652).
- **Ordering guard** (L605–606): while an answer streams, starts/ends of commands and MCP calls, patch results, approvals and questions go into a **FIFO queue** released when the stream ends, so a tool row never lands mid-sentence. A tool starting also closes the current text stream.
- **Streaming cadence, exact TUI constants** (L586–598): deltas commit only up to the last `\n` (never a half line); committed source is re-rendered as markdown each time; **tables held back in a mutable tail until the stream ends** because a new row changes column widths. Reveal is 1 line/frame-tick; catch-up flush starts at **≥8 queued lines or oldest ≥120 ms**; exits when queue stays ≤2 lines / ≤40 ms for **250 ms**, no re-entry for 250 ms unless backlog ≥64 lines / ≥300 ms.
- **Resume & replay** (L634–635): loading history runs the same item handlers with animation off; if the last turn is still running the working line and its latest reasoning header come back; long histories page in older turns via `thread/turns/list` + `itemsView`.
- **Grouping & truncation rules** (§L640–653): exploration merge — a new command joins the open group **only if every action in it is read/listFiles/search**; a finished exploring group stays open for more reads and closes when any other row appears; consecutive reads collapse to `Read a.rs, b.rs` with duplicates removed. Verb tense flips on completion: Running→Ran, Exploring→Explored, Calling→Called, Searching the web→Searched the web for, Using→Used. Output cap **5 visible rows** (head, `… +N lines (ctrl + t to view transcript)`, tail); user `!` commands get 50; long command text shows 2 continuation rows. Live buffer keeps 1 MB, then first/last 50 lines with `... N bytes omitted ...`. Tool results: JSON flattened to one line, capped 5 rows × width.

## 4. Composer (§Composer & running turns, L658–723) — covered in depth

- **Steer vs queue** (L663–667): `turn/steer{threadId, input, expectedTurnId}` "adds the message to the current run", fails if the turn changed, **cannot carry model or setting overrides**. Queue "saves the message for the next run", sent automatically one at a time as each turn ends. Desktop default at Settings › General › Follow-up behavior; IDE setting `followUpQueueMode` takes queue|steer|interrupt.
- **Pending-input display** (L671–680): `• Messages to be submitted after next tool call / (press esc to interrupt and send immediately)` then `↳ …`; separately `• Queued follow-up inputs` + `↳ …`; hint `⌥ + ↑ edit last queued message`. **Enter steers, Tab queues.** A refused steer (during review or compaction) drops to "Messages to be submitted at end of turn". A steer becomes a normal user row when the server echoes a matching `clientUserMessageId`.
- **Interrupt** (L684–688): `turn/interrupt`; running rows marked failed, half-streamed tail dropped. With pending steers: interrupt then send them all as one new turn ("Model interrupted to submit steer instructions."). Otherwise pending/queued text returns to the composer — "Nothing is lost."
- **Inputs & mentions** (L692–697): `@` for files/plugins/skills with All / Filesystem / Plugins tabs; `$skill` to invoke a skill; picks become **atomic chips** sent as `skill`/`mention` inputs. Pasted images → `[Image #N]` chips; TUI pastes >1,000 chars collapse to `[Pasted Content N chars]` and expand on send. Desktop: "+" add menu, Shift-drag images, dictation `⌃⇧D`, voice chat `⌃⇧V`, `↑` restores previous prompt. File search is live and fuzzy (`fuzzyFileSearch`).
- **Pickers under the composer** (L701–706): Where it runs — Local · Worktree (with starting branch) · Cloud (environment picker). Permissions — Ask for approval · Approve for me (auto-review) · Full access · Custom. Model `⌃⇧M`, reasoning effort `/reasoning`, speed `/fast`, personality (Friendly · Pragmatic · None). **Mode toggle above the composer: Chat · Work, plus ChatGPT · Codex (`⌃1 ⌃2 ⌃3`).**
- **Slash commands** (L710–712), 24 of them incl. `/plan /review /fork /side /goal /compact /worktree /model`. In the TUI each command is flagged usable-or-not during a running turn.
- **Goal mode** (L715–716): `/goal` sets a long-running objective; desktop shows a **progress row above the composer** with pause/resume/edit/clear; `ThreadGoal{objective, tokenBudget, tokensUsed, timeUsedSeconds, status}`.
- **Footer hints** (L719–723): `? for shortcuts` … `62% context left`; `tab to queue message`; `esc again to edit previous message` — the hint changes with state (idle, typing during a turn, Esc pressed once).
- **Context meter**: data is `thread/tokenUsage/updated{total, last, modelContextWindow}`; the TUI shows "% context left **after subtracting a 12,000-token baseline from both sides**" (L359). Whether the desktop composer shows a meter is explicitly **unknown** (L847).
- The Stop button and its states are **not documented** (L846).

## 5. Chrome around the thread (§Around the thread, L772–812; all `DOCS`/`REPORTED`)

- **Review pane** (L777–783): scopes Unstaged (default) · Staged · Commit · Branch · **Last turn** (only the agent's latest edits); repo selector for multi-repo. Stage/unstage/revert at three levels (everything, file, hunk). Click filename → open in editor; click row → expand/collapse; ⌘-click a line → jump. Hover a line, press `+`, write a comment, then tell the agent to address inline comments; comments collapsible. PR context and reviewer comments beside the diff; commit and push from the pane; **diffs editable inline**.
- **Sidebar** (L787–793): New chat (+ Quick chat) · Projects · Plugins · Chats · Scheduled. Sort By project (default) or Chronological; chats and projects pinnable. Custom sections (Edit section · Archive all chats · Delete section), manual order, new chats to the bottom. Search covers titles, content and **branch names**. Activity view `⌘⌥U` lists unread/running/waiting, filters Work · Chat · Pinned · Scheduled, "Mark all as read". `⌘⌥A` jumps to next chat needing attention.
- **Chat header & panels** (L797–803): header has Open (in editor), Hand off, Create branch here, terminal toggle, review toggle, **usage indicator (credits, estimated cost)**. Integrated terminal `⌃\`` scoped to the chat's worktree, agent can read its output. Built-in browser `⌘⇧B` with annotation mode. Files: search `⌘P`, tree `⌘⇧E`, side-by-side previews of generated docs/PDFs/HTML. Chats pop out into their own window with Always on top.
- **Long-running work** (L807–812): completion notifications (never / when backgrounded / always) with separate toggles for approvals and questions; "Prevent sleep while running"; Scheduled tasks inbox (Active/Paused/Completed, run history with unread markers, Run now); worktrees — the **15 most recent kept**, snapshot saved before cleanup, pinned chats' worktrees kept.
- **Attention states** (L629–631): Running · Needs input · Ready (unread) · Blocked (error). Priority when several apply: **needs input › blocked › ready › running**. Codex Micro hardware palette: white = idle, blue = thinking, green = complete/unread, amber = needs input, red = error — "a ready-made status palette for sidebar dots".
- **Thread actions → API** (§L744–767) is a full table of 18 actions with their protocol calls; the doc's own warning at L746: "**none of the history calls touch files on disk**. Undoing edits is a separate, git-side job." Key ones: edit-message = `thread/fork` + `thread/revert` (fork to the turn before, reopen, restore old prompt/images/mentions into the composer); `thread/fork{lastTurnId inclusive, ephemeral}`; `thread/revert{beforeTurnId}` rewrites stored history only; side chat = `thread/fork{ephemeral:true}`; share = read-only snapshot including messages, reasoning summaries, images, diffs but **excluding tool calls and shell output**, with known secrets redacted (L764); "**No documented per-message copy button**" (L765).

## 6. Visual language — thin, and the doc says so

- What *is* given is the reference client's terminal grammar, reproduced as ASCII in every `Reference render` panel: `›` user prefix, `•` row bullet, `└` / `│` child rows, `⋮` between diff hunks, `✔`/`□` plan checkboxes, `↳` queued input, `>> … <<` review banners, `✗`/`✘` failures, `… +N lines (ctrl + t to view transcript)` truncation.
- Colour: only semantic states — non-zero exit / declined → **red bullet** (L442); diff **red/green line tint** (L650); MCP result **dim** (L479); attention-dot palette at L631.
- Motion: **the working-line header shimmers in a 2 s sweep that restarts only when the text changes; with reduced motion it's plain text** (L614). Reveal cadence constants at L594–596. "Desktop motion timings (the TUI's timings above are the only published ones)" is listed as a gap (L850).
- **Typography, spacing, type scale, bubble radii, max width, density, borders — not covered.** §Not documented anywhere (L844) names exactly this: "Bubble styling: user vs agent treatment, max width, radii, type scale, spacing rhythm".
- The page's *own* CSS (IBM Plex Sans / JetBrains Mono / Schibsted Grotesk, `--ground #f3f4f5`, `--accent #0a7189`) is the doc's styling, **not** a description of Codex. Do not mistake it for a spec.

## 7. Interactions

- **Expand/collapse**: transcript view `ctrl T` in the TUI = full detail level; "A desktop build of this is click-to-expand" (L652). Desktop summary rows expandable on click (L443, L653). Review-pane rows expand/collapse on click (L781).
- **Copy**: header menu copies working directory, session ID, deep link; **no documented per-message copy button** (L765).
- **Retry / edit / fork**: last message editable in place; earlier points via fork; hover button + context menu "Fork into New Worktree" (L750–751). `/fork` asks: Current checkout or New worktree.
- **Approve/decline**: on desktop `⏎` approves and `Esc` declines (L741). TUI options are numbered with letter accelerators — `(y)`, `(a)`, `(p)`, `(d)`, `(esc)` (L734).
- **Interrupt**: `esc` — the working line literally reads "esc to interrupt" (L610).
- **Find**: `⌘F` find in chat, `⌘G` / `⌘⇧G` next/previous match (L828).
- **Full shortcut table** at L824–835 (Chats, Composer, Layout, General). Layout: `⌘B` sidebar, `⌘J` bottom panel, `⌃\`` terminal, `⌘⌥B` review panel, `⌃⇧G` review tab.
- **Scroll-to-bottom / jump-to-latest / stick-to-bottom: not covered.** Neither is per-row hover affordance placement (listed as a gap, L845).

## 8. Ambiguities — questions an implementer must have answered

1. Bubble geometry: do user and assistant messages get different backgrounds/alignment, or is it a flat left-aligned stream? Max content width? (L844 says undocumented.)
2. Type scale and spacing rhythm — body size, mono size, row gap, indent width for `└` children?
3. Light/dark palette: what are the actual surface, rule and accent values? (Only semantic red/green/dim are given.)
4. Does brigadier show a "Worked for" separator at all, and what does a turn boundary look like when there is none (turn ≤ 60 s)? (L849 flags this as unknown even for Codex.)
5. How do commentary-phase messages differ visually from the final answer? (L852 — explicitly unknown.)
6. Thinking/reasoning: does brigadier follow the reference client (status-line only, never a row) or the desktop app (blinking "Thinking" label, no summaries) or the IDE extension (collapsed "thinking…" section)? The doc gives three different answers (L410–411).
7. Where does full reasoning text live if there is no `ctrl T` transcript view — a per-row expander, a side panel, or nowhere?
8. Is the transcript/full-detail level a separate view or per-row click-to-expand? Codex has both patterns.
9. Do we adopt the desktop's sentence summaries ("Edited 3 files, explored 2 files, 2 searches") or the TUI's live groups? They are different UIs; the doc documents the TUI precisely and the desktop only via REPORTED issues.
10. Output cap: keep 5 rows, or pick our own? Keep the `… +N lines` affordance wording?
11. Are approvals an **overlay** (as in the TUI, `bottom_pane/approval_overlay.rs`) or an inline card? brigadier's settled rule is a non-optimistic inline card — Codex's approval is a modal that pauses the timer. Which wins?
12. Does the timer pause on approval in brigadier, and is elapsed time even shown per turn?
13. Steer vs queue: does brigadier implement steering at all? Claude Code's control protocol may not accept mid-turn input the way `turn/steer` does — needs a protocol answer before any composer design.
14. Enter = steer, Tab = queue: keep that binding, or Enter = send/queue?
15. Diff rows: drawn at start before approval (Codex) vs brigadier's non-optimistic rule — is showing a diff before approval "optimistic"?
16. Does the file-change card get an Undo button, and what reverts it (git)?
17. Sub-agents: separate threads with their own sidebar rows and a Subagents panel, or inline nested rows in the parent thread?
18. Is there a context meter in the composer, and does it use Codex's 12,000-token baseline subtraction or brigadier's usage-window gauge? (Note brigadier's settled "usage windows, never dollars" vs Codex's header "usage indicator (credits, estimated cost)", L799 — direct conflict.)
19. Scroll behaviour: sticky-to-bottom, a jump-to-latest pill, scroll anchoring during streaming — completely uncovered.
20. Virtualisation / paging: `thread/turns/list` pages older turns; what does brigadier do with a 2,000-row thread, and does that fight the 295 ms paint budget?
21. Per-message hover actions: which ones, and where (L845 undocumented)?
22. Are compaction, review-mode banners, hooks and web-search rows in scope for v1 at all?
23. Newline-gated commit + adaptive reveal: do we port the exact constants (8 lines / 120 ms / 250 ms / 64 lines / 300 ms), or is that terminal-specific pacing that a DOM renderer should not copy?
24. Table hold-back during streaming — port or drop?
25. The 2 s shimmer on the working line: keep, and does it satisfy `prefers-reduced-motion`?
26. Do we adopt the four attention states and their priority order (needs input › blocked › ready › running) for brigadier's session list?
27. Mode toggle above the composer (Chat · Work): does brigadier have an equivalent, or is this Codex product surface we skip?
28. Does the doc's terminal ASCII (`›`, `•`, `└`, `⋮`) become literal glyphs in brigadier's DOM, or is it a stand-in for icons the desktop app actually uses? The doc never says which the desktop app renders.

## 9. Mapping risks — Codex-specific machinery that may not survive the port

- **The whole item catalog is `codex app-server`'s JSON-RPC shape**, not Claude Code's. Claude Code's stream is `tool_use`/`tool_result` content blocks; there is no `commandExecution` with a pre-parsed `commandActions[]`. **The exploration-merge rule (L646), the verb-tense flip and the read/list/search collapsing all depend on that server-side parse.** brigadier would have to classify Bash/Read/Glob/Grep tool calls itself — feasible (tool name ≈ action kind) but it is our inference, not the server's.
- **`phase: commentary | final_answer`** (L391) has no Claude Code equivalent. Distinguishing "interim commentary" from "the final answer" — which drives whether the Working line stays up (L394, L616) — needs a heuristic (last assistant message before `result`?), and heuristics flicker.
- **Reasoning**: Codex sends `summaryTextDelta` with `**bold** headers` designed to be harvested as status text (L410). Claude Code emits `thinking` blocks with no such header convention. The "latest reasoning header becomes the status line" trick may have nothing to harvest.
- **`turn/diff/updated`** (L297–298) — an aggregated per-turn unified diff, free on the wire. Claude Code has no such event; brigadier must compute it from git, and the doc already warns the two sources disagree even inside Codex (L461).
- **Approval decision vocabulary** (L734–738) is Codex's: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, `cancel`. Claude Code's `can_use_tool` reply has a narrower set. The "don't ask again for commands starting with `prefix`" option is an execpolicy amendment brigadier cannot offer without building the policy engine.
- **`item/permissions/requestApproval` and `mcpServer/elicitation/request`** (L736–737) — filesystem/network scope grants and a JSON-schema-driven form. No Claude Code counterpart today.
- **`item/tool/requestUserInput` / non-blocking `questions[]`** (L738, L395) — a whole non-blocking question channel. Claude Code has nothing like it; every permission is blocking.
- **Sub-agents as first-class threads** (`parentThreadId`, `agentThreadId`, agentsStates, L512–516). Claude Code subagents surface as a `Task` tool_use in the parent stream, not as a separate resumable thread with its own sidebar row and steer/stop controls. The Subagents panel is the biggest structural mismatch in the doc.
- **Steer** (`turn/steer` with `expectedTurnId`, L665) — mid-turn input injection with a race guard. Whether Claude Code's stdio control protocol supports this at all is unverified here; the doc does not claim it does.
- **Compaction**: Codex has a `contextCompaction` item + `thread/compacted` notification + `/compact` (L528–532). Claude Code's compaction surfaces differently; whether brigadier even wants a compaction row given "no accumulating session" is a product question, not a port question.
- **Fork / revert / side chat** (`thread/fork`, `thread/revert`, `ephemeral:true`, L750–760) presuppose server-side history rewriting. brigadier's session model is worktree-per-session; forking a Claude Code session is `--resume` plus a new worktree, which is a different cost and a different UX.
- **Goal mode / `ThreadGoal` with tokenBudget** (L716) — the doc says it maps to brigadier's pinned plan card, but the token-budget/time-used fields come from Codex's server. brigadier would have to compute them.
- **Cloud execution, Scheduled tasks, credits/cost indicator, personality, pets, Codex Micro** (L703, L711, L799, L811) are OpenAI product surfaces with no brigadier analogue — and the cost indicator directly contradicts brigadier's "usage windows, never dollars" rule.
- **The reference client is a terminal.** Its 5-line output cap, 1 MB live buffer, `ctrl T` transcript, 1-line-per-frame reveal and newline-gated commits are constraints of a TTY. Porting them literally into a DOM renderer is a choice, not a requirement — and the doc is explicit that the desktop app does something different at least for activity grouping (L443, L652–653).
- **Freshness**: every desktop claim is `REPORTED` from a GitHub issue, and L882 warns "The desktop app changes weekly, so re-check REPORTED items against your installed version." Anything in this digest tagged REPORTED is second-hand.

## See also

- `codex-thread-tokens.md` — the desktop app's actual measured pixels, colours, spacing and motion (this
  digest's §6/§8 gaps).
- `codex-ui-kit.md` — an independent component library's replica of the desktop app, and how it compares to
  assistant-ui.
- `codex-thread-row-mapping.md` — for each of the row kinds in §2 above, which component (assistant-ui or
  codex-ui-kit) to build from and what brigadier data already exists for it; it also answers most of this
  digest's §8 ambiguities with a concrete pick.
- `cli-steer-and-exit-codes.md` — answers ambiguity #13 (does brigadier implement steering at all?):
  measured against Claude Code's own stdio protocol, mid-turn input is steered into the running turn, not
  queued — there is no "queued" wire state to render.
- `thread-render-path-2026-09-10.md` — what brigadier's own thread code renders today, i.e. the baseline this
  digest's row taxonomy would be built on top of.
