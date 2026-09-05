import { describe, expect, it } from "vitest";
import {
  flattenTrace,
  projectThread,
  type ThreadRow,
} from "./threadProjection";
import type { ChatItem } from "./workspaceApi";

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
  it("folds progress and tool output while preserving every final text block", () => {
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
  it("keeps unfinished progress inside work and separates successive user turns", () => {
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
    expect(rows.map((r) => r.type)).toEqual([
      "message",
      "work",
      "message",
      "message",
      "work",
    ]);
    expect(work(rows[1]).running).toBe(false);
    expect(work(rows[4]).running).toBe(true);
    expect(work(rows[4]).nodes.map((n) => n.item.id)).toEqual([
      "next",
      "still working",
    ]);
  });
  it("does not promote pre-tool progress to a final answer after interruption", () => {
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
