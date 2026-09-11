import { describe, expect, it } from "vitest";
import {
  flattenTrace,
  activitySummary,
  activeWorkLabel,
  workDuration,
  projectThread,
  editLineCounts,
  type ThreadRow,
} from "./threadProjection";
import type { NoticeLevel } from "./wire";
import type { ChatItem, ChatTurn } from "./workspaceApi";

function item(
  id: string,
  kind: ChatItem["kind"],
  body = id,
  parent_id: string | null = null,
): ChatItem {
  return { id, kind, body, parent_id, session_id: "s", seq: 0, at: 0 };
}
const user = item("u", { type: "user-text" });
const text = (id: string, parent: string | null = null) =>
  item(id, { type: "assistant-text" }, id, parent);
const call = (id: string, parent: string | null = null, name = "Bash") =>
  item(id, { type: "tool-call", name }, id, parent);
const result = (id: string, callId: string, error = false) =>
  item(id, { type: "tool-result", tool_call_id: callId, is_error: error });
const project = (items: ChatItem[], busy = false) =>
  projectThread(
    items.map((i, seq) => ({ ...i, seq })),
    busy,
  );
function work(row: ThreadRow | undefined) {
  if (row?.type !== "work") throw new Error("Expected work");
  return row;
}

describe("minimal thread projection", () => {
  it("folds progress and paired output beneath one parent, keeping the answer visible", () => {
    const rows = project([
      user,
      text("starting"),
      call("cmd"),
      result("out", "cmd"),
      text("first paragraph"),
      text("second paragraph"),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["message", "work", "message"]);
    expect(work(rows[1]).nodes.map((n) => n.item.id)).toEqual([
      "starting",
      "cmd",
    ]);
    expect(work(rows[1]).nodes[1]?.result?.body).toBe("out");
    expect(rows[2]).toMatchObject({
      final: true,
      item: { body: "first paragraph\n\nsecond paragraph" },
    });
  });
  it("keeps a response containing only prose visible without an empty work row", () => {
    const rows = project([user, text("one"), text("two")]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      type: "message",
      item: { body: "one\n\ntwo" },
    });
  });
  it("nests child output by identity, including late parents, without hiding the main answer", () => {
    const rows = project([
      user,
      text("child progress", "agent"),
      call("child cmd", "agent"),
      call("unrelated"),
      call("agent", null, "Agent"),
      result("child out", "child cmd"),
      text("child answer", "agent"),
      result("agent out", "agent"),
      text("final"),
    ]);
    const group = work(rows[1]);
    expect(group.nodes.map((n) => n.item.id)).toEqual(["unrelated", "agent"]);
    expect(group.nodes[1]?.children.map((n) => n.item.id)).toEqual([
      "child progress",
      "child cmd",
      "child answer",
    ]);
    expect(rows[2]).toMatchObject({ item: { body: "final" } });
    expect(group.count).toBe(3);
  });
  it("coalesces agent lifecycle records and resolves parent links to any update", () => {
    const lifecycle = (id: string) =>
      item(id, {
        type: "subagent",
        task_id: "task-1",
        subagent_type: null,
        description: "Workspace research",
      });
    const rows = project([
      user,
      lifecycle("started"),
      text("child", "updated"),
      lifecycle("updated"),
      lifecycle("finished"),
      text("answer"),
    ]);
    const nodes = work(rows[1]).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.updates.map((n) => n.body)).toEqual([
      "updated",
      "finished",
    ]);
    expect(nodes[0]?.children.map((n) => n.item.body)).toEqual(["child"]);
    expect(work(rows[1]).count).toBe(1);
  });
  it("retains failed and orphaned output, cycles, and duplicate results for inspection", () => {
    const rows = project([
      user,
      call("a", "b"),
      call("b", "a"),
      result("err", "a", true),
      result("extra", "a"),
      result("orphan", "missing", true),
      text("orphan text", "missing"),
      text("answer"),
    ]);
    const group = work(rows[1]);
    expect(group.failures).toBe(2);
    expect(flattenTrace(group.nodes).map((n) => n.item.id)).toEqual([
      "a",
      "b",
      "extra",
      "orphan",
      "orphan text",
    ]);
    expect(rows[2]).toMatchObject({ item: { body: "answer" } });
  });
  it("shows live progress and separates successive user turns", () => {
    const rows = project(
      [
        user,
        call("first"),
        text("first answer"),
        item("u2", { type: "user-text" }),
        call("next"),
        text("still working"),
      ],
      true,
    );
    // The live turn's prose is now its streaming answer (§4.2.3), so the running turn ends in a
    // message row and its work row holds only the call.
    expect(rows.map((r) => r.type)).toEqual([
      "message",
      "work",
      "message",
      "message",
      "work",
      "message",
    ]);
    expect(work(rows[1]).running).toBe(false);
    expect(work(rows[4]).running).toBe(true);
    expect(work(rows[4]).nodes.map((n) => n.item.id)).toEqual(["next"]);
    expect(rows[5]).toMatchObject({ id: "still working", streaming: true });
    expect(rows[5]).not.toHaveProperty("final");
  });
  it("retains pre-tool progress inside interrupted work", () => {
    expect(
      project([user, text("starting"), call("unfinished")]).map((r) => r.type),
    ).toEqual(["message", "work"]);
  });
  it("can attach activity referring to a result before that result arrives", () => {
    const group = work(
      project([
        user,
        call("cmd"),
        text("child", "result"),
        result("result", "cmd"),
      ])[1],
    );
    expect(group.nodes).toHaveLength(1);
    expect(group.nodes[0]?.children[0]?.item.body).toBe("child");
  });
});

