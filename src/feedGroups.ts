/**
 * Terse-feed grouping: **many wire rows in, one display line out.**
 *
 * `docs/vision.md` §9 asks for *"one line per event, harness-derived"* and puts model prose behind
 * a verbose toggle. W4-D2 shipped the toggle and nothing else, so what the owner drove on
 * 2026-09-04 was still a log: **one tool call cost three rows** —
 * `tool Bash · …`, `tool Bash done · …`, `tool result done · …` — plus an
 * `approval asked` / `approval allowed` pair and a `thinking` / `thinking done` pair. Roughly 90
 * rows for one question, and the answer was not findable in them.
 *
 * This module is the fold. It takes the ring exactly as the store holds it and returns the
 * **display lines** the feed draws: a head line per group, the members hidden under it, and the
 * members spliced back in when the operator opens one. Nothing here draws anything and nothing
 * here knows a class name — `Feed.tsx` owns the markup, `src/index.css.test.ts` gates it, and a
 * class name computed in a `.ts` file would be invisible to that gate.
 *
 * ---------------------------------------------------------------------------------------------
 * ## The departure from W4-D2, stated rather than buried
 *
 * `Feed.tsx` has said since W4-D2 that **nothing reads a character of `l`**. This module does, and
 * it has to, for exactly two facts the wire does not carry:
 *
 *   1. **A failed tool call is `k === "tool"`, not `k === "err"`.**
 *      `crates/store/src/feed.rs` maps `ItemKind::ToolResult { is_error }` to `FeedKind::Tool`
 *      whichever way `is_error` reads, and puts the difference in the label —
 *      `tool failed done · Exit code 1` against `tool result done · …`. A fold that could not tell
 *      them apart would collapse a red gate into silence, which is the one outcome the owner
 *      named as unacceptable.
 *   2. **An approval that is still open is `k === "appr"`, and so is the answer to one.**
 *      `Event::RequestOpened` and `Event::RequestResolved` share a kind and carry no request id on
 *      the feed wire, so "asked, and nobody has answered yet" is only legible from
 *      `approval asked · …` versus `approval allowed` / `approval denied · …`.
 *
 * Everything read here is produced by `terse_line` in `crates/store/src/feed.rs` and by nothing
 * else. The prefixes are listed in `LABELS` below, next to the `item_label` arm that emits each
 * one. A row whose line matches none of them is treated as a plain row that groups with nothing —
 * **the unrecognised case is always the visible case**, which is the same rule `unknown` gets from
 * the kind filter.
 *
 * ## Cost
 *
 * One pass over at most `ROW_CAP` (2,000) rows per store change, allocating one small object per
 * display line. That is a real change from W4-D2, where the verbose path returned the store's own
 * array by identity and allocated nothing: **both paths now allocate.** What it does not change is
 * the thing that was measured — the virtualizer still mounts a screenful, `ROW_H` is untouched,
 * and no row is rendered because it was grouped.
 */
import type { FeedRowWire } from "./wire";

/**
 * The line prefixes `crates/store/src/feed.rs::terse_line` emits, and the only strings this
 * module compares against.
 *
 * `item_label` builds a tool row's label as `tool {name}` for a call, `tool result` for a
 * successful result and `tool failed` for an errored one; `ItemCompleted` appends ` done` to
 * whichever label it got. `RequestOpened` emits `approval asked · {tool}` for a tool permission
 * and `question · {prompt}` for a user-input request; `RequestResolved` emits `approval allowed`
 * or `approval denied · {reason}`.
 */
const LABELS = {
  /** `ItemKind::ToolResult { is_error: true }` — the row that must never fold into silence. */
  toolFailed: "tool failed",
  /** `ItemKind::ToolResult { is_error: false }`. */
  toolResult: "tool result",
  /** `Event::RequestOpened`, both of its shapes. */
  asked: ["approval asked", "question"],
  /** `Event::RequestResolved`, both decisions. */
  answered: ["approval allowed", "approval denied"],
  /** `ItemCompleted` appends this to whatever `item_label` returned. */
  done: " done",
} as const;

