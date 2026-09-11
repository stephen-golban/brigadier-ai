# `src/components/thread/` — vendored kit provenance

These files are a **manual, scripted copy**, not a dependency — the same shape as
`src/components/ui/UPSTREAM.md` uses for its own vendored set. Source: the MIT-licensed
`codex-ui-kit` (`github.com/JaminZhou/codex-ui-kit`), pinned commit
`9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d`. Licence text: `licenses/codex-ui-kit-MIT.txt`.
Full notice, copyright and the non-affiliation statement: `THIRD_PARTY_NOTICES.md`'s
"codex-ui-kit — MIT" section. There is no update path, no changelog and no semver — to
refresh a file, re-clone at a newer SHA and re-run `scripts/vendor-codex-ui-kit.mjs`.

Class prefix and custom-property prefix are renamed throughout: the kit's own prefix →
`thread-` / `--thread-`.

## Vendoring recipe

`scripts/vendor-codex-ui-kit.mjs --components <names> --dest <dir> --var-prefix --thread- --class-prefix thread- --source <clone>`
(no `--follow-imports` — see "Why not `--follow-imports`" below), against
`AgentMessage, TurnDuration, ActivityTimeline, AgentActivity, StatusIndicator,
CommandExecution, McpToolCallGroup, ToolCallCard, SearchActivity, SubagentActivity,
ApprovalRequest, Notices, ThreadState` (not `FileChange` — see `FileChangeGroup.tsx`
below). The script's own report: 13 files copied, 191 `codex-ui-*` tokens seen across
them, 431 CSS rules kept out of 3,056, 80,177 bytes of extracted component CSS before
this file's own hand-pruning (see "Byte accounting" in the phase-3R report). `types.ts`
and `internal/surfaceBlocked.ts` were hand-copied (the script's `--components` path
resolution has no clean way to name a file directly under `src/`, only under
`src/components/`) and get the same prefix rename by hand where they use it.

## Why not `--follow-imports`

A first run with `--follow-imports` pulled in `InteractivePrimitives.tsx` (1,312 lines) —
`SubagentActivity.tsx`'s now-deleted `SubagentSummary` used its `Menu`/`MenuItem` for an
avatar-overflow popover that this app never needed even before the avatar deletion below.
Every other local import the 13 files need (`../types`, sibling components) already ships
in the same allow-list or is a small standalone helper (`surfaceBlocked.ts`, 35 lines, no
further local imports) copied by hand instead. No file under this directory imports
`Dialog.tsx` or `InteractivePrimitives.tsx`.

## Files

