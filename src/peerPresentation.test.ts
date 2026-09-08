import { describe, expect, it } from "vitest";
import { peerMessageContent, peerToolSessions } from "./peerPresentation";
import { traceLabel } from "./threadProjection";
import type { ChatItem } from "./workspaceApi";
import type { PeerData } from "./peerApi";
const item: ChatItem = { id: "i", session_id: "target", seq: 1, at: 0, kind: { type: "user-text" }, body: 'Work request from peer session source:\n"Please check"', parent_id: null };
const peers: PeerData = { titles: {}, origins: {}, closed: [], requests: [], messages: [{ id: "m", from: "source", to: "target", text: "Please check", work: true, delivered: true, error: null }] };
describe("session coordination presentation", () => {
  it("attributes recorded deliveries and displays their original text", () => {
    expect(peerMessageContent(item, peers, false)).toEqual({ source: "source", text: "Please check" });
    expect(peerMessageContent(item, { ...peers, messages: [] }, false)).toEqual({ source: undefined, text: item.body });
    expect(peerMessageContent({ ...item, session_id: "other" }, peers, false).source).toBeUndefined();
    const recorded = { ...peers, messages: [{ ...peers.messages[0]!, turnId: "uuid" }] };
    expect(peerMessageContent(item, recorded, false).source).toBeUndefined();
    expect(peerMessageContent({ ...item, provider_uuid: "uuid" }, recorded, false).source).toBe("source");
  });
  it("links wait targets and unwraps MCP results without traversing message content", () => {
    const output = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ok: true, result: { sessions: [{ sessionId: "b", title: "Review", status: "Idle", messages: [{ id: "not-a-session" }] }] } }) }] });
    expect(peerToolSessions('{"targets":[{"sessionId":"b"}]}', output)).toEqual([{ id: "b", title: "Review", status: "Idle" }]);
    expect(peerToolSessions("invalid", "invalid")).toEqual([]);
    expect(peerToolSessions("{}", JSON.stringify({ result: [{ id: "message-id", from: "a", to: "b", text: "hello" }] })))
      .toEqual([{ id: "a" }, { id: "b" }]);
  });
  it("uses readable coordination labels in assistant-ui activity", () => {
    expect(traceLabel({ ...item, kind: { type: "tool-call", name: "mcp__brigadier__wait_sessions" } })).toBe("Wait for sessions");
    expect(traceLabel({ ...item, kind: { type: "tool-call", name: "mcp__brigadier__send_message" } })).toBe("Sent message to session");
  });
});
