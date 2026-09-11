# Transcript row re-renders, measured — 2026-09-11

**[measured]** in jsdom under `vitest run`, on branch `fix/locks-trap-rowscope-2026-09-11`. Every
number below came off `src/components/ThreadView.renders.test.tsx`, run before and after the fix
with nothing else changed.

## 1. The defect

`Transcript` built each row's `RowScope.Provider` value as an object literal inside its own JSX, so
every visible row's parts re-rendered whenever `Transcript` rendered at all. Three inputs behind it
were equally unstable and had to go with it:

- `projectThread` returns all-new `ThreadRow` objects on every call, and a running turn re-projects
  roughly every 100 ms whether or not anything moved (`src/hooks/useConversationHistory.ts` debounce).
- the `ThreadMessage` list was rebuilt whole from `rows`, so one changed row handed 39 others a new
  message object.
- `toggle` was a fresh closure per render, and every work row's `approvals` a fresh
  `{pending, actions}` object per render even with no approval anywhere in the session.

## 2. Harness

`src/components/ThreadView.renders.test.tsx`. n = **40 rows**, of which **39** carry a counter:

- 12 finished turns × (user row + work row + answer row) = 36 rows,
- one `compacted` lifecycle notice (no counter — it renders neither prose nor a trace),
- an open turn: user row + work row + a streaming answer row.

40 < the 60-row virtualisation threshold, so every row is mounted and countable.

Counting is by wrapper, not by `Profiler`: `Profiler.onRender` reports a commit, not which rows
re-ran inside it. The wrappers replace `Markdown` (every prose row) and `WorkTrace` (every work row)
with a function that increments a counter and then renders the real component, so behaviour is
unchanged and a row that bails out never reaches the counter — a 0 is the memo boundary holding,
not a mock swallowing work. Both counters are keyed by **row id**: the work wrapper reads
`props.row.id`, the prose wrapper reads the message id (which `rowMessage` sets to the row id)
through `useAuiState((s) => s.optional.message?.id)`, so no fixture body has to be unique for the
count to mean a row. Counters are cleared after the mount has settled (`await act(async () => {})`
past the lazy markdown chunk).

Command, both before and after:

```sh
npx vitest run src/components/ThreadView.renders.test.tsx
```

## 3. Numbers

Rows that ran a part renderer after the trigger, out of 39 counted (mount itself renders 39/39 in
both columns):

| Trigger | Before | After |
| --- | --- | --- |
| A fresh `requests` element — `ThreadView`'s `memo` misses, `Transcript` re-renders, no row's inputs changed | **39** | **0** |
| A history poll that delivers the same items (the live cursor moved; `mergeHistory` returns a new array of the same rows — what a running turn does every 100 ms) | **39** | **0** |
| A streaming delta that extends only the last answer's body | **39** (13 work rows + 26 prose rows) | **1** (the streaming row only) |

The third row's after-figure is one row and two part renders of it: the runtime pushes its own
update for the last message before the new page commits, so that row's prose part runs once against
the message its provider still held and once against the new one. 13/13 work rows and 25/26 prose
rows sit the delta out. The test asserts exactly that — the only counted row id is the streaming
row's, twice — rather than a bound.

## 4. The fix

`src/components/ThreadView.tsx`, plus one new helper `src/components/rowIdentity.ts`.

**A memoised `TranscriptRow` component**, not a `useMemo` on the context value. A `useMemo` alone
would not have fixed trigger 1 or 2: the row's element tree is recreated by `Transcript`'s render
either way, so the parts re-render whatever the provider value holds. The boundary has to be a
component. The scope object is *then* memoised inside it, because the props that are not in the
scope — the virtualiser's offset, `isLast`, the message — move on their own.

That only pays if every prop is stable across a render that changed nothing, so:

- `reuseRows` (`rowIdentity.ts`) hands a re-projection the identities of the projection before it,
  row by row, by structural equality. The walk is generic — it compares every own key it finds, so a
  field added to `ThreadRow` or `TraceNode` later is compared without anyone remembering — and cheap,
  because `mergeHistory` preserves the `ChatItem` object for any item whose `seq` and `body` did not
  move, so each trace node bottoms out at `Object.is`. Pairing is positional first, which in the
  steady state (a live turn appends and rewrites its tail) allocates nothing; an id-keyed `Map` is
  built only when a row actually shifted. When every row carried over and the order held, the
  previous **array** is returned too, so `useMemo`s keyed on the row list bail out as well.
- one `ThreadMessage` per row, cached against the four inputs `rowMessage` reads (row identity,
  turn id, first-row flag, `peers`), so a re-projection that changed one row keeps 39 messages.
- `toggle` is a `useCallback`; a work row with neither a pending nor a resolved approval keeps the
  shared `noRowApprovals` instead of an equal-but-new object.

Nothing that was already memoised was removed. Behaviour is untouched: the same parts, the same
order, the same `MessageTimestamp` remount key, the same non-optimistic approval cards (a row with
a pending or resolved approval still gets a fresh value and still re-renders — the one place where
re-rendering is the point).

Because that generic promise cuts both ways, the refusal is generic too: `sameRowValue` compares
prototypes first, and anything whose own state does not live in its own enumerable string keys is
never equal unless it is the same object — a `RegExp`, an `Error`, a `Map`, a class instance, or an
object carrying symbol keys. A key walk would otherwise call `/a/` and `/b/` the same row. A `Date`
is the one exotic compared by value. Nothing on this path is any of these today; the guard is there
because the comment promises future fields are handled.

`src/components/rowIdentity.test.ts` pins the equality in both directions, because the risk in
`reuseRows` is a false positive — a row that changed but keeps its old pixels: a re-projection of
the same items is equal field by field; `running`, `final`, `failures` and a changed body each break
it; a missing key is not an `undefined` one; and none of the empty-key-walk shapes above is ever
reused.

## 5. Gates

- `npm test` — exit **0**, 89 files, 765 tests.
- `npx tsc --noEmit` — exit **0**.

## 6. Not checked

- **The burn was not run.** The lead runs it with the console unlocked after the branch's other
  work lands. No number here says anything about exec → first contentful paint; the claim made is
  narrower — the fix removes per-row work and adds no per-row allocation on a frame path. It does
  add two allocations per *re-projection* (the message cache's `Map`, and `reuseRows`' id `Map`
  only when rows shifted), at roughly 10/s during a live turn, against 38 row re-renders removed.
- **The virtualised path (> 60 rows) was not measured.**
- **Browser-real numbers.** Everything above is jsdom render accounting; it counts React work, not
  paint.
- `sameRowValue` assumes rows are acyclic plain JSON. That holds for everything `projectThread`
  emits today, including a notice's `detail` as it arrives on the wire; a cyclic value placed in a
  row would not terminate.
