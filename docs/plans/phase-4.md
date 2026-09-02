# Phase 4 — build the vision

Read `CLAUDE.md` first (§1: research before any API decision; findings to `docs/research/<topic>.md`;
cite the file when you act). Then `docs/vision.md` (what we are building and why) and `docs/STATUS.md`
(what exists, what is broken, and the landmines). `docs/plans/ipc-contract.md` remains binding for
anything crossing webview ↔ Rust.

This plan replaces `phase-4-the-wall.md` and `next-session.md`, both written before the vision was
settled on 2026-09-02. The wall as those files described it — refusing the host's reads and writes
through hooks — is not what we are building; see `docs/vision.md` §8.

## Definition of done for the phase

A session started from the UI can take a goal, grill the owner, plan, dispatch work orders to
isolated worktrees, gate on a real exit code, commit per phase, and survive the owner going to bed.

## Wave 0 — safety and defects. Nothing else starts until these land.

**W0-A — the `.gitattributes` hole.** Owns `crates/core/src/worktree.rs`.
`git worktree add` executes the repository's own filter drivers — arbitrary shell from a repo an
agent may have written to earlier. We have no mitigation of any kind. Research what Claude Code does
(it neutralizes this) before choosing ours. Highest-priority item in the repo.

**W0-B — the worktree defects.** Owns `crates/core/src/worktree.rs`, `crates/supervisor/src/worktree.rs`.
Defects 1–5 and 7 in `docs/STATUS.md` §5: absent `git worktree repair`; unreachable `remove -f -f`
after a crashed add; `removed: true` lying in the moved-project state; unforced remove ignoring
commits; safety decisions reading `sessions.branch` instead of `git worktree list --porcelain`; a
project root that is itself a linked worktree; submodules. `docs/research/worktree-cleanup.md` has
the measurements and a "Hard rules" section.

**W0-C — `seedRows`.** Owns `src/feedStore.ts`.
`src/feedStore.ts:545` discards the 500-row seed whenever a live batch wins the race. While there,
take the first-paint read down to 48 rows (`docs/research/perceived-performance.md`).

## Wave 1 — the loop. This is the product.

**W1-A — the plan and progress store.** Owns `crates/store/src/`.
The single highest-stakes component in the design: under `docs/vision.md` §3 nothing else remembers
anything. Phases, definitions of done, verify commands, per-phase state, what was skipped when the
owner said "just go". A store that drifts out of true produces a thread that is confidently wrong for
hours.

**W1-B — the orchestration loop.** Owns `crates/supervisor/src/`.
Lead call → action → dispatch work orders → collect reports → gate on the verify command's real exit
code → commit → next phase. One fresh child per work order, one worktree each, disjoint file
ownership. The red-gate ladder from `docs/vision.md` §5: fresh worker, then fusion, then stop.

**W1-C — the free recon brief.** Owns `crates/core/src/brief/`.
~1,500 tokens assembled from git in under 100 ms: file tree, manifests, test command, framework,
recent log. **No index** — `docs/research/codebase-index.md`. Content-address with git blob OIDs;
mtime keying misses on 100% of files in a fresh worktree.

## Wave 2 — the surfaces

**W2-A — grill and research dispatch.** Uncertainty splits two ways, both concurrent; "just go" is
always one click and is recorded.

**W2-B — the plan card and thread.** Owns `src/`. Thread-primary, plan pinned above it, sidebar with
all projects and nested sessions. Optimistic on session start, turn send and delete — **never on
approvals**. `docs/vision.md` §9.

**W2-C — the gauge and the reserve.** `rate_limit_event.unifiedWindows` is free on the stream. Two
bars, two countdowns, the owner's reserve line drawn on them. Park below the reserve.

**W2-D — model routing.** Role-based, with non-judgement work downshifting as the window fills, and
one visible per-session tier.

## Wave 3 — autonomy

**W3-A — worker pre-authorization.** The Bash classifier already built moves from "host may not read"
to "safe inside this worktree vs reaches outside it". Set membership is table data
(`crates/core/src/wall/tables.rs`), so this should be a data edit. A queued approval parks **one work
order**, never the run.

**W3-B — cleanup.** Snapshot-then-remove: commit uncommitted work to a ref before deleting anything.
Auto-remove only when `rev-list --count base..branch == 0`. Retention policy for raw NDJSON and
provider transcripts — the transcripts are the only thing `--resume` reads and must never be
auto-deleted.

**W3-C — cold start.** Static shell in `index.html` plus `app.windows[].backgroundColor`; `spawn`
instead of `block_on` in `setup`. Converts ~190 ms of white into the app's own frame.

## Wave 4 — the frontend, rebuilt on Jan's stack

Owner verdict, 2026-09-02, on the current UI: **"looks nothing like ChatGPT, more like a year 1999
app."** The restyle got the palette right and the building wrong. A measured palette is colour; it
says nothing about layout, type scale, density, radii or motion, which is most of what makes an
interface look current. `docs/research/jan.md` is the source: *take the shell, the components and
the state shape; do not take the thread renderer.*