| File | Source | Deviations |
| --- | --- | --- |
| `AgentMessage.tsx` | kit `src/components/AgentMessage.tsx` | import paths only (`../types.js` → `./types`) |
| `TurnDuration.tsx` | kit `src/components/TurnDuration.tsx` | import paths only |
| `ActivityTimeline.tsx` | kit `src/components/ActivityTimeline.tsx` | import paths only |
| `AgentActivity.tsx` | kit `src/components/AgentActivity.tsx` | import paths; inline disclosure-chevron `<svg>` → `ChevronRight` from `src/icons` |
| `StatusIndicator.tsx` | kit `src/components/StatusIndicator.tsx` | import paths only |
| `CommandExecution.tsx` | kit `src/components/CommandExecution.tsx` | import paths; inline copy-icon `<svg>` → `Copy`, inline terminal-fallback `<svg>` → `Terminal`, both from `src/icons` |
| `McpToolCallGroup.tsx` | kit `src/components/McpToolCallGroup.tsx` | import paths; inline `McpToolIcon` `<svg>` → `Nodes` from `src/icons` (closest existing glyph to the kit's interlocking-rings connect mark; not a literal match) |
| `ToolCallCard.tsx` | kit `src/components/ToolCallCard.tsx` | import paths; inline wrench `<svg>` → `Tools`, inline `<>`/`</>` raw-output toggle `<svg>` → `Code`, both from `src/icons` |
| `SearchActivity.tsx` | kit `src/components/SearchActivity.tsx` | import paths; inline globe `<svg>` (web) → `Globe`, inline magnifier `<svg>` (code) → `Search` (aliased `SearchGlyph` to avoid shadowing the component's own `search` vocabulary), both from `src/icons` |
| `ApprovalRequest.tsx` | kit `src/components/ApprovalRequest.tsx` | see "ApprovalRequest modifications" below |
| `Notices.tsx` | kit `src/components/Notices.tsx` | import paths; inline `<svg>` for warning tone → `Warning`, error tone → `ExclamationMarkCircle`, the dismiss `×` → `X`, the reconnecting spinner → `Loop`, all from `src/icons`. The `info` tone and the plain-circle `neutral`/default tone keep their inline `<svg>` — `src/icons/` has no bare info-circle or plain-dot glyph (see phase-3R report) |
| `ThreadState.tsx` | kit `src/components/ThreadState.tsx` | import paths only |
| `types.ts` | kit `src/types.ts` | hand-copied (see recipe note above); `ApprovalDecision` widened, see below |
| `surfaceBlocked.ts` | kit `src/internal/surfaceBlocked.ts` | hand-copied; `surfaceBlockedEventName` string `codex-ui:surface-blocked` → `thread:surface-blocked` |
| `FileChangeGroup.tsx` | kit `src/components/FileChange.tsx` | **hand-extracted**, not script-vendored — see below |
| `SubagentActivity.tsx` | kit `src/components/SubagentActivity.tsx` | **hand-pruned**, avatar-free — see below |
| `thread.css` | kit `src/styles.css` (sliced) + `src/tokens.css` (aliased, not copied whole) | see "thread.css" below |

## `FileChangeGroup.tsx` — hand-extracted, not script-vendored

Plan §5 phase 3R step 1 explicitly excludes `FileChange` from the script run and step 2
calls for a hand extraction of only `FileChangeGroup` + `FileChangeStats`. Running the
script on `FileChange.tsx` alone (no `--follow-imports`, for its CSS-slicing only, output
discarded) confirmed the reason: the full file pulls `Dialog.tsx` and — through
`FileReviewWorkspace` — `InteractivePrimitives.tsx`, for `FileReview`,
`FileReviewWorkspace` (491 lines) and `FileRevertErrorDialog`, none of which this app
uses (brigadier has no per-file `diffText` to put in an expanded review body). Not
brought in: `FileChange` (the single-file variant), `FileDiff`, `fileDiffToText`,
`FileReviewNotice`, `FileReview`, `FileReviewWorkspace`, `FileRevertErrorDialog`, and the
`activeLabels`/`appliedLabels`/`stoppedLabels` maps `FileChangeGroup` never reads (it
computes its own inline `statusLabel`). Its CSS was extracted the same way — kept only
`.thread-file-change-group*` and `.thread-file-change__stats*` rules (the latter shared
with the single-file variant) — dropping the `.thread-file-review-workspace__*` compound
selectors that reference `.thread-file-change__stats` but target a component that is
never rendered.

## `SubagentActivity.tsx` — hand-pruned, avatar-free (D3/D19)

The kit's file (836 lines) exports eight things; this app keeps two:
`SubagentActivity` and `SubagentActivityGroup` — the inline chip rows the target row
catalogue's row 11 calls for. Deleted, along with everything that existed only to feed
them:

- **`SubagentAvatar`** and its five `../assets/subagents/*.svg?raw` imports. Those SVGs
  were captured from the rendered Codex Desktop app; the kit's own
  `src/assets/subagents/README.md` states they remain OpenAI's copyright and are not
  relicensed under the kit's MIT licence (`THIRD_PARTY_NOTICES.md`'s "Excluded from the
  vendoring" note). `vendor-codex-ui-kit.mjs` refuses `src/assets/**` by default; this
  file compiling at all required removing every reference to `SubagentAvatar`, which is
  the intended failure the script is designed to force, not a bug routed around.
  brigadier ships no replacement artwork yet — both `SubagentActivity` and
  `SubagentActivityGroup` now render their chip content as a text label only.
- **`SubagentItem`** (the richer shape `SubagentSummary`/`SubagentPanel` used —
  `additions`, `dateTime`, `lastMessage`, `model`, `presentation`, `role`,
  `sortTimestampMs`, `timestamp` — none of which `SubagentActivityItem` needs) and
  `sortForSummary`, its only consumer.
- **`SubagentSummary`**, `SummaryAvatarGroup` and `DiffStats` — the avatar-strip-with-
  overflow-menu presentation `SubagentActivityGroup` does not use. This is what pulled
  in `InteractivePrimitives.tsx`'s `Menu`/`MenuItem` (see "Why not `--follow-imports`"
  above); deleting it removed that dependency too.
- **`SubagentPanel`, `SubagentPanelSection`, `SubagentPanelIcon`,
  `SubagentTranscriptHeader`** — the kit's own subagent side panel. Plan §3 row 11 is
  explicit that brigadier keeps its own `SubagentsPanel.tsx` (5 existing tests) instead.

## `ApprovalRequest.tsx` modifications

Plan §3 row 12 requires the vendored `ApprovalRequest` to express two notions the kit's
own prop surface cannot: an approval that is **open but unanswerable** (the run that
parked it is gone) and a way to **dismiss** it. Both are brigadier additions, applied
directly to the vendored file rather than deferred to a later phase, since neither needs
anything outside this file to compile:

- `types.ts`'s `ApprovalDecision` gains a fourth member, `"expired"`, alongside the
  kit's `"pending" | "approved" | "rejected"`.
- `ApprovalRequestProps` gains `onDismiss?: () => void` and `dismissLabel?: ReactNode`
  (default `"Dismiss"`). When `decision === "expired"` and `onDismiss` is supplied, the
  card renders a single Dismiss button in place of the Approve/Reject pair — `disabled:
  true` alone is not sufficient here, since a disabled Approve/Deny pair is a card the
  operator cannot clear. `defaultDecisionLabels` gains a matching `expired: "Expired"`
  entry so `decisionLabel`'s default still resolves for every `ApprovalDecision`.
- `Approvals.tsx`'s own two-notion split (`approval.expired: boolean` vs. a resolved
  history row's `decision === null`) is untouched by this — see the plan §3 row 12 and
  §1.4 for why they stay separate. Wiring `onDismiss` to brigadier's approval state
  machine, and `ApprovalResolution`'s own separate markup for the resolved-with-no-
  decision case, is phase 4's job; this phase only makes the prop surface exist.
- Two leftover `data-codex-approval-surface` / `[data-codex-ui]` references (a DOM
  marker attribute and a portal-target selector, neither part of the renamed CSS
  prefix) are renamed/cleaned by hand: the marker attribute → `data-thread-approval-
  surface`, and the portal-target lookup drops the `[data-codex-ui]` branch (nothing in
  this app stamps that attribute — see "thread.css" below) and now searches only
  `[data-theme]`, falling back to `document.body` as before.

## `thread.css`

Built from two extractions, not a straight copy of the kit's `styles.css` +
`tokens.css`:

1. **Component CSS**: the script's slice of the 13 vendored files (80,177 B) plus the
   hand-sliced `FileChangeGroup`/`FileChangeStats` rules (3,100 B), then **re-sliced a
   second time** against the exact class set the final, hand-pruned TSX (post
   `SubagentActivity.tsx` trim) actually references — dropping the now-dead
   `.thread-subagent-avatar*`, `.thread-subagent-summary*` and `.thread-subagent-panel*`
   rules the first slice kept because they were still referenced by the *original*,
   unpruned file. Final: 385 rules kept, 71,356 B.
2. **Tokens**: NOT the kit's `tokens.css` copied whole (~25.8 KB, ~250 properties, most
   unused by this app's 13 components). Instead, every `--thread-*` custom property
   actually referenced by the kept CSS (a `var(--thread-…)` scan) is declared once, on
   bare `:root`, either aliased onto brigadier's existing `--color-*`/`--radius-*` layer
   (`src/index.css`) or, where nothing in that layer matches, as a literal — collapsed
   to the single dark palette this app ships (no `[data-theme]` fork, no light branch,
   no `@media (prefers-color-scheme: dark)` duplicate). The **token-scoping deviation**
   (dropping the kit's `:root, [data-codex-ui]`-style attribute scoping entirely) and
   the **alias-vs-literal accounting** are both explained in `thread.css`'s own header
   comment and the phase-3R report — see those for the full reasoning and the named
   exceptions (diff green/red + tints, the approval card surface, the file-change card
   body, the thread geometry block).

D11 calls for stripping the CSS property some Codex UI surfaces use for a superellipse
(squircle) corner treatment: the source `styles.css` contains zero occurrences of it at
this pinned commit — confirmed by grepping the clone before extraction. Nothing to
strip.

## Phase 4 modifications (2026-09-11)

Wiring the kit up (plan §5 phase 4) needed five further brigadier deviations. All of them are
in the vendored files themselves rather than in a wrapper, because each is a prop the kit does
not expose or a render decision the kit makes for a component tree brigadier does not have.

| File | Deviation | Why |
| --- | --- | --- |
| `AgentActivity.tsx` | A **closed disclosure renders no body** (`{resolvedOpen ? children : null}`, all three disclosure modes). Upstream keeps the subtree mounted behind `hidden`. | A brigadier transcript is up to 600 rows and every activity row's body is a tool result, a nested trace and possibly an approval card. Upstream's behaviour mounts all of it at all times — the cost the Radix `CollapsibleContent` this replaced did not pay, on a thread that already misses its frame gate (plan §6 landmine 7). `hasBody` still decides whether a toggle exists, so the control and its `aria-expanded` are unchanged. |
| `CommandExecution.tsx` | `disclosureMode` / `disclosureIndicator` forwarded to `AgentActivity`. | The kit hard-codes the `details` disclosure. brigadier needs a real `<button aria-expanded>`: focus indicators are off app-wide (landmine 15), so a `<summary>` with no announced role is an invisible control (landmine 17). |
| `SearchActivity.tsx` | Same two props, plus a `children` prop rendered after the entries list. | Same reason for the disclosure; `children` because the kit's only body is its `entries` list and brigadier has no entries for a `Grep` — it has the tool result. |
| `FileChangeGroup.tsx` | `FileChangeStats` exported and given a props spread. | Plan §3 row 8's per-edit `+A -D` on an activity row, drawn `data-variant="agent-activity"` so they stay colourless until the row is hovered. The kit keeps the component file-private. |
| `thread.css` | User-bubble radius 22px (was `var(--radius-xl)`), max-width 70% (was 77%), padding 10x16 (was 8x12). Plus a brigadier-additions block at the end of the file for the `data-variant="agent-activity"` diff-stat hover. | `docs/research/codex-thread-tokens.md` §3.1 is the measured source and outranks the kit's own defaults, which are a second-hand replica. |

`ApprovalRequest.tsx` needed no further change: phase 3R's `"expired"` decision value and
`onDismiss`/`dismissLabel` pair are what `src/components/Approvals.tsx` now drives, and the
kit's global Enter/Escape handler was audited rather than modified — see that file's comment.

## Visual-defect fixes (2026-09-11)

Found by running the application and looking at it; evidence in
`docs/performance/2026-09-11-thread-shots/fixes/`.

| File | Deviation | Why |
| --- | --- | --- |
| `ThreadState.tsx` | `ThreadLoadingState`'s default labels: `"Reconnecting to ChatGPT…"` → `"Reconnecting…"`, `"Loading chat…"` → `"Loading conversation…"`. | **This product must never display the vendor's brand text.** The string shipped in the bundle even though the component has no mount site. |
| `ApprovalRequest.tsx` | The inline focus-exemption selector in the global hotkey handler is now the exported `approvalHotkeyExemptSelector` from the new `approvalKeys.ts`. Same string, one definition. | The peek sidebar installs its own document-level Escape handler, and one keystroke both denied an approval and closed the sidebar. Both handlers now read one predicate (`approvalOwnsKey`), so the pending approval wins while it is open and the sidebar's Escape is otherwise untouched. Ordering between two `document` listeners is mount order, so `event.defaultPrevented` is not a usable arbiter — see that file's comment. |
| `CommandExecution.tsx` | The default footer reads its outcome off `status`, not off `exitCode`. | `exit_code` is `Some(0)` on success, `Some(N)` on failure and `None` when nothing could be parsed, and **`None` does not mean success** (`src/wire.ts`, `crates/core/src/event.rs`, commit `1709a99`). The kit's `exitCode === 0 ? "Success" : "Exit code " + (exitCode ?? "unknown")` printed **"Exit code unknown"** on every command with no parsed code. |
| `thread.css` | `.thread-activity-timeline__toggle:hover` no longer sets a background. | `docs/research/codex-thread-tokens.md` §5.3 and plan §3 row 5: hover is **text-only**, 60% → 100% over the hairline. The measurement outranks the kit's own default, which is a second-hand replica. |
| `thread.css` | New: `.thread-command-execution__footer[data-status="failed"]` is `--thread-text-error` with a dot marker. | Plan §3 row 7, "Non-zero exit → red". Keyed off `is_error && !interrupted`, never off the exit code, so an operator **denial** is never painted as a crash. |
| `thread.css` | New: `.thread-approval-request__body` gets `padding-inline: 1rem`. | The kit gives the `children` slot no inline padding — upstream only ever passes it self-padding previews — so brigadier's body ran flush to the card edge and the suggestion checkboxes sat outside it. |
| `thread.css` | New: approval body wrapping, `.approval-subject`, `.suggestions` layout, and a visible border on the suggestion checkboxes. | Plan §3 row 12. A `<pre>`'s inherited `white-space: pre` pushed the tool input under the card's right edge (measured `scrollWidth` 750 vs `clientWidth` 736). The checkbox border is the app-wide `--input` `#2a2a2a`, invisible on this card's `rgb(45,45,45)` surface, and the row's label is now a scope sentence rather than the word "apply" — so the control is the only thing saying it is a toggle. Scoped to the card, not a retint of every checkbox in the app. |
