/**
 * The fold, as a pure function. `src/components/Feed.test.tsx` proves the pane renders it;
 * this file proves it is right, because a grouping bug is far easier to read here than through a
 * virtualizer.
 *
 * Every fixture line below is a shape `crates/store/src/feed.rs::terse_line` actually emits. That
 * is the point of the file: `src/feedGroups.ts` reads the label of a `tool` and an `appr` row, so
 * these tests are the record of *which* labels it is entitled to read, and they fail the day the
 * Rust side changes one.
 *
 * Two of them are not decoration and must never be deleted to make a change pass:
 *
 *   - **a failed tool result is never folded and never quiet.** `tool failed done · Exit code 1`
 *     is a red gate. `FeedKind` files it under `tool`, so a fold that could not tell it from
 *     `tool result done` would collapse a failure into silence.
 *   - **an approval nobody has answered is never folded.** It is the one row that means a person
 *     is blocked, and it is not history until a `RequestResolved` row follows it.
 *
 * Mechanics match `src/feedStore.test.ts`: `globals: false`, so every helper is imported.
 */
import { describe, expect, it } from "vitest";

import { buildFeed, isFailure } from "./feedGroups";
import type { FeedKind, FeedRowWire, SessionId } from "./wire";

const S1 = "11111111-1111-4111-8111-1111111a1b2c" as SessionId;
const T0 = new Date(2026, 8, 5, 9, 0, 0).getTime();

let seq = 0;

/** A row with an ascending `q`, so every line gets a distinct key the way the ring guarantees. */
function r(l: string, k: FeedKind): FeedRowWire {
  seq += 1;
  return { s: S1, q: seq, t: T0 + seq * 1_000, l, k };
}

const NONE: ReadonlySet<string> = new Set<string>();

/** The three rows one successful `Bash` call produces, in the order the driver emits them. */
function oneToolCall(): FeedRowWire[] {
  return [
    r("tool Bash · cargo check", "tool"),
    r("tool Bash done · cargo check", "tool"),
    r("tool result done · 41 lines", "tool"),
  ];
}

function printed(rows: FeedRowWire[], verbose = false, expanded = NONE): string[] {
  return buildFeed(rows, verbose, expanded).lines.map((line) => line.row.l);
}

describe("a tool call", () => {
  it("is one line in terse and three in verbose", () => {
    const rows = oneToolCall();
    expect(printed(rows)).toEqual(["tool Bash · cargo check"]);
    expect(printed(rows, true)).toEqual([
      "tool Bash · cargo check",
      "tool Bash done · cargo check",
      "tool result done · 41 lines",
    ]);
  });

  it("says how many rows it folded, so the line is not silently lossy", () => {
    const view = buildFeed(oneToolCall(), false, NONE);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]!.folded).toBe(2);
    expect(view.lines[0]!.open).toBe(false);
  });

  it("puts its members back in place when the head is opened", () => {
    const rows = oneToolCall();
    const key = `${rows[0]!.s}#${rows[0]!.q}`;
    const view = buildFeed(rows, false, new Set([key]));
    expect(view.lines.map((l) => l.row.l)).toEqual([
      "tool Bash · cargo check",
      "tool Bash done · cargo check",
      "tool result done · 41 lines",
    ]);
    expect(view.lines[0]!.open).toBe(true);
    expect(view.lines.slice(1).every((l) => l.nested)).toBe(true);
  });

  it("does not swallow the call that follows it", () => {
    // The failure this guards: every row of both calls is `k === "tool"`, so a fold that merged
    // any run of `tool` rows would print the first call and lose the second entirely.
    const rows = [...oneToolCall(), ...[
      r("tool Edit · src/App.tsx", "tool"),
      r("tool Edit done · src/App.tsx", "tool"),
      r("tool result done · 1 change", "tool"),
    ]];
    expect(printed(rows)).toEqual(["tool Bash · cargo check", "tool Edit · src/App.tsx"]);
  });
});

describe("a failed tool call", () => {
  it("keeps its own line in terse, and it is not the same grey as a success", () => {
    const rows = [
      r("tool Bash · cargo test", "tool"),
      r("tool Bash done · cargo test", "tool"),
      r("tool failed done · Exit code 1", "tool"),
    ];
    expect(printed(rows)).toEqual(["tool Bash · cargo test", "tool failed done · Exit code 1"]);

    const view = buildFeed(rows, false, NONE);
    expect(view.lines[1]!.tone).toBe("bad");
    expect(view.lines[1]!.folded).toBe(0);
  });

  it("is recognised in both of the rows `ItemKind::ToolResult { is_error: true }` produces", () => {
    expect(isFailure(r("tool failed · Exit code 1", "tool"))).toBe(true);
    expect(isFailure(r("tool failed done · Exit code 1", "tool"))).toBe(true);
    expect(isFailure(r("tool result done · 41 lines", "tool"))).toBe(false);
  });

  it("stays red under the verbose toggle too, since the toggle is about prose", () => {
    const view = buildFeed([r("tool failed done · Exit code 1", "tool")], true, NONE);
    expect(view.lines[0]!.tone).toBe("bad");
  });
});

