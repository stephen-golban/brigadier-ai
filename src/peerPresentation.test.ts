import { describe, expect, it } from "vitest";
import { peerMessageContent, peerToolSessions, peerToolCards, peerDeliveryState } from "./peerPresentation";
import { traceLabel } from "./threadProjection";
import type { ChatItem } from "./workspaceApi";
import type { PeerData } from "./peerApi";
const item: ChatItem = { id: "i", session_id: "target", seq: 1, at: 0, kind: { type: "user-text" }, provider_uuid: "uuid", body: 'Work request from peer session source:\n"Please check"', parent_id: null };
const peers: PeerData = { titles: {}, origins: {}, closed: [], requests: [], messages: [{ id: "m", from: "source", to: "target", text: "Please check", work: true, delivered: true, error: null, turnId: "uuid" }] };
describe("session coordination presentation", () => {
  it("attributes recorded deliveries and displays their original text", () => {
    expect(peerMessageContent(item, peers, false)).toEqual({ source: "source", text: "Please check" });
    expect(peerMessageContent(item, { ...peers, messages: [] }, false)).toEqual({ source: undefined, text: item.body });
    expect(peerMessageContent({ ...item, session_id: "other" }, peers, false).source).toBeUndefined();
    const recorded = { ...peers, messages: [{ ...peers.messages[0]!, turnId: "uuid" }] };
    expect(peerMessageContent({ ...item, provider_uuid: "owner" }, recorded, false).source).toBeUndefined();
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

it("never attributes queued prose, page-first owner input, or unrelated session turns", () => {
  expect(peerMessageContent(item, { ...peers, messages: [{ ...peers.messages[0]!, delivered: false, turnId: null }] }, false).source).toBeUndefined();
  expect(peerMessageContent(item, { ...peers, origins: { target: "source" }, messages: [] }, true).source).toBeUndefined();
  expect(peerMessageContent({ ...item, body: "Owner words", provider_uuid: "owner-turn" }, { ...peers, messages: [{ ...peers.messages[0]!, turnId: "peer-turn" }] }, true).source).toBeUndefined();
});
it("retains attribution beyond inbox trimming and JSON reload", () => {
  const saved = JSON.parse(JSON.stringify({ ...peers, messages: [], inputs: [{ ...peers.messages[0]!, turnId: "peer-turn" }] }));
  expect(peerMessageContent({ ...item, provider_uuid: "peer-turn" }, saved, false).source).toBe("source");
});
it("requires actual creation IDs and respects failed MCP envelopes", () => {
  expect(peerToolCards("mcp__brigadier__create_session", '{"title":"Audit"}')[0]).toMatchObject({ title: "Audit", state: "pending", id: undefined });
  expect(peerToolCards("mcp__brigadier__create_session", "{}", '{"ok":true,"result":{}}')[0]?.state).toBe("unknown");
  expect(peerToolCards("mcp__brigadier__create_session", '{"title":"Audit"}', JSON.stringify({content:[{type:"text",text:JSON.stringify({ok:true,result:{sessionId:"real",title:"Readable title"}})}]}))[0]).toMatchObject({id:"real",title:"Readable title",state:"ready"});
  expect(peerToolCards("mcp__brigadier__create_session", "{}", '{"isError":true,"content":[{"type":"text","text":"failure"}]}')[0]?.state).toBe("failed");
  expect(peerDeliveryState({...peers.messages[0]!, delivered:false})).toBe("queued");
});

it("never attributes an owner's copied legacy wrapper and trusts durable peer metadata after a lost ack", () => {
 const legacy = {...peers, messages:[{...peers.messages[0]!, turnId:null}]};
 expect(peerMessageContent(item, legacy, false).source).toBeUndefined();
 expect(peerMessageContent(item, legacy, false, {messageId:"m",sourceSessionId:"source"})).toEqual({source:"source",text:"Please check"});
});

it("unwraps the persisted provider tool_result content around native MCP evidence", () => {
 const result = JSON.stringify({type:"tool_result",content:JSON.stringify({content:[{type:"text",text:JSON.stringify({ok:true,result:{sessionId:"child",title:"Actual title",status:"ready"}})}]})});
 expect(peerToolCards("mcp__brigadier__create_session", "{}", result)[0]).toMatchObject({id:"child",title:"Actual title",state:"ready"});
});

it("shows an attempted send awaiting its receipt instead of delivered or accepted", () => {
 expect(peerDeliveryState({...peers.messages[0]!,delivered:false,attempted:true,work:false})).toBe("pending");
 expect(peerDeliveryState({...peers.messages[0]!,delivered:false,attempted:true,uncertain:true})).toBe("unknown");
});

it("keeps a readable prompt title and real unknown-creation reason", () => {
 const card=peerToolCards("mcp__brigadier__create_session", JSON.stringify({title:"",prompt:"Audit queued images"}), JSON.stringify({ok:true,result:{status:"unknown",error:"Restarted during creation"}}))[0];
 expect(card).toMatchObject({title:"Audit queued images",state:"unknown",detail:"Restarted during creation"});
});

it("does not call a lost creation response a definite failure", () => {
 const result=JSON.stringify({isError:true,content:[{type:"text",text:JSON.stringify({status:"unknown",error:"Connection closed before response"})}]});
 expect(peerToolCards("mcp__brigadier__create_session", "{}", result)[0]).toMatchObject({state:"unknown",detail:"Connection closed before response"});
});

it("reserves creation cards for actual creation tools while retaining inspection links", () => {
  for (const action of ["read_session", "wait_sessions", "send_message"]) {
    const input = '{"sessionId":"real"}';
    const output = '{"ok":true,"result":{"sessionId":"real","title":"Review tests"}}';
    expect(peerToolCards(`mcp__brigadier__${action}`, input, output)).toEqual([]);
    expect(peerToolSessions(input, output)).toEqual([{id:"real", title:"Review tests", status:undefined}]);
  }
});
