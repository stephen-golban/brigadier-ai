import { useId, useState } from "react";
import { ChevronDownIcon, MessageCircleIcon } from "lucide-react";
import { peerToolCards, type LinkedTask } from "../../peerPresentation";
import type { PeerData } from "../../peerApi";
import "./peer.css";

/** Task identities/navigation are Brigadier domain data; there is no upstream peer-card primitive. */
export function LinkedTaskCards({ tasks, onSelectSession }: {
  tasks: LinkedTask[]; onSelectSession?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!tasks.length) return null;
  const visible = expanded ? tasks : tasks.slice(0, 3);
  return <section className="peer-task-group" aria-label="Linked tasks">
    <div id={id}>
      {visible.map(task => <div className="peer-task-card" key={task.key} data-task-id={task.id}>
        <MessageCircleIcon size={17} aria-hidden="true" />
        <div className="peer-task-label">
          <span title={task.title}>{task.title}</span>
          {task.state !== "ready" && <small role="status">{task.state === "pending" ? "Creating task…" : task.state === "failed" ? task.detail ?? "Creation failed" : task.detail ?? "Creation outcome unavailable"}</small>}
        </div>
        {task.id && <button type="button" disabled={!onSelectSession} onClick={() => onSelectSession?.(task.id!)} aria-label={`Open chat: ${task.title}`}>Open chat</button>}
      </div>)}
    </div>
    {tasks.length > 3 && <button type="button" className="peer-group-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
      {expanded ? "Show fewer chats" : `Show ${tasks.length - 3} more chats`} <ChevronDownIcon size={14} aria-hidden="true" style={{ transform: expanded ? "rotate(180deg)" : undefined }} />
    </button>}
  </section>;
}

export function PeerToolCards({ name, input, result, failed, toolCallId, peers, sessionTitles, onSelectSession }: {
  name: string; input: string; result?: string; failed?: boolean; toolCallId?: string;
  peers?: PeerData; sessionTitles?: Record<string, string>; onSelectSession?: (id: string) => void;
}) {
  return <LinkedTaskCards tasks={peerToolCards(name, input, result, failed, { titles: { ...peers?.titles, ...sessionTitles } }, toolCallId)} onSelectSession={onSelectSession} />;
}