describe("an approval", () => {
  it("folds into the tool call it blocked once it has been answered", () => {
    const rows = [
      r("tool Bash · rm -rf build", "tool"),
      r("approval asked · Bash", "appr"),
      r("approval allowed", "appr"),
      r("tool Bash done · rm -rf build", "tool"),
      r("tool result done · 0 lines", "tool"),
    ];
    expect(printed(rows)).toEqual(["tool Bash · rm -rf build"]);
  });

  it("is never folded while it is still open", () => {
    // The whole test: no `approval allowed` / `approval denied` follows, so a person is still
    // waiting and the row is not history.
    const rows = [
      r("tool Bash · rm -rf build", "tool"),
      r("approval asked · Bash", "appr"),
    ];
    const view = buildFeed(rows, false, NONE);
    expect(view.lines.map((l) => l.row.l)).toEqual([
      "tool Bash · rm -rf build",
      "approval asked · Bash",
    ]);
    expect(view.lines[1]!.folded).toBe(0);
    expect(view.lines[1]!.tone).toBe("ask");
  });

  it("keeps its line when the answer is too far away to be its answer", () => {
    const rows = [
      r("tool Bash · rm -rf build", "tool"),
      r("approval asked · Bash", "appr"),
      r("turn done · end_turn · 10 in / 4 out", "turn"),
      r("approval allowed", "appr"),
    ];
    // The scan stops at the turn boundary rather than reaching across it.
    expect(printed(rows)).toEqual([
      "tool Bash · rm -rf build",
      "approval asked · Bash",
      "turn done · end_turn · 10 in / 4 out",
      "approval allowed",
    ]);
  });

  it("folds a denial as readily as an allow: both are answers", () => {
    const rows = [
      r("tool Bash · rm -rf /", "tool"),
      r("approval asked · Bash", "appr"),
      r("approval denied · Denied by operator", "appr"),
    ];
    expect(printed(rows)).toEqual(["tool Bash · rm -rf /"]);
  });

  it("treats a free-text question as an ask, since `RequestOpened` emits both shapes", () => {
    const rows = [
      r("tool Bash · deploy", "tool"),
      r("question · which environment?", "appr"),
      r("approval allowed", "appr"),
    ];
    expect(printed(rows)).toEqual(["tool Bash · deploy"]);
  });
});

describe("reasoning", () => {
  it("is one quiet line, not a pair", () => {
    const rows = [
      r("thinking · 340 tokens", "think"),
      r("thinking done · 340 tokens", "think"),
    ];
    const view = buildFeed(rows, false, NONE);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]!.row.l).toBe("thinking · 340 tokens");
    expect(view.lines[0]!.tone).toBe("quiet");
  });
});

describe("what the fold must never touch", () => {
  it("leaves warnings, errors and session lifetime one line each", () => {
    const rows = [
      r("session started · claude-sonnet-4-5 · /repos/job-portal", "sys"),
      r("warning · could not settle intent in-7", "warn"),
      r("error · the child exited while a turn was open", "err"),
      r("turn done · end_turn · 900 in / 120 out", "turn"),
      r("session exited · graceful · exit 0", "sys"),
    ];
    expect(printed(rows)).toHaveLength(5);
    expect(buildFeed(rows, false, NONE).lines[2]!.tone).toBe("bad");
  });

  it("never removes an `unknown` row, under either setting", () => {
    // 10,037 of the owner's rows predate migration 1 and carry it. `unknown` is the absence of a
    // class; it opens no group, continues none, and is filtered by nothing.
    const rows = [
      r("predates migration 1", "unknown"),
      r("tool Bash · cargo check", "tool"),
      r("also predates migration 1", "unknown"),
    ];
    expect(printed(rows)).toEqual([
      "predates migration 1",
      "tool Bash · cargo check",
      "also predates migration 1",
    ]);
    expect(printed(rows, true)).toHaveLength(3);
  });

  it("removes model prose in terse and nothing else, and reports how much", () => {
    const rows = [
      r("assistant · here is what I found", "text"),
      r("tool Bash · cargo check", "tool"),
      r("tool Bash done · cargo check", "tool"),
    ];
    const terse = buildFeed(rows, false, NONE);
    expect(terse.shown).toBe(2);
    expect(terse.lines).toHaveLength(1);

    const loud = buildFeed(rows, true, NONE);
    expect(loud.shown).toBe(3);
    expect(loud.lines).toHaveLength(3);
  });

  it("does not let prose split a tool call it was interleaved with", () => {
    // The prose filter runs first, so the call's rows are adjacent by the time the fold sees them.
    const rows = [
      r("tool Bash · cargo check", "tool"),
      r("assistant · running the gate now", "text"),
      r("tool Bash done · cargo check", "tool"),
    ];
    expect(printed(rows)).toEqual(["tool Bash · cargo check"]);
  });

  it("groups nothing it does not recognise", () => {
    // A line whose label matches none of the shapes `terse_line` emits. The unrecognised case is
    // always the visible case: two rows in, two lines out.
    const rows = [r("a tool row", "tool"), r("another tool row", "tool")];
    expect(printed(rows)).toEqual(["a tool row", "another tool row"]);
  });
});