/**
 * How far past an `approval asked` row the fold looks for its answer before giving up and leaving
 * the ask on a line of its own.
 *
 * A constant, so the pass stays O(n): without it a run of unanswered asks would be O(n²). Eight is
 * generous against the shape the driver actually produces — the request opens and resolves inside
 * one tool call, with at most a couple of rows between them — and the failure mode of it being too
 * small is that an answered approval keeps its own line, which is noise, not a lie.
 */
const ANSWER_LOOKAHEAD = 8;

/** How a line is coloured. `Feed.tsx` maps these to classes; nothing here names one. */
export type FeedTone = "plain" | "bad" | "ask" | "quiet";

/** One line of the pane. Either a row on its own, a fold head, or a member of an open fold. */
export interface FeedLine {
  /** `${session}#${seq}`, the key `Feed.tsx` already gave every row. Unique across the pane. */
  key: string;
  /** The row whose `l` and `t` this line prints. */
  row: FeedRowWire;
  /** Rows folded under this head. `0` on every line that is not a fold. */
  folded: number;
  /** This head is open, so its members follow it as `nested` lines. */
  open: boolean;
  /** This line is a member revealed by an open head. */
  nested: boolean;
  tone: FeedTone;
}

export interface FeedView {
  lines: FeedLine[];
  /**
   * Rows that survived the prose filter — what the pane is showing, folds included. The count in
   * the band reports this against the ring's total, so a pane that is hiding prose says so.
   */
  shown: number;
}

/* ------------------------------------------------------------------ labels */

/** Where a row's label ends: at the first ` · `, or at the end of the line. */
function labelEnd(l: string): number {
  const i = l.indexOf(" · ");
  return i === -1 ? l.length : i;
}

/** The label ends in ` done`, i.e. this row is an `ItemCompleted`. Allocates nothing. */
function isCompletion(l: string): boolean {
  const end = labelEnd(l);
  return end >= LABELS.done.length && l.startsWith(LABELS.done, end - LABELS.done.length);
}

/** `ItemKind::ToolResult { is_error: true }`, in either of its two rows. */
export function isFailure(r: FeedRowWire): boolean {
  return r.k === "tool" && r.l.startsWith(LABELS.toolFailed);
}

function isToolResult(r: FeedRowWire): boolean {
  return r.k === "tool" && r.l.startsWith(LABELS.toolResult);
}

/** A tool row that opens a call: not a result, not a failure, not a completion. */
function opensTool(r: FeedRowWire): boolean {
  return r.k === "tool" && !isFailure(r) && !isToolResult(r) && !isCompletion(r.l);
}

/** A tool row that belongs to the call already open: its completion, or its result. */
function continuesTool(r: FeedRowWire): boolean {
  return r.k === "tool" && !isFailure(r) && (isToolResult(r) || isCompletion(r.l));
}

function opensThink(r: FeedRowWire): boolean {
  return r.k === "think" && !isCompletion(r.l);
}

function continuesThink(r: FeedRowWire): boolean {
  return r.k === "think" && isCompletion(r.l);
}

/** `Event::RequestOpened`: somebody was asked something. */
function isAsk(r: FeedRowWire): boolean {
  return r.k === "appr" && LABELS.asked.some((p) => r.l.startsWith(p));
}

/** `Event::RequestResolved`: the ask was answered, so it is history. */
function isAnswer(r: FeedRowWire): boolean {
  return r.k === "appr" && LABELS.answered.some((p) => r.l.startsWith(p));
}

/**
 * An answer to the ask at `from - 1` lies within the bounded window ahead.
 *
 * The scan stops at the first row that is neither an approval nor a tool row, so an ask followed
 * by a turn boundary is never claimed to have been answered by something on the other side of it.
 */