it.each([false, true])(
  "omits empty reasoning while preserving real provider text (busy=%s)",
  (busy) => {
    const rows = project(
      [
        user,
        item("empty", { type: "thinking" }, "  "),
        text("progress"),
        item("reason", { type: "thinking" }, "Provider reasoning"),
        text("answer"),
      ],
      busy,
    );
    // Since §4.2.3 the trailing prose is the answer row whether or not the turn is still
    // running, so both cases now produce the same three rows; only `final`/`streaming` differ.
    expect(rows.map((r) => r.id)).toEqual(["u", "work:u", "answer"]);
    expect(rows[2]).toMatchObject(
      busy ? { streaming: true } : { final: true },
    );
    expect(work(rows[1]).nodes[1]?.item.body).toBe("Provider reasoning");
  },
);
it("keeps stable row identities across streaming, result arrival, and completion", () => {
  const items = [user, text("before"), call("cmd"), text("after")];
  const live = project(items, true);
  const done = project([...items, result("out", "cmd")]);
  expect(work(done[1]).id).toEqual(work(live[1]).id);
  expect(work(done[1]).nodes[1]?.result?.id).toBe("out");
  expect(done[2]).toMatchObject({ final: true });
  // The trailing prose of a running turn is now its streaming answer, so the live row's
  // `latestProgress` is the earlier paragraph the tool call followed, not the last one.
  expect(work(live[1]).latestProgress?.id).toBe("before");
  expect(live[2]).toMatchObject({ id: "after", streaming: true });
  expect(live[2]).not.toHaveProperty("final");
});

it("uses recorded turn timing and keeps idle time between turns out of durations", () => {
  const items = [
    user,
    call("cmd"),
    text("answer"),
    item("u2", { type: "user-text" }),
    call("cmd2"),
  ].map((i, seq) => ({ ...i, seq: seq + 1 }));
  const rows = projectThread(items, true, [
    {
      id: "t1",
      start_seq: 1,
      end_seq: 3,
      started_at: 1000,
      ended_at: 135000,
      status: "completed",
    },
    {
      id: "t2",
      start_seq: 4,
      end_seq: null,
      started_at: 900000,
      ended_at: null,
      status: "running",
    },
  ]);
  expect(work(rows[1])).toMatchObject({
    durationMs: 134000,
    running: false,
    status: "completed",
  });
  expect(work(rows[4])).toMatchObject({ startedAt: 900000, running: true });
  expect(work(rows[4]).durationMs).toBeUndefined();
});
it("retains recorded failure/interruption without promoting partial output to a final answer", () => {
  for (const status of ["failed", "interrupted", "stopped"] as const) {
    const rows = projectThread(
      [user, { ...call("cmd"), seq: 2 }, { ...text("partial"), seq: 3 }],
      false,
      [
        {
          id: "t",
          start_seq: 1,
          end_seq: 4,
          started_at: 1000,
          ended_at: 4000,
          status,
        },
      ],
    );
    expect(work(rows[1])).toMatchObject({ status, durationMs: 3000 });
    expect(rows[2]).toMatchObject({ final: false, item: { body: "partial" } });
  }
});
it("separates harness turns without a user echo, and omits missing or invalid timing", () => {
  const items = [call("a"), text("one"), call("b"), text("two")].map(
    (i, seq) => ({ ...i, seq: seq + 1 }),
  );
  const rows = projectThread(items, false, [
    {
      id: "a",
      start_seq: 1,
      end_seq: 2,
      started_at: 4000,
      ended_at: 1000,
      status: "completed",
    },
    {
      id: "b",
      start_seq: 3,
      end_seq: 4,
      started_at: 5000,
      ended_at: 6000,
      status: "completed",
    },
  ]);
  expect(rows.map((r) => r.id)).toEqual(["work:a", "one", "work:b", "two"]);
  expect(work(rows[0]).durationMs).toBeUndefined();
  expect(work(project([user, call("legacy")])[1]).durationMs).toBeUndefined();
});
it("keeps recovered unfinished turns inspectable without inventing a completion time", () => {
  const rows = projectThread([{ ...call("cmd"), seq: 2 }], false, [
    {
      id: "t",
      start_seq: 1,
      end_seq: null,
      started_at: 1000,
      ended_at: null,
      status: "running",
    },
  ]);
  expect(work(rows[0])).toMatchObject({
    status: "interrupted",
    running: false,
  });
  expect(work(rows[0]).durationMs).toBeUndefined();
});

