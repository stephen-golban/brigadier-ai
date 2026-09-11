# Context meter and usage gauge — visual evidence, 2026-09-11

Two components that were complete, tested and imported by nothing are mounted and photographed
here. `SessionContext` was dropped by the composer redesign at `42c5144`; `getUsageWindows` never
had a consumer at all.

Every line below is **[M]** measured — produced by the run whose console output is
`observations.txt` in this directory — unless marked **[A]**.

## How these were produced

`npm run dev` on port 1421 (the same `src/` render path the packaged app ships), driven headless
with Playwright 1.61.1 / Chromium at 1440×1000, DPR 2. The fixture is the repo's own browser mock
(`src/mock.ts`, selected outside Tauri by `bridge.ts`) at `?rps=0&approvals=manual`. Nothing was
stubbed: the meter's number comes through `sessionApi.context` and the gauge's through a real
`usage-windows` signal drained by `feedStore`. The driver scripts are scratch, not in the tree;
they are the `openApp` helper from `../fixes/capture-open.mjs.txt` plus a screenshot pass.

Two query parameters were added to the fixture for these shots and are the only way to reach the
states below: `?context=<percent>` pins the context fill, `?usage=<percent>` seeds the five-hour
window. Without them both climb on their own as the demo session runs. **[M]**

## Index

| file | what it shows |
| --- | --- |
| `01-dock-full.png` | whole window: the gauges above the composer, below the transcript |
| `02-gauges.png` | the strip at rest — `Context 22%`, `5-hour 23%`, threshold tick on both tracks |
| `03-context-popover.png` | tokens, the threshold in tokens and percent, its source, the model |
| `04-usage-popover.png` | two bars, two countdowns, the 80% reserve stated in words |
| `05-near-threshold.png` | `?context=80` — bar amber, `compacts soon` beside the number |
| `06-near-threshold-full.png` | the same, in the whole window |
| `07-past-threshold.png` | `?context=90&usage=86` — both bars red, `compacting` and `past reserve` |
| `08-low-usage.png` | a near-empty five-hour window (`?usage=4`) |

## What the run recorded

- **Zero `pageerror`** across four page loads. **[M]**
- No currency anywhere: the strip's text and both popovers were regex-checked for `$`/`USD` and
  came back `false` in every state. **[M]**
- The threshold tick sits at `left: 38.625px` on a 46 px track — 84% of the way along, which is
  `167000 / 200000`, the ratio the CLI reported. The reserve tick sits at `36.8px`, 80%. **[M]**
- `<meter>` attributes carry the line rather than only the paint: `{value: 80, low: 76, high: 84}`
  for context, `{value: 71, low: 70, high: 80}` for the window. **[M]**

## What was not checked

- **A live CLI.** Every number here is the browser fixture's. The desktop path
  (`session_context` → `get_context_usage`) was not exercised; `autoCompactThreshold` reaching the
  UI unchanged is asserted from `src-tauri/src/conversation.rs` and the measured reply in
  `../../../research/compaction-and-long-sessions-2026-09-11.md` §A1, not observed end to end. **[A]**
- **Light theme.** `colorScheme: "light"` produced an identical dark strip, so the app does not
  follow `prefers-color-scheme` in this build; `08-low-usage.png` is therefore a dark shot and is
  not evidence about a light palette. **[M]**
- No burn, no `npm run tauri build`, no Rust gate: `cargo` was not run at all, and a sibling worker
  was editing `crates/**` throughout.

---

## Addendum, same day: the copy was wrong, and these two shots are the corrected one

`03-context-popover.png` above photographs copy that described a conversation that does not exist.
It read *"Compacting takes about ten seconds and summarises the conversation so far"*, under the
heading **Current context**. brigadier's interactive path does not accumulate: every user message
kills the running `claude` child and spawns a fresh one with no `--resume` and no provider
transcript, and the harness re-assembles a ≤ ~9,000-token brief from SQLite instead
(`docs/research/does-a-session-accumulate-2026-09-11.md` §0–§2, measured). The meter reads the live
child's window, so it covers **one response** and returns to its floor at the next message.

| file | what it shows |
| --- | --- |
| `09-context-popover-scoped.png` | the corrected popover: **This response**, the reset sentence, the drop line, and the threshold still on screen |
| `10-context-popover-scoped-full.png` | the same in the whole window, gauges in the dock |
| `observations-scoped-copy.txt` | the console output of the run that produced them |

Same method as the shots above: `npm run dev` on port **1420**, Chromium headless-shell
(playwright chromium-headless-shell v1228, Chrome 149.0.7827.55) at 1440×1000, DPR 2, dark, against
the repo's own browser mock at `?rps=0&approvals=manual&context=41`. **[M]**

What the run recorded, verbatim from `observations-scoped-copy.txt`:

- trigger accessible name `"This response: context 41% used, auto-compacts at 84%"` — it was
  `"Context 41% used, …"`, which read as a session-long figure to a screen reader. **[M]**
- the popover, in order: `This response` · `≈ 82,000 / 200,000 tokens` · *"Resets at your next
  message. brigadier sends every message to a fresh window, so this covers the response being
  written now — never the conversation."* · *"No drop seen yet. A figure that climbs across
  messages instead of dropping would mean conversation history had been wired back in."* ·
  *"Auto-compacts at 167,000 tokens (84%), from the model's default. Only one long response can
  reach that line; compacting takes about twelve seconds and summarises what this response has done
  so far."* · the model · the footer. **[M]**
- zero `pageerror`; no `$`/`USD` anywhere in the popover. **[M]**

## What was not checked, for these two shots

- **The drop line populated.** The fixture never decreases — `demoContextReading`
  (`src/mock.ts:393-410`) climbs with the session's row count or is pinned by `?context=`, and
  nothing in the mock resets it — so the shot can only show `No drop seen yet.` The populated
  string is covered by a unit test
  (`src/components/SessionContext.test.tsx`, "reports the last drop it saw"), **not** by a
  photograph. Making the fixture sawtooth belongs with WO-6 in
  `../../../research/compaction-and-long-sessions-2026-09-11.md` §7, which also wants a
  `session-compacted` event the mock does not emit.
- **A live CLI**, as above. The 167,000/200,000 pair is the fixture's, matching the measurement in
  `../../../research/compaction-and-long-sessions-2026-09-11.md` §A1; the desktop
  `session_context` → `get_context_usage` path was not exercised. The model name in the shot
  (`claude-sonnet-4-5`) is the mock's session row, not a resolved provider default.
- **No Rust gate, no burn, no `npm run tauri build`.** `npm test` (692 passed, exit 0) and
  `npx tsc --noEmit` (exit 0) were both re-run after the copy change; nothing else was.
