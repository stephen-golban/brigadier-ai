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

## Wave 0 — safety and defects. **Landed; the gate Waves 1-4 were held behind is passed.**

All three items are fixed and committed. The reasoning below is kept because it is why each
fix has the shape it has, and a later change that ignores it will reintroduce the defect.

**W0-A — the `.gitattributes` hole. Fixed at `5d71793`.** Owned `crates/core/src/worktree.rs`.
`git worktree add` executes the repository's own filter drivers — arbitrary shell from a repo an
agent may have written to earlier. It was the highest-priority item in the repo, and there was no
mitigation of any kind. `filter_neutralising_env` now enumerates the *effective* filter drivers and
blanks `smudge`/`clean`/`process`/`required` per driver, and disables `core.fsmonitor`, through
`GIT_CONFIG_*` on `add`, `repair`, `remove` and `dirty_count`
(`crates/core/src/worktree.rs:185,220,318,437,473,720`). The fourth key, `required`, is load-bearing
and not redundant — `docs/STATUS.md` §5 item 6 carries the measured reason.
`docs/research/gitattributes.md`. **Still open beside it:** `.git/hooks/post-checkout` runs at
`git worktree add` and is deliberately not neutralised — a policy call, `docs/vision.md` §12.6.

**W0-B — the worktree defects. All six fixed at `5fc0581`.** Owned `crates/core/src/worktree.rs`,
`crates/supervisor/src/worktree.rs`. Defects 1–5 and 7 in `docs/STATUS.md` §5: absent
`git worktree repair`; unreachable `remove -f -f` after a crashed add; `removed: true` lying in
the moved-project state; unforced remove ignoring commits; safety decisions reading
`sessions.branch` instead of `git worktree list --porcelain`; a project root that is itself a
linked worktree; submodules. `docs/research/worktree-cleanup.md` has
the measurements and a "Hard rules" section.

**W0-C — `seedRows`. Both halves fixed at `53c3491`.** Owned `src/feedStore.ts`.
`src/feedStore.ts` discarded the 500-row seed whenever a live batch won the race; it is now a
two-pointer merge keyed on the envelope `seq`, and pinned by tests at `ad5a4a7`. The first-paint
read did come down with it: `const TAIL_ROWS = 48` (`src/App.tsx:48`), 7,694 B on the wire against
80,241 B for 500 (`docs/research/perceived-performance.md`, `feed-rendering.md`).

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

**W3-A — worker pre-authorization.** The Bash classifier is built and committed (`21d2375`,
`crates/core/src/wall/`); it moves from "host may not read" to "safe inside this worktree vs
reaches outside it". Set membership is table data (`crates/core/src/wall/tables.rs`), so this
should be a data edit. A queued approval parks **one work
order**, never the run.

**W3-B — cleanup.** Snapshot-then-remove: commit uncommitted work to a ref before deleting anything.
Auto-remove only when `rev-list --count base..branch == 0`. Retention policy for raw NDJSON and
provider transcripts — the transcripts are the only thing `--resume` reads and must never be
auto-deleted.

**W3-C — cold start. Unstarted, and now the largest measured miss in the app.** Static shell in
`index.html` plus `app.windows[].backgroundColor`; `spawn` instead of `block_on` in `setup`.
**[measured]** the white lasts **287–295 ms p50**, n=19, not the ~190 ms this line used to estimate,
and B1's budget is ≤ 200 ms — a **~90 ms** gap (`docs/research/perceived-performance.md` §1.4).
About 100 ms of it sits in the `tauri://localhost` scheme handler and brotli inflate that the
original estimate never included (**[asserted]**, by elimination), so a static shell alone may not
close it; measure after, do not assume.

## Wave 4 — the frontend, rebuilt on Jan's stack

Owner verdict, 2026-09-02, on the current UI: **"looks nothing like ChatGPT, more like a year 1999
app."** The restyle got the palette right and the building wrong. A measured palette is colour; it
says nothing about layout, type scale, density, radii or motion, which is most of what makes an
interface look current. `docs/research/jan.md` is the source: *take the shell, the components and
the state shape; do not take the thread renderer.*

Sizing, measured: seven components, ~1,787 lines. `feedStore.ts`, `wire.ts`, `bridge.ts`, `fps.ts`
and `mock.ts` (2,115 lines) are styling-agnostic and do not move. **Zero literal hex exists in any
`.tsx`** — every colour resolved through one of the **18 colour tokens** among the **28** custom
properties in `src/index.css`'s `:root` (measured, `docs/research/frontend-stack.md` §2.6; the
earlier "56" counted every declaration in the file, not the token set), so the palette conversion
was a single-file change. Done at `3e5c3fd`: those 18 now live in `@theme static` as `--color-*`.

**W4-A — a front-end test runner, FIRST. The runner landed at `ad5a4a7`.** Vitest, jsdom and
Testing Library, since Vite is already the bundler; `npm test` runs **66** tests in three files at
`3e5c3fd`. **No component that draws anything is covered** — the one component under test,
`src/providers/ThemeProvider.tsx`, is not mounted — so migrating the UI can still make the Resume
button, the approvals dock and the cleanup flow stop working silently. That half is unstarted and
belongs to W4-C and W4-D.