it("uses category summaries and current-item state independently of the turn timer", () => {
  const group = work(
    project([
      call("read", null, "Read"),
      result("read-out", "read"),
      call("cmd"),
      result("cmd-out", "cmd"),
      call("web", null, "WebSearch"),
      result("web-out", "web"),
    ])[0],
  );
  expect(activitySummary(group.nodes)).toBe(
    "Read files, ran a command, searched the web",
  );
  expect(activeWorkLabel(group.nodes)).toBe("Thinking");
  expect(
    activeWorkLabel(work(project([call("edit", null, "Edit")], true)[0]).nodes),
  ).toBe("Editing files");
});
it("does not make interrupted work collapsible, and still gives prose-only recorded turns a timer", () => {
  const stopped = work(
    projectThread([user, call("cmd")], false, [], "interrupted")[1],
  );
  expect(stopped.canCollapse).toBe(false);
  const rows = projectThread(
    [
      { ...user, seq: 1 },
      { ...text("answer"), seq: 2 },
    ],
    false,
    [
      {
        id: "t",
        start_seq: 1,
        end_seq: 3,
        started_at: 1000,
        ended_at: 18000,
        status: "completed",
      },
    ],
  );
  expect(work(rows[1])).toMatchObject({
    durationMs: 17000,
    canCollapse: false,
    nodes: [],
  });
  expect(rows[2]).toMatchObject({ final: true });
});
it("formats long elapsed times without dropping seconds or adding zero units", () => {
  expect(workDuration(60000)).toBe("1m");
  expect(workDuration(3661000)).toBe("1h 1m 1s");
  expect(workDuration(90001000)).toBe("1d 1h 1s");
});

/* ---------------------------------------------------------------- streaming answers (§4.2.3) */

const OPEN: ChatTurn = {
  id: "t",
  start_seq: 1,
  end_seq: null,
  started_at: 1_000,
  ended_at: null,
  status: "running",
};
const settledTurn = (endSeq: number, endedAt: number): ChatTurn => ({
  ...OPEN,
  end_seq: endSeq,
  ended_at: endedAt,
  status: "completed",
});
/** `project()` fixes `seq` from array order; these drive one turn at successive moments. */
const at = (items: ChatItem[]) => items.map((i, index) => ({ ...i, seq: index + 1 }));

// T1. The test that proves streaming: the body lengthens and the turn never ends. A fixture with
// a turn boundary in it would prove only that a completed turn renders, which already worked.
it("T1: grows a streaming answer in place, with no turn completion in the fixture", () => {
  const frame = (body: string) =>
    at([user, call("cmd"), result("out", "cmd"), { ...text("stream"), body }]);
  expect(OPEN.end_seq).toBeNull();
  expect(OPEN.ended_at).toBeNull();
  expect(OPEN.status).toBe("running");

  const early = projectThread(frame("Hel"), true, [OPEN]);
  const later = projectThread(frame("Hello, world"), true, [OPEN]);

  expect(early.map((r) => r.id)).toEqual(["u", "work:u", "stream"]);
  expect(later.map((r) => r.id)).toEqual(["u", "work:u", "stream"]);
  expect(later.filter((r) => r.type === "message")).toHaveLength(2); // the user row and one answer
  expect(later[2]).toMatchObject({
    type: "message",
    id: "stream",
    streaming: true,
    item: { body: "Hello, world" },
  });
  expect(later[2]).not.toHaveProperty("final");

  // The turn ends: same id, completed body, `final` now true and `streaming` gone, so the row is
  // re-rendered rather than remounted.
  const done = projectThread(frame("Hello, world."), false, [settledTurn(4, 9_000)]);
  expect(done[2]).toMatchObject({
    id: "stream",
    final: true,
    item: { body: "Hello, world." },
  });
  expect(done[2]).not.toHaveProperty("streaming");
});

