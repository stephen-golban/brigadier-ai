/**
 * Send a turn to the selected session, and the three ways to stop one.
 *
 * Interrupt is graceful and the session survives; End asks the child to exit; Kill takes the
 * process group down and leaves no provider terminal frame behind.
 */
import { useState } from "react";

import type { SessionRuntime } from "../feedStore";
import type { SessionId } from "../wire";

export interface ComposerProps {
  session: SessionRuntime | null;
  onSend: (sessionId: SessionId, text: string) => void;
  onInterrupt: (sessionId: SessionId) => void;
  onEnd: (sessionId: SessionId) => void;
  onKill: (sessionId: SessionId) => void;
}

export function Composer({ session, onSend, onInterrupt, onEnd, onKill }: ComposerProps) {
  const [text, setText] = useState("");
  const live = session !== null && (session.status === "running" || session.status === "starting");

  const send = () => {
    if (session === null || !live || text.trim() === "") return;
    onSend(session.sessionId, text.trim());
    setText("");
  };

  return (
    <section className="composer">
      <header className="pane-head">
        <span>composer</span>
        <span className="dim">
          {session === null
            ? "no session selected"
            : `${session.sessionId} · ${session.status}${session.busy ? " · turn open" : ""}`}
        </span>
      </header>
      <textarea
        rows={3}
        value={text}
        placeholder={live ? "next turn… (⌘↵ to send)" : "select a running session"}
        disabled={!live}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      <div className="row">
        <button type="button" className="ok" disabled={!live || text.trim() === ""} onClick={send}>
          send
        </button>
        <button
          type="button"
          disabled={session === null || !live}
          onClick={() => session && onInterrupt(session.sessionId)}
        >
          interrupt
        </button>
        <button
          type="button"
          disabled={session === null || !live}
          onClick={() => session && onEnd(session.sessionId)}
        >
          end
        </button>
        <button
          type="button"
          className="danger"
          disabled={session === null || !live}
          onClick={() => session && onKill(session.sessionId)}
        >
          kill
        </button>
      </div>
      {session !== null ? (
        <div className="usage dim">
          ${session.costUsd.toFixed(4)} · {session.usage.input_tokens} in /{" "}
          {session.usage.output_tokens} out · cache {session.usage.cache_read_tokens} read /{" "}
          {session.usage.cache_creation_tokens} write · rows {session.rowsTotal}
          {session.rowsDropped > 0 ? ` (${session.rowsDropped} dropped)` : ""}
          {session.lastMessage !== null ? ` · ${session.lastMessage}` : ""}
        </div>
      ) : null}
    </section>
  );
}
