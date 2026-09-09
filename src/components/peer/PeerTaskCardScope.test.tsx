import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerTaskCardScope } from "./PeerTaskCardScope";
import { PeerMessages } from "./PeerMessages";
import { WorkTrace } from "../WorkTrace";
import { projectThread } from "../../threadProjection";
import type { ChatItem } from "../../workspaceApi";
import type { PeerData, PeerMessage } from "../../peerApi";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const initial: PeerMessage = { id: "creation", from: "source", to: "target", text: "Hi from first session", work: true, initial: true, delivered: true, error: null, turnId: "first-turn", attachments: [{ id: "image", projectId: "p", name: "Reference.png", mediaType: "image/png", size: 4, createdAt: 0 }] };
const peers: PeerData = { titles: { target: "First Chat Session" }, origins: {}, closed: [], requests: [], messages: [initial], inputs: [initial] };
const item = (id: string, kind: ChatItem["kind"], body: string): ChatItem => ({ id, kind, body, session_id: "source", seq: 0, at: 0, parent_id: null });
function creation(call: string) {
  return [item(call, { type: "tool-call", name: "mcp__brigadier__create_session" }, JSON.stringify({ prompt: initial.text })),
    item(`${call}:result`, { type: "tool-result", tool_call_id: call, is_error: false }, JSON.stringify({ ok: true, result: { id: "creation", sessionId: "target", title: "First Chat Session", status: "ready" } })),
    item(`${call}:answer`, { type: "assistant-text" }, "Created")];
}
const select = vi.fn();
function Harness({ data = peers, items = creation("call") }: { data?: PeerData; items?: ChatItem[] }) {
  const rows = projectThread(items, false);
  return <PeerTaskCardScope rows={rows} sessionId="source" sessionTitles={data.titles} peers={data}>
    {rows.map(row => row.type === "work" && <WorkTrace key={row.id} row={row} expanded={new Set()} toggle={() => {}} onFile={() => {}} onSelectSession={select} />)}
    <PeerMessages sessionId="source" peers={data} onSelectSession={select} renderAttachments={m => <span>Attachment for {m.id}</span>} />
  </PeerTaskCardScope>;
}

describe("peer receipt ownership", () => {
  it("shows one creation card and one initial receipt across retries, snapshot updates and reload", () => {
    const items = [...creation("call"), ...creation("retry")];
    const pending = { ...initial, delivered: false, attempted: true, turnId: null };
    const view = render(<Harness items={items} data={{ ...peers, messages: [pending], inputs: [pending] }} />);
    expect(screen.getAllByRole("button", { name: "Open chat: First Chat Session" })).toHaveLength(1);
    expect(screen.getAllByText("Awaiting delivery confirmation")).toHaveLength(1);
    view.rerender(<Harness items={items} data={JSON.parse(JSON.stringify(peers))} />);
    expect(screen.getAllByText("Delivered to CLI")).toHaveLength(1);
    expect(document.querySelectorAll('[data-message-id="creation"]')).toHaveLength(1);
    expect(screen.getAllByText("View attachment: Reference.png")).toHaveLength(1);
    expect(document.querySelectorAll('[data-task-id="target"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open chat: First Chat Session" }));
    expect(select).toHaveBeenCalledWith("target");
    view.unmount();
    render(<Harness items={items} data={JSON.parse(JSON.stringify(peers))} />);
    expect(document.querySelectorAll('[data-message-id="creation"]')).toHaveLength(1);
    expect(screen.getAllByText("View attachment: Reference.png")).toHaveLength(1);
  });

  it("preserves intentional follow-ups even with identical text and keeps their attachments", () => {
    const followup = { ...initial, id: "followup", initial: false, turnId: "second-turn" };
    render(<Harness data={{ ...peers, messages: [initial, followup], inputs: [initial, followup] }} />);
    expect(screen.getAllByText("Delivered to CLI")).toHaveLength(2);
    expect(screen.getAllByText(initial.text)).toHaveLength(2);
    expect(screen.getByText("Attachment for followup")).toBeTruthy();
    expect(document.querySelectorAll('[data-task-id="target"]')).toHaveLength(1);
  });

  it("retains receipts when the creation work row is paged out, with one destination card", () => {
    render(<Harness items={[]} data={{ ...peers, messages: [initial, { ...initial, id: "followup", initial: false }] }} />);
    expect(screen.getAllByText("Delivered to CLI")).toHaveLength(2);
    expect(document.querySelectorAll('[data-task-id="target"]')).toHaveLength(1);
    expect(screen.getByText("Attachment for creation")).toBeTruthy();
  });

  it("keeps unknown initial delivery visible and does not claim a different message by text", () => {
    render(<Harness data={{ ...peers, messages: [{ ...initial, id: "different", delivered: false, uncertain: true }], inputs: [] }} />);
    expect(screen.getByText(/Delivery outcome unknown/)).toBeTruthy();
    expect(document.querySelectorAll('[data-message-id="different"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-task-id="target"]')).toHaveLength(1);
  });
});


it("opens migrated workers as activity and keeps ordinary creations as chats", () => {
  const view = render(<Harness data={{...peers,subagents:{target:'source'}}}/>);
  expect(screen.queryByRole('button',{name:'Open chat: First Chat Session'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'View activity: First Chat Session'}));
  expect(select).toHaveBeenCalledWith('target');
  view.rerender(<Harness data={{...peers,subagents:{}}}/>);
  expect(screen.getByRole('button',{name:'Open chat: First Chat Session'})).toBeVisible();
});