// T2. Prose, a tool call, more prose, all while running. Positional promotion stays, so the
// paragraph the call followed returns to the activity group — but its **identity does not
// change**: the row id the projection gives a streaming paragraph is the item's own id, and that
// same id is what identifies it inside the work row (`WorkTrace.tsx:179,226` key every trace
// entry on `node.item.id`). So across all three projections each paragraph keeps one id and only
// its position changes; no id is ever reused for different content, and no content is ever
// re-keyed.
it("T2: keeps every paragraph's id stable while its position changes", () => {
  const prose1 = at([user, text("p1")]);
  const withCall = at([user, text("p1"), call("cmd")]);
  const prose2 = at([user, text("p1"), call("cmd"), text("p2")]);
  const run = (items: ChatItem[]) => projectThread(items, true, [OPEN]);
  /** Every id the projection emits for a step: row ids plus the ids inside the work row. */
  const identities = (rows: ThreadRow[]) =>
    rows.flatMap((r) =>
      r.type === "work"
        ? [r.id, ...flattenTrace(r.nodes).map((n) => n.item.id)]
        : [r.id],
    );

  expect(identities(run(prose1))).toEqual(["u", "work:u", "p1"]);
  expect(identities(run(withCall))).toEqual(["u", "work:u", "p1", "cmd"]);
  expect(identities(run(prose2))).toEqual(["u", "work:u", "p1", "cmd", "p2"]);

  // p1 is the answer row while it is trailing, and the same id inside the work row after the
  // call lands. It is never dropped and never renamed.
  expect(run(prose1).map((r) => r.id)).toEqual(["u", "work:u", "p1"]);
  expect(run(prose1)[2]).toMatchObject({ id: "p1", streaming: true });
  expect(
    flattenTrace(work(run(withCall)[1]).nodes).map((n) => n.item.id),
  ).toContain("p1");
  expect(run(prose2).map((r) => r.id)).toEqual(["u", "work:u", "p2"]);
  expect(run(prose2)[2]).toMatchObject({ id: "p2", streaming: true, item: { body: "p2" } });

  // And the id a paragraph carries as a streaming row is the one it keeps when the turn settles,
  // so the answer is not re-keyed at the turn boundary either.
  const settled = projectThread(prose2, false, [settledTurn(4, 9_000)]);
  expect(settled.map((r) => r.id)).toEqual(["u", "work:u", "p2"]);
  expect(work(settled[1]).nodes.map((n) => n.item.id)).toEqual(["p1", "cmd"]);
});

// The settled half of T2, and the commentary guard: once the turn stops, only the trailing prose
// run is the answer and the paragraph a tool call followed is activity again — which is what a
// reload of the same turn out of SQLite produces.
it("leaves prose that a tool call followed inside the activity group once the turn settles", () => {
  const rows = projectThread(
    at([user, text("p1"), call("cmd"), text("p2")]),
    false,
    [settledTurn(4, 9_000)],
  );
  expect(rows.map((r) => r.id)).toEqual(["u", "work:u", "p2"]);
  expect(work(rows[1]).nodes.map((n) => n.item.id)).toEqual(["p1", "cmd"]);
  expect(rows[2]).toMatchObject({ final: true, item: { body: "p2" } });
});

// T3. `WorkTrace.tsx:66` opens the list when `!row.canCollapse`; a streaming answer makes
// `answer.length > 0` true mid-turn, so without `&& !running` the live activity would fold up
// under the operator.
it("T3: a running turn does not collapse its own activity", () => {
  const items = at([user, call("cmd"), result("out", "cmd"), text("answer")]);
  expect(work(projectThread(items, true, [OPEN])[1]).canCollapse).toBe(false);
  expect(work(projectThread(items, false, [settledTurn(4, 9_000)])[1]).canCollapse).toBe(true);
});

/* ------------------------------------------------------------------- notices, timing, edits */

const notice = (
  id: string,
  level: NoticeLevel,
  code: string,
  body = id,
): ChatItem => item(id, { type: "notice", level, code }, body);