function answerFollows(rows: readonly FeedRowWire[], from: number, end: number): boolean {
  const stop = Math.min(end, from + ANSWER_LOOKAHEAD);
  for (let i = from; i < stop; i += 1) {
    const r = rows[i]!;
    if (isAnswer(r)) return true;
    if (r.k !== "appr" && r.k !== "tool") return false;
  }
  return false;
}

/* ------------------------------------------------------------------- tones */

/**
 * The row's colour, by meaning rather than by kind alone.
 *
 * `bad` covers both `k === "err"` (W4-D2's rule, unchanged) and a failed tool result, which
 * W4-D2 could not reach because the wire files it under `tool`. `ask` is unchanged. `quiet` is
 * new and applies to reasoning rows: `thinking · 340 tokens` is the least informative line on the
 * screen and the fold leaves at most one of them per block.
 */
function toneOf(r: FeedRowWire): FeedTone {
  if (r.k === "err" || isFailure(r)) return "bad";
  if (r.k === "appr") return "ask";
  if (r.k === "think") return "quiet";
  return "plain";
}

function keyOf(r: FeedRowWire): string {
  return `${r.s}#${r.q}`;
}

function line(r: FeedRowWire, folded: number, open: boolean, nested: boolean): FeedLine {
  return { key: keyOf(r), row: r, folded, open, nested, tone: toneOf(r) };
}

/* -------------------------------------------------------------------- build */

/**
 * The one kind the terse feed removes outright: model prose.
 *
 * `docs/plans/ipc-contract.md` derives `text` from `ItemKind::AssistantText` and
 * `Event::ContentDelta` and from nothing else, so this single value is the whole of
 * `docs/vision.md` §9's "model prose lives entirely behind a verbose toggle". Everything else the
 * terse view does is a fold, which is reversible with one click; this is the only thing it hides.
 */
const PROSE: FeedRowWire["k"] = "text";

/**
 * The display lines for one pane.
 *
 * `verbose` is the escape hatch and means exactly what it meant before: **everything, raw** — no
 * prose filter and no folding, one line per wire row. Terse filters prose and folds.
 *
 * Two invariants that must survive any later edit here:
 *
 *   - **`unknown` survives every setting.** It is the absence of a class (`src/wire.ts`), it
 *     opens no group and continues none, and the only kind this function removes is `text`. The
 *     owner has 10,037 rows in that state.
 *   - **A failure is never folded and never hidden.** `isFailure` is excluded from every
 *     continuation predicate, so `tool failed done · Exit code 1` always gets a line of its own,
 *     in `--color-bad`.
 */
export function buildFeed(
  rows: readonly FeedRowWire[],
  verbose: boolean,
  expanded: ReadonlySet<string>,
): FeedView {
  const visible = verbose ? rows : rows.filter((r) => r.k !== PROSE);
  const lines: FeedLine[] = [];

  if (verbose) {
    for (const r of visible) lines.push(line(r, 0, false, false));
    return { lines, shown: visible.length };
  }

  const n = visible.length;
  let i = 0;
  while (i < n) {
    const head = visible[i]!;
    const tool = opensTool(head);
    if (!tool && !opensThink(head)) {
      lines.push(line(head, 0, false, false));
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < n) {
      const next = visible[j]!;
      if (tool) {
        if (continuesTool(next)) {
          j += 1;
          continue;
        }
        // The approval this call was blocked on, and the answer to it. An ask with no answer in
        // sight is a person still waiting: it ends the group and keeps its own prominent line.
        if (isAnswer(next) || (isAsk(next) && answerFollows(visible, j + 1, n))) {
          j += 1;
          continue;
        }
        break;
      }
      if (continuesThink(next)) {
        j += 1;
        continue;
      }
      break;
    }

    const folded = j - i - 1;
    const open = folded > 0 && expanded.has(keyOf(head));
    lines.push(line(head, folded, open, false));
    if (open) {
      for (let m = i + 1; m < j; m += 1) lines.push(line(visible[m]!, 0, false, true));
    }
    i = j;
  }

  return { lines, shown: visible.length };
}
