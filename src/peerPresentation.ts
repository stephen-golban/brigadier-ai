import type { PeerData } from "./peerApi";
import type { ChatItem } from "./workspaceApi";

/** Only authenticated persisted records confer peer authorship. A page's first row
 * is not necessarily the session's initial prompt (pagination/session switches). */
export interface PeerOrigin { messageId: string; sourceSessionId: string }
export function peerMessageContent(item: ChatItem, peers: PeerData | undefined, _initial: boolean, origin?: PeerOrigin) {
  const delivery = [...(peers?.inputs ?? []), ...(peers?.messages ?? [])].find((m) =>
    m.work && m.to === item.session_id &&
    (origin ? m.id === origin.messageId && m.from === origin.sourceSessionId :
      !!m.turnId && m.turnId === item.provider_uuid),
  );
  return { source: origin?.sourceSessionId ?? delivery?.from, text: delivery?.text ?? item.body };
}

export function peerTaskTitle(id: string, titles?: Record<string, string>, title?: string) {
  return titles?.[id]?.trim() || title?.trim() || `Task ${id.slice(0, 8)}`;
}

export function peerDeliveryState(message: import("./peerApi").PeerMessage) {
  if (message.delivered) return "delivered";
  if (message.uncertain) return "unknown";
  if (message.error) return "failed";
  if (message.attempted) return "pending";
  return message.work ? "queued" : "accepted";
}

export interface LinkedTask {
  key: string;
  id?: string;
  title: string;
  state: "pending" | "ready" | "failed" | "unknown";
  detail?: string;
  /** Durable initial delivery ID returned by create_session. */
  messageId?: string;
}

/** Tool completion is evidence of creation only when a real session ID was returned. */
export function peerToolCards(name: string, input: string, output?: string, failed = false,
  peers?: Pick<PeerData, "titles">, toolCallId = "peer-tool"): LinkedTask[] {
  if (!name.startsWith("mcp__brigadier__")) return [];
  const action = name.slice("mcp__brigadier__".length);
  if (action !== "create_session") return [];
  const args = parse(input);
  const envelope = unwrap(parse(output));
  const error = failed || envelope.ok === false || envelope.isError === true;
  const result = (envelope.result && typeof envelope.result === "object" ? envelope.result : envelope) as Record<string, unknown>;
  const id = typeof result.sessionId === "string" && result.sessionId ? result.sessionId : undefined;
  const title = typeof result.title === "string" && result.title.trim() ? result.title : typeof args.title === "string" && args.title.trim() ? args.title : typeof args.prompt === "string" ? args.prompt.split("\n")[0]!.slice(0, 100) : "Create task";
  return [{ key: toolCallId, id, messageId: typeof result.id === "string" ? result.id : undefined, title: id ? peerTaskTitle(id, peers?.titles, title) : title,
    state: result.status === "unknown" ? "unknown" : error || result.status === "failed" ? "failed" : id ? "ready" : output === undefined || result.status === "pending" ? "pending" : "unknown",
    detail: error || result.status === "failed" || result.status === "unknown" ? (typeof result.error === "string" ? result.error : typeof envelope.error === "string" ? envelope.error : "Task creation failed") : undefined }];
}

function unwrap(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 6) return value;
  if (typeof value.content === "string") {
    const nested = parse(value.content);
    if (Object.keys(nested).length) return { ...unwrap(nested, depth + 1), isError: value.is_error === true || value.isError === true || nested.isError === true };
  }
  if (Array.isArray(value.content)) {
    for (const part of value.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        const nested = parse(part.text);
        if (Object.keys(nested).length) return { ...unwrap(nested, depth + 1), isError: value.is_error === true || value.isError === true || nested.isError === true };
      }
    }
  }
  return value;
}

function parse(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text.slice(text.indexOf("{")));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Accept both saved JSON results and MCP text envelopes, retaining the raw disclosure. */
export function peerToolSessions(input: string, output?: string) {
  const found = new Map<string, { id: string; title?: string; status?: string }>();
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value)) { value.slice(0, 200).forEach((v) => visit(v, depth + 1)); return; }
    const v = value as Record<string, unknown>;
    const id = v.sessionId ?? (("projectId" in v || "live" in v) ? v.id : undefined);
    if (typeof v.from === "string" && typeof v.to === "string") {
      for (const peer of [v.from, v.to]) {
        if (peer.length <= 200 && !found.has(peer)) found.set(peer, { id: peer });
      }
    }
    if (typeof id === "string" && id.length <= 200) {
      found.set(id, { id, title: typeof v.title === "string" ? v.title : found.get(id)?.title, status: typeof v.status === "string" ? v.status : found.get(id)?.status });
    }
    for (const key of ["result", "sessions", "targets", "content"]) visit(v[key], depth + 1);
    if (typeof v.content === "string") visit(parse(v.content), depth + 1);
    if (v.type === "text" && typeof v.text === "string") visit(parse(v.text), depth + 1);
  };
  visit(parse(input));
  visit(parse(output));
  return [...found.values()];
}