it("orders a lifecycle notice by seq, between the rows around it", () => {
  const rows = projectThread(
    at([
      user,
      text("answer"),
      notice("n1", "warning", "runtime", "context compacted"),
      item("u2", { type: "user-text" }),
      text("second"),
    ]),
    false,
    [],
  );
  expect(rows.map((r) => r.type)).toEqual([
    "message",
    "message",
    "notice",
    "message",
    "message",
  ]);
  expect(rows[2]).toMatchObject({
    type: "notice",
    id: "n1",
    level: "warning",
    code: "runtime",
    // The three things a renderer branches on: the row type, the severity, and the item kind —
    // `ThreadView.tsx:412` puts `row.item.kind.type` on the row's class, so a notice already
    // reaches the DOM as `.aui-message.notice` rather than as anonymous assistant prose.
    item: { kind: { type: "notice", level: "warning", code: "runtime" }, body: "context compacted" },
  });
  expect(rows[2]).not.toHaveProperty("final");
  // A notice with no turn open is emitted where it stands, and never splits a turn in two.
  const first = projectThread(at([notice("n0", "info", "exited"), user, text("a")]), false, []);
  expect(first.map((r) => r.id)).toEqual(["n0", "u", "a"]);
  // A notice inside a turn is held so it cannot split one work row in two, and then emitted at
  // its place in `seq` order — before the answer it preceded, not after it.
  const midTurn = projectThread(
    at([user, call("a"), notice("n2", "error", "runtime"), call("b"), text("answer")]),
    false,
    [],
  );
  expect(midTurn.map((r) => r.type)).toEqual(["message", "work", "notice", "message"]);
  expect(midTurn.map((r) => r.id)).toEqual(["u", "work:u", "n2", "answer"]);
  expect(work(midTurn[1]).nodes.map((n) => n.item.id)).toEqual(["a", "b"]);
  // …and one that lands after the answer stays after it.
  const afterAnswer = projectThread(
    at([user, call("a"), text("answer"), notice("n3", "info", "exited")]),
    false,
    [],
  );
  expect(afterAnswer.map((r) => r.id)).toEqual(["u", "work:u", "answer", "n3"]);
});

it("times each tool call from the timestamps already on its call and result", () => {
  const stamp = (i: ChatItem, seq: number, time: number) => ({ ...i, seq, at: time });
  const rows = projectThread(
    [
      stamp(user, 1, 1_000),
      stamp(call("cmd"), 2, 2_000),
      stamp(result("out", "cmd"), 3, 5_500),
      stamp(call("backwards"), 4, 9_000),
      stamp(result("back-out", "backwards"), 5, 8_000),
      stamp(call("untimed"), 6, 0),
      stamp(result("untimed-out", "untimed"), 7, 0),
      stamp(call("open"), 8, 10_000),
      stamp(text("answer"), 9, 11_000),
    ],
    false,
    [],
  );
  const nodes = work(rows[1]).nodes;
  expect(nodes.map((n) => n.durationMs)).toEqual([
    3_500,
    undefined, // a result stamped before its call is a clock artefact, not a negative duration
    undefined, // `at === 0` is "no recorded time"
    undefined, // no result yet
  ]);
});

it("gives the turn header both a duration and a completion time, and neither while it is open", () => {
  const rows = projectThread(
    at([user, call("cmd"), text("answer"), item("u2", { type: "user-text" }), call("cmd2")]),
    true,
    [
      { ...OPEN, id: "t1", end_seq: 3, ended_at: 135_000, status: "completed" },
      { ...OPEN, id: "t2", start_seq: 4, started_at: 900_000 },
    ],
  );
  expect(work(rows[1])).toMatchObject({ durationMs: 134_000, completedAtMs: 135_000 });
  expect(work(rows[4]).durationMs).toBeUndefined();
  expect(work(rows[4]).completedAtMs).toBeUndefined();
});