Sizing, measured: seven components, ~1,787 lines. `feedStore.ts`, `wire.ts`, `bridge.ts`, `fps.ts`
and `mock.ts` (2,115 lines) are styling-agnostic and do not move. **Zero literal hex exists in any
`.tsx`** — every colour already resolves through one of 56 tokens in `src/index.css`, so the palette
conversion is a single-file change.

**W4-A — a front-end test runner, FIRST.** There is none today (`docs/vision.md` §12). Vitest plus
Testing Library, since Vite is already the bundler. Migrating an untested UI is how the Resume
button, the approvals dock and the cleanup flow stop working silently.

**Test behaviour that must survive the rewrite, never the markup that will not.** A test written
against current DOM structure gets deleted along with the component it characterises and buys
nothing. *A test that survives the migration proves the migration; a test that dies with the
component proves only that the old component existed.* So assert on **text and roles**, never on
class names or structure:

- given a `WorktreeCleanup` shape, which sentence and which buttons appear. The six refusal reasons
  are a table, and that table is a contract, not a layout — `docs/plans/ipc-contract.md`.
- given a wire batch, what `feedStore` holds and in what order.
- which callback fires on which action, and that **approvals are never optimistic**.

**Carry the paint instrumentation with it.** B4, B6 and B7 in `docs/vision.md` §9 are unmeasured
guesses and stay that way until the app can time its own paints. That is frontend measurement work
and belongs in this order, not in a later one. B2, B3, B5 and B8 are gates today; B1 becomes one
when W3-C's static shell lands.

**Start with `feedStore.ts`** — the cheapest win in the wave. It is styling-agnostic (measured: it
does not move), so its tests survive the rewrite untouched and can be written before anyone touches
a component. It also holds the only front-end logic with measured behaviour behind it: the rAF
drain, the `ROW_CAP` trim, and the seed merge.

Why this is urgent rather than tidy: the `seedRows` merge was proven across nine scenarios by a
throwaway script, and the six refusal notes were proven through `react-dom/server` on synthesized
values. Both were reported honestly. **Both scripts are gone, so both results are now unverifiable.**
That is the base the rewrite would otherwise stand on.

**W4-B — tokens.** The 56 measured custom properties become Tailwind 4 `@theme` tokens in oklch.
Hex→oklch is lossless, but **every AA contrast pair is re-checked after conversion, not assumed** —
`src/index.css` records the ratios that currently pass. Take Jan's `ThemeProvider.tsx` (79 lines)
whole, including its Linux portal fix, even though we ship dark-only: Linux is the declared second
platform and the three-state mechanism costs nothing to carry.

**W4-C — the shell.** Sidebar with projects and nested sessions, run dots on collapsed rows, the
window gauge pinned beneath. Jan's `NavCowork.tsx` per-row memoization is the pattern; its comment
at `:51` is worth reading before writing ours.

**W4-D — the surfaces Jan already has.** `CoworkAskCard` → our approvals dock (the audit calls it
"the closest prior art in the repo to brigadier's approvals"); `CoworkTodoPanel` → the pinned plan
card; `CoworkDiffPanel` → diff review. Read them before writing ours, port rather than paste.

**W4-E — settings.** Global with per-project overrides (owner's choice). Layout from the pen.dev
board's settings architecture — 98px left nav, 271px content pane, rows split by rules, 19x11
toggles, destructive in red — converted to our dark tokens. **Do not copy ChatGPT's settings
surface area**: that design has ~70 nav rows across 9 tabs; we have eight settings.

**HARD CONSTRAINTS on this wave:**
- **`src/components/Feed.tsx` does not move.** Ours is virtualized and measured at 60 Hz over 1,513
  samples. Jan renders every message with no virtualiser and the audit calls its thread renderer
  *disqualified for brigadier*. Taking it would be a measured regression.
- **The measured palette survives.** It is the only design artifact sampled from the live app.
- **Dark only.** A light scheme has to be designed, not measured, and the reference has none.
- Jan is Apache-2.0 and copying is legally open, but **do not ship Jan's trademarks or marks**.
- This wave touches all of `src/**`. It cannot run concurrently with any other frontend order.
- `tauri.conf.json` claims `"targets": "all"`, which is false under macOS-now / Linux-next /
  Windows-later-or-never. It is a shipping-configuration change and needs the owner's word.

## Research owed before the work that depends on it

1. **Fan-out vs direct children, head to head.** Same work order, both shapes, on Haiku, comparing
   total tokens and wall clock. `docs/vision.md` §6 asserts direct children win and says so.
   Blocks nothing, but the vision rests on it.
2. **Can a child's tool set be constrained at `initialize`?** Would make the wall a capability rather
   than a refusal. The proven fallback is `PreToolUse` with `matcher: ""` branching on `tool_name`,
   which the adapter already registers (`crates/core/src/claude/adapter.rs:326`).
3. **Spawn-cost mitigation** — warm pool vs multi-turn children. `system/init` fires per *turn*, so a
   process can serve several. Neither built nor measured.
4. **Does `codex app-server` expose anything like `rate_limit_event`?** Cross-vendor failover depends
   on it. Deferred with Codex.

## Not in this phase

Codex or any second provider. Forking a thread. Signing or notarization. Remote or hosted anything.
