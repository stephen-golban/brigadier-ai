import { useId, useState } from "react";
import type { ReactNode } from "react";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { CopyButton } from "../Markdown";
import { PeerAttachmentPreviews } from "./PeerAttachmentPreviews";
import type { PeerData, PeerMessage } from "../../peerApi";
import type { ChatItem } from "../../workspaceApi";
import { peerDeliveryState, peerMessageContent, peerTaskTitle, type PeerOrigin } from "../../peerPresentation";
import { LinkedTaskCards } from "./LinkedTaskCards";
import { usePeerReceiptScope } from "./PeerTaskCardScope";
import "./peer.css";

function PeerBubble({ text, source, titles, onSelectSession, status, children }: {
  text: string; source: string; titles?: Record<string, string>; onSelectSession?: (id: string) => void;
  status?: string; children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const long = text.length > 200 || text.split("\n").length > 3;
  const title = peerTaskTitle(source, titles);
  return <div className="peer-message" data-author="peer">
    <div className="peer-attribution"><BotIcon size={14} aria-hidden="true" />
      <span>Sent by Brigadier from another task</span>
    </div>
    <button type="button" className="peer-source-link" disabled={!onSelectSession} onClick={() => onSelectSession?.(source)} title={title} aria-label={`Open source task: ${title}`}>{title}</button>
    <div className="peer-bubble">
      <div id={id} className={long && !expanded ? "peer-text peer-text-collapsed" : "peer-text"}>{text}</div>
      {long && <button type="button" className="peer-expand" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}<ChevronDownIcon size={14} aria-hidden="true" /></button>}
      {status && <small className="peer-delivery-status" role="status">{status}</small>}
      {children}
    </div>
    <CopyButton text={text} />
  </div>;
}

/** Authenticated delegated input uses peer attribution and has no owner edit action. */
export function PeerIncomingMessage({ item, peers, initial = false, origin, onSelectSession }: {
  item: ChatItem; peers?: PeerData; initial?: boolean; origin?: PeerOrigin; onSelectSession?: (id: string) => void;
}) {
  const { source, text } = peerMessageContent(item, peers, initial, origin);
  if (!source) return null;
  const delivery = [...(peers?.inputs ?? []), ...(peers?.messages ?? [])].find(m =>
    m.from === source && m.to === item.session_id && m.turnId === item.provider_uuid);
  return <PeerBubble key={`${item.session_id}:${item.id}`} text={text} source={source} titles={peers?.titles} onSelectSession={onSelectSession}>
    {delivery && <PeerAttachmentPreviews message={delivery} />}
  </PeerBubble>;
}

function deliveryLabel(message: PeerMessage) {
  switch (peerDeliveryState(message)) {
    case "delivered": return message.work ? "Delivered to CLI" : "Delivered as context";
    case "unknown": return "Delivery outcome unknown · inspect recipient before retrying";
    case "failed": return `Delivery failed: ${message.error}`;
    case "pending": return "Awaiting delivery confirmation";
    case "queued": return "Queued for delivery";
    case "accepted": return "Accepted in inbox";
  }
}

export function PeerDeliveryReceipt({ message, destination, children }: { message: PeerMessage; destination?: string; children?: ReactNode }) {
  return <div className="peer-outgoing" data-message-id={message.id}>
    <details><summary><span>{deliveryLabel(message)}</span>{destination && ` · ${destination}`}</summary><div className="peer-text">{message.text}</div>{children}</details>
  </div>;
}

/** Kept outside folded work: incoming queue/passive input and the sending perspective. */
export function PeerMessages({ sessionId, peers, onSelectSession, renderAttachments }: {
  sessionId: string; peers?: PeerData; onSelectSession?: (id: string) => void;
  renderAttachments?: (message: PeerMessage) => ReactNode;
}) {
  const scope = usePeerReceiptScope();
  if (!peers) return null;
  const outgoing = peers.messages.filter(m => m.from === sessionId && m.to !== sessionId);
  const targets = [...new Set(outgoing.map(m => m.to))].filter(id => !scope?.taskIds.has(id));
  return <div className="peer-messages">
    {peers.messages.filter(m => m.to === sessionId && (!m.work || !m.delivered)).map(m =>
      <PeerBubble key={`${sessionId}:${m.id}`} text={m.text} source={m.from} titles={peers.titles} onSelectSession={onSelectSession} status={deliveryLabel(m)}>{renderAttachments?.(m)}</PeerBubble>)}
    {outgoing.filter(m => !scope?.messageIds.has(m.id)).map(m =>
      <PeerDeliveryReceipt key={`${sessionId}:${m.id}`} message={m} destination={peerTaskTitle(m.to, peers.titles)}>{renderAttachments?.(m)}</PeerDeliveryReceipt>)}
    <LinkedTaskCards tasks={targets.map(id => ({ key: id, id, title: peerTaskTitle(id, peers.titles), state: "ready" }))} onSelectSession={onSelectSession} />
  </div>;
}
