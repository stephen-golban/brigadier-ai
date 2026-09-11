/**
 * The risk in `reuseRows` is a false positive: a row that changed but keeps its old object, and
 * so its old pixels. These tests pin the equality, both directions, on the shapes a projection
 * actually produces — including the fields that move on their own (`running`, `streaming`,
 * `final`, a trace's `durationMs`) and the appended/prepended cases.
 */
import { describe, expect, it } from "vitest";
import { projectThread, type ThreadRow } from "../threadProjection";
import { reuseRows, sameRowValue } from "./rowIdentity";
import type { ChatItem } from "../workspaceApi";

const item = (id: string, seq: number, kind: ChatItem["kind"], body: string): ChatItem => ({
  session_id: "s",
  id,
  seq,
  at: 0,
  kind,
  body,
  parent_id: null,
});
const turn = (index: number, answer: string): ChatItem[] => [
  item(`u${index}`, index * 4 + 1, { type: "user-text" }, `Question ${index}`),
  item(`c${index}`, index * 4 + 2, { type: "tool-call", name: "Bash" }, `run ${index}`),
  item(`r${index}`, index * 4 + 3, { type: "tool-result", tool_call_id: `c${index}`, is_error: false }, `out ${index}`),
  item(`a${index}`, index * 4 + 4, { type: "assistant-text" }, answer),
];

describe("sameRowValue", () => {
  it("holds for a re-projection of the same items and breaks on any field", () => {
    const items = [...turn(0, "Answer"), ...turn(1, "Answer")];
    const [first, second] = [projectThread(items, false), projectThread(items, false)];
    expect(first.map((row) => row.id)).toEqual(second.map((row) => row.id));
    for (const [index, row] of first.entries()) {
      expect(row).not.toBe(second[index]);
      expect(sameRowValue(row, second[index])).toBe(true);
    }
    const work = first.find((row) => row.type === "work")!;
    expect(sameRowValue(work, { ...work, running: !work.running })).toBe(false);
    expect(sameRowValue(work, { ...work, failures: work.failures + 1 })).toBe(false);
    const answer = first.find(
      (row): row is Extract<ThreadRow, { type: "message" }> =>
        row.type === "message" && !!row.final,
    )!;
    expect(sameRowValue(answer, { ...answer, final: undefined })).toBe(false);
    expect(sameRowValue(answer, { ...answer, item: { ...answer.item, body: "other" } })).toBe(false);
  });

  it("separates a missing key from an undefined one and never guesses at a Map", () => {
    expect(sameRowValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameRowValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameRowValue({ at: new Date(5) }, { at: new Date(5) })).toBe(true);
    expect(sameRowValue({ at: new Date(5) }, { at: new Date(6) })).toBe(false);
    expect(sameRowValue(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(false);
    expect(sameRowValue(0, -0)).toBe(false);
    expect(sameRowValue(null, {})).toBe(false);
  });

  // Each of these has no own enumerable string key, so a plain key walk calls them equal.
  it("never calls two values equal on the strength of an empty key walk", () => {
    expect(sameRowValue(/a/, /b/)).toBe(false);
    expect(sameRowValue({ pattern: /a/ }, { pattern: /b/ })).toBe(false);
    expect(sameRowValue(new Error("a"), new Error("b"))).toBe(false);
    class Row {
      constructor(readonly id: string) {}
    }
    expect(sameRowValue(new Row("a"), new Row("b"))).toBe(false);
    expect(sameRowValue(new Row("a"), { id: "a" })).toBe(false);
    const mark = Symbol("mark");
    expect(sameRowValue({ id: "a", [mark]: 1 }, { id: "a", [mark]: 2 })).toBe(false);
    expect(sameRowValue({ id: "a" }, { id: "a", [mark]: 1 })).toBe(false);
    // The same object is still the same object, whatever it is.
    const shared = /a/;
    expect(sameRowValue({ pattern: shared }, { pattern: shared })).toBe(true);
  });
});

describe("reuseRows", () => {
  const project = (items: ChatItem[], busy: boolean) => projectThread(items, busy);

  it("carries every identity across a re-projection that changed nothing", () => {
    const items = [...turn(0, "Answer"), ...turn(1, "Answer")];
    const previous = project(items, false);
    const next = reuseRows(previous, project(items, false));
    // The array itself too, so a `useMemo` keyed on the row list bails out.
    expect(next).toBe(previous);
  });

  it("keeps the rows above a growing streaming answer and rebuilds only that one", () => {
    const open = [...turn(0, "Answer"), ...turn(1, "Live")];
    const previous = project(open, true);
    const grown = open.map((entry) =>
      entry.id === "a1" ? { ...entry, body: "Live and longer" } : entry,
    );
    const next = reuseRows(previous, project(grown, true));
    expect(next).not.toBe(previous);
    const changed = next.filter((row, index) => row !== previous[index]);
    expect(changed.map((row) => row.id)).toEqual(["a1"]);
    expect((changed[0] as Extract<ThreadRow, { type: "message" }>).item.body).toBe("Live and longer");
  });

  it("does not reuse a row whose own state moved, and reuses across a prepended page", () => {
    const items = [...turn(0, "Answer"), ...turn(1, "Live")];
    const running = project(items, true);
    const finished = reuseRows(running, project(items, false));
    // The last turn's work row stops running and its answer stops streaming: both must be new.
    const moved = finished.filter((row, index) => row !== running[index]).map((row) => row.id);
    expect(moved).toEqual(["work:u1", "a1"]);

    const older = [...turn(-1, "Older"), ...items];
    const paged = reuseRows(finished, project(older, false));
    expect(paged.slice(3)).toEqual(finished);
    for (const [index, row] of finished.entries()) expect(paged[index + 3]).toBe(row);
  });
});
