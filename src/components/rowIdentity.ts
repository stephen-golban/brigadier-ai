import type { ThreadRow } from "../threadProjection";

/**
 * Structural equality for a projected thread row.
 *
 * `projectThread` builds every `ThreadRow` and every `TraceNode` fresh on each call, so a history
 * poll that changed nothing — and a running turn issues one every 100 ms
 * (`src/hooks/useConversationHistory.ts`) — hands the transcript 40 new row objects describing the
 * same 40 rows. Nothing downstream can bail on `Object.is` after that.
 *
 * The walk is generic on purpose: it compares every own key it finds, so a field added to
 * `ThreadRow` or `TraceNode` later is compared without anyone remembering to come back here. It is
 * also cheap, because the leaves are shared: `mergeHistory` reuses the `ChatItem` object for any
 * item whose `seq` and `body` did not move, so each node bottoms out at `Object.is` on the item
 * rather than walking its fields. Rows hold plain JSON data only — no functions, no cycles.
 *
 * Because that promise is generic, so is the refusal: anything whose own state does not live in
 * its own enumerable string keys is **never** equal here unless it is the same object. A `RegExp`,
 * an `Error` and a class instance all have no own enumerable keys, so a key walk would call
 * `/a/` and `/b/` the same row — an extra render is the cost of guessing wrong in the other
 * direction, stale pixels are the cost of guessing wrong in this one. A `Date` is the one exotic
 * compared by value, because its value is unambiguous.
 */
export function sameRowValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return false;
  const proto = Object.getPrototypeOf(a);
  // A class instance is not its plain-object twin, and a subclass is not its base.
  if (proto !== Object.getPrototypeOf(b)) return false;
  if (proto === Date.prototype)
    return (a as Date).getTime() === (b as Date).getTime();
  // Everything else exotic — `Map`, `Set`, `RegExp`, `Error`, any class — keeps its state
  // somewhere a key walk cannot see it. None is reachable from a projected row.
  if (proto !== null && proto !== Object.prototype && proto !== Array.prototype)
    return false;
  // Nor can a key walk see a symbol key. The wire is JSON and has none; a row that grew one
  // would be rebuilt rather than silently treated as unchanged.
  if (Object.getOwnPropertySymbols(a).length || Object.getOwnPropertySymbols(b).length)
    return false;
  const isArray = proto === Array.prototype;
  if (isArray) {
    const left = a as unknown[],
      right = b as unknown[];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++)
      if (!sameRowValue(left[index], right[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    // `Object.hasOwn` is ES2022; this file type-checks against the repo's `lib`.
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!sameRowValue(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Give a re-projection the identities of the projection before it, row by row.
 *
 * `next` is mutated in place — it is the array `projectThread` just built and nobody else holds
 * it. When every row was carried over and the order is unchanged, the previous **array** is
 * returned as well, so `useMemo`s keyed on the row list (the message list here,
 * `PeerTaskCardScope`'s card map) bail out too.
 */
export function reuseRows(previous: readonly ThreadRow[], next: ThreadRow[]): ThreadRow[] {
  if (!previous.length) return next;
  // Positional first, and in the steady state that is the whole of it: a live turn appends and
  // rewrites the tail, so every row above it is already at its own index and this pass allocates
  // nothing. Only a shift — an older page paged in above, a notice landing mid-list — pays for
  // the index.
  let shifted = false;
  for (let index = 0; index < next.length; index++) {
    const old = previous[index];
    if (old?.id !== next[index]!.id) {
      shifted = true;
      continue;
    }
    if (sameRowValue(old, next[index])) next[index] = old;
  }
  if (shifted) {
    const byId = new Map<string, ThreadRow>();
    for (const row of previous) byId.set(row.id, row);
    for (let index = 0; index < next.length; index++) {
      if (previous[index]?.id === next[index]!.id) continue;
      const old = byId.get(next[index]!.id);
      if (old && sameRowValue(old, next[index])) next[index] = old;
    }
  }
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index++)
    if (previous[index] !== next[index]) return next;
  return previous as ThreadRow[];
}
