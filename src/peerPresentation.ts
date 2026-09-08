import type { PeerData } from "./peerApi";
import type { ChatItem } from "./workspaceApi";

/** Attribution comes from the app's authenticated delivery record, not a prose prefix. */
export function peerMessageContent(item: ChatItem, peers: PeerData | undefined, initial: boolean) {
  const delivery = peers?.messages.find((m) =>
    m.work && m.to === item.session_id &&
    (m.turnId ? m.turnId === item.provider_uuid :
      item.body === `Work request from peer session ${m.from}:\n${JSON.stringify(m.text)}`),
  );
  return {
    source: delivery?.from ?? (initial ? peers?.origins[item.session_id] : undefined),
    text: delivery?.text ?? item.body.split("\n\nBrigadier exposes native MCP tools:")[0]!,
  };
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
    if (v.type === "text" && typeof v.text === "string") visit(parse(v.text), depth + 1);
  };
  visit(parse(input));
  visit(parse(output));
  return [...found.values()];
}