**Test behaviour that must survive the rewrite, never the markup that will not.** A test written
against current DOM structure gets deleted along with the component it characterises and buys
nothing. *A test that survives the migration proves the migration; a test that dies with the
component proves only that the old component existed.* So assert on **text and roles**, never on
class names or structure:

- given a `WorktreeCleanup` shape, which sentence and which buttons appear. The six refusal reasons
  are a table, and that table is a contract, not a layout — `docs/plans/ipc-contract.md`.
- given a wire batch, what `feedStore` holds and in what order.
- which callback fires on which action, and that **approvals are never optimistic**.

**Carry the paint instrumentation with it. The instrument landed at `1c8b6f6` and has been run for
both halves.** Paints first, n=19 across three arms (`docs/research/perceived-performance.md`
§1.4): **B1** was observed end to end and **misses its budget by ~90 ms**, **B2** replicated, and
**B3**'s 314 ms single sample was superseded by 291.3 p50, migrations turning out to cost nothing
measurable. Then interactions, at `a0901e5`: **B4** is a number — p50 32.5 ms, range 22–144, n=14
(§2.7) — with the finding that it is **capped rather than fast**, because `TAIL_ROWS = 48` leaves it
no slow case; the cost it was written to catch lives in B6. **B6 and B7 are still guesses and must
still read as guesses**, now for the sharper reason that the instrument is built and proven and
those two paths simply have no call site — W4-D owes them. B2, B3, B5 and B8 are gates today; B1
becomes one when W3-C's static shell lands, and it brings a measured starting line with it.

**Started with `feedStore.ts`, done at `ad5a4a7`** — the cheapest win in the wave. It is
styling-agnostic (measured: it does not move), so its tests survive the rewrite untouched and were
written before anyone touched a component. It also holds the only front-end logic with measured
behaviour behind it: the rAF drain, the `ROW_CAP` trim, and the seed merge.

Why this was urgent rather than tidy: the `seedRows` merge was proven across nine scenarios by a
throwaway script, and the six refusal notes were proven through `react-dom/server` on synthesized
values. Both were reported honestly, and **both scripts are gone.** `seedRows` is now pinned by the
`ad5a4a7` tests; **the six refusal notes are still unverifiable**, and that is the base the rest of
the rewrite would otherwise stand on.

**W4-B — tokens. Landed at `3e5c3fd`.** The 18 colour tokens among the 28 custom properties
(`docs/research/frontend-stack.md` §2.6) are now Tailwind 4 `@theme static` tokens in oklch,
namespaced `--color-*`. Hex→oklch was lossless in practice: 18 of 18 round-trip bit-exact. Every AA
pair was re-checked rather than assumed, which is what caught the one failure —
`--color-text-muted-side` is **4.456:1** on `--color-sidebar-bg`, below AA, colour deliberately
unchanged and now an owner decision (`docs/STATUS.md` §5, `docs/research/oklch-tokens.md` §4).
Jan's `ThemeProvider.tsx` was taken whole, including its Linux portal fix, and is tested (15 tests)
but **not yet mounted** — W4-C mounts it.

**W4-C — the shell. Landed at `a0901e5`.** Sidebar with projects and nested sessions, run dots on
collapsed rows, hand-built on the tokens. It mounted `ThemeProvider` (`src/main.tsx:22`) and added
the repo's first `beginInteraction` caller, which is what turned **B4** into a number. It also
turned up **seven AA failures** on grounds no token had ever been measured against
(`docs/STATUS.md`, landmine list). **The window gauge pinned beneath is not built and is not this
order's** — it is W2-C's, and it is not buildable until `rate_limit_event` reaches the front end.

**W4-D — the surfaces Jan already has. Unstarted.** `CoworkAskCard` → our approvals dock (the
audit calls it "the closest prior art in the repo to brigadier's approvals"); `CoworkTodoPanel` →
the pinned plan card; `CoworkDiffPanel` → diff review. Read them before writing ours, port rather
than paste.

**W4-E — settings. Unstarted.** Global with per-project overrides (owner's choice). Layout from
the pen.dev board's settings architecture — 98px left nav, 271px content pane, rows split by
rules, 19x11 toggles, destructive in red — converted to our dark tokens. **Do not copy ChatGPT's settings
surface area**: that design has ~70 nav rows across 9 tabs; we have eight settings.

**HARD CONSTRAINTS on this wave:**
- **`src/components/Feed.tsx` does not move.** Ours is virtualized and measured at 60 Hz over 1,513
  samples. Jan renders every message with no virtualiser and the audit calls its thread renderer
  *disqualified for brigadier*. Taking it would be a measured regression.
- **The measured palette survives.** It is the only design artifact sampled from the live app.
- **Dark only.** A light scheme has to be designed, not measured, and the reference has none.
- Jan is Apache-2.0 and copying is legally open, but **do not ship Jan's trademarks or marks**.
- This wave touches all of `src/**`. It cannot run concurrently with any other frontend order.
- `tauri.conf.json`'s `"targets": "all"` was checked and is correct — measured, it produced only
  `brigadier.app` and `brigadier_0.1.0_aarch64.dmg` on this machine, no `.deb`, `.msi` or AppImage.
  `"all"` is host-scoped. `docs/STATUS.md` §5, "Not a defect, checked and dismissed". No work item.

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