it("counts added and removed lines from an Edit/Write input, and returns nothing on any doubt", () => {
  const input = (value: unknown, name = "Edit") =>
    item("e", { type: "tool-call", name }, `Edit /a\n${JSON.stringify(value)}`);
  expect(
    editLineCounts(input({ file_path: "/a", old_string: "one\ntwo", new_string: "1\n2\n3" })),
  ).toEqual({ added: 3, removed: 2 });
  // An insertion removes nothing; a deletion adds nothing; a trailing newline terminates a line
  // rather than starting an empty one.
  expect(editLineCounts(input({ old_string: "", new_string: "added\n" }))).toEqual({
    added: 1,
    removed: 0,
  });
  expect(editLineCounts(input({ old_string: "gone", new_string: "" }))).toEqual({
    added: 0,
    removed: 1,
  });
  expect(
    editLineCounts(
      input({ edits: [{ old_string: "a", new_string: "a\nb" }, { old_string: "c\nd", new_string: "c" }] }, "MultiEdit"),
    ),
  ).toEqual({ added: 3, removed: 3 });
  expect(editLineCounts(input({ content: "one\ntwo\n" }, "Write"))).toEqual({
    added: 2,
    removed: 0,
  });
  // Everything unreadable, and everything that would need a guess, returns nothing.
  for (const unreadable of [
    input({ old_string: "a", new_string: "b", replace_all: true }), // occurrence count is in the file
    input({ old_string: "a" }), // no replacement text
    input({ edits: [] }, "MultiEdit"),
    input({ edits: "all of them" }, "MultiEdit"),
    input({ content: 42 }, "Write"),
    input({ old_string: "a", new_string: "b" }, "Read"),
    item("e", { type: "tool-call", name: "Edit" }, "Edit /a\n{not json"),
    item("e", { type: "tool-call", name: "Edit" }, "no input at all"),
    item("e", { type: "assistant-text" }, '{"old_string":"a","new_string":"b"}'),
  ])
    expect(editLineCounts(unreadable)).toBeUndefined();
  // The projection carries the numbers on the node, so a row needs no second parse.
  const rows = projectThread(
    at([user, { ...input({ old_string: "a", new_string: "a\nb" }), id: "edit" }, text("answer")]),
    false,
    [],
  );
  expect(work(rows[1]).nodes[0]?.edit).toEqual({ added: 2, removed: 1 });
  expect(work(rows[1]).nodes[0]?.item.id).toBe("edit");
});


it("keeps a work row on a running turn whose only content so far is streaming prose", () => {
  // Without this the turn has no work row at all: no turn header, no live status, and
  // `ThreadView`'s global thinking indicator (shown when no work row is running) would come back
  // under prose the operator can watch arriving. `src/components/WorkTrace.test.tsx`'s live
  // fixture reads `rows[0]` and threw on the missing row.
  const rows = projectThread(at([user, text("streaming")]), true, []);
  expect(rows.map((r) => `${r.type}:${r.id}`)).toEqual([
    "message:u",
    "work:work:u",
    "message:streaming",
  ]);
  const live = work(rows[1]);
  expect(live).toMatchObject({ running: true, nodes: [], canCollapse: false });
  // The flag the shimmer must be gated on: an empty live work row with an answer already
  // streaming below it is not "thinking".
  expect(live.streamingAnswer).toBe(true);
  expect(
    work(projectThread(at([user, call("cmd")]), true, [])[1]).streamingAnswer,
  ).toBeUndefined();
  // A settled turn with nothing in it still produces no work row.
  expect(projectThread(at([user, text("done")]), false, []).map((r) => r.type)).toEqual([
    "message",
    "message",
  ]);
});

it("parses one Edit input once per item, and refuses an ambiguous replace_all", () => {
  const edit = item(
    "e",
    { type: "tool-call", name: "Edit" },
    JSON.stringify({ old_string: "a", new_string: "a\nb" }),
  );
  const first = editLineCounts(edit);
  expect(first).toEqual({ added: 2, removed: 1 });
  // Same object, same answer, without re-splitting the body: the cache is keyed on the item
  // `mergeHistory` hands back unchanged across refetches.
  expect(editLineCounts(edit)).toBe(first);
  const changed = { ...edit, body: JSON.stringify({ old_string: "a", new_string: "a\nb\nc" }) };
  expect(editLineCounts(changed)).toEqual({ added: 3, removed: 1 });
  // `replace_all` arrives as a bool, a string or a number depending on the caller; anything that
  // is not unambiguously false means the occurrence count is unknown.
  for (const flag of [true, "true", 1, "yes", {}])
    expect(
      editLineCounts(
        item(
          "r",
          { type: "tool-call", name: "Edit" },
          JSON.stringify({ old_string: "a", new_string: "b", replace_all: flag }),
        ),
      ),
    ).toBeUndefined();
  for (const flag of [false, "false", 0, undefined])
    expect(
      editLineCounts(
        item(
          `f-${String(flag)}`,
          { type: "tool-call", name: "Edit" },
          JSON.stringify({ old_string: "a", new_string: "b", replace_all: flag }),
        ),
      ),
    ).toEqual({ added: 1, removed: 1 });
});
