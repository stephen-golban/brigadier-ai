/**
 * Send a turn to the selected session, and the three ways to stop one.
 *
 * Shaped like the ChatGPT macOS composer: a context strip naming the project, the working
 * directory and the model, sitting on a darker rail above a rounded box that holds the text
 * area and one action row. The action row reads left to right as the reference's does: a status
 * chip on the left, then a gap, then the controls and one solid circular send button.
 *
 * `.dock-actions .grow` is that gap and is the slot a Resume button belongs in; nothing else in
 * the row is positioned relative to it.
 *
 * Interrupt is graceful and the session survives; End asks the child to exit; Kill takes the
 * process group down and leaves no provider terminal frame behind.
 */
import { useState } from "react";

import type { SessionRuntime } from "../feedStore";
import type { SessionId } from "../wire";

export interface ComposerProps {
  session: SessionRuntime | null;
  /** The project the session belongs to, for the context strip. */
  projectName: string | null;
  onSend: (sessionId: SessionId, text: string) => void;
  onInterrupt: (sessionId: SessionId) => void;
  onEnd: (sessionId: SessionId) => void;
  onKill: (sessionId: SessionId) => void;
}

/** Last path segment, so a long cwd does not crowd the strip out. Full path stays in `title`. */
function basename(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length === 0 ? path : parts[parts.length - 1]!;
}

export function Composer({
  session,
  projectName,
  onSend,
  onInterrupt,
  onEnd,
  onKill,
}: ComposerProps) {
  const [text, setText] = useState("");
  const live = session !== null && (session.status === "running" || session.status === "starting");

  const send = () => {
    if (session === null || !live || text.trim() === "") return;
    onSend(session.sessionId, text.trim());
    setText("");
  };

  const chipClass = session === null
    ? "status-chip"
    : session.busy
      ? "status-chip warn"
      : live
        ? "status-chip live"
        : "status-chip";

  return (
    <section className="dock">
      <div className="dock-context">
        <span title={projectName ?? undefined}>
          <span className="glyph" aria-hidden="true">
            ▤
          </span>
          {projectName ?? "no project"}
        </span>
        {session?.cwd != null ? (
          <span title={session.cwd}>
            <span className="glyph" aria-hidden="true">
              ▸
            </span>
            {basename(session.cwd)}
          </span>
        ) : null}
        {session?.model != null ? (
          <span title={session.model}>
            <span className="glyph" aria-hidden="true">
              ◇
            </span>
            {session.model}
          </span>
        ) : null}
      </div>

      <div className="dock-box">
        <textarea
          rows={2}
          value={text}
          placeholder={live ? "Next turn. Cmd+Return to send." : "Select a running session"}
          disabled={!live}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <div className="dock-actions">
          <span className={chipClass}>
            {session === null
              ? "No session selected"
              : session.busy
                ? "Turn open"
                : session.status}
          </span>

          {/* Secondary action slot: a Resume button goes here, beside the status chip. */}
          <span className="grow" />

          <button
            type="button"
            className="act"
            disabled={session === null || !live}
            onClick={() => session && onInterrupt(session.sessionId)}
          >
            Interrupt
          </button>
          <button
            type="button"
            className="act"
            disabled={session === null || !live}
            onClick={() => session && onEnd(session.sessionId)}
          >
            End
          </button>
          <button
            type="button"
            className="act danger"
            disabled={session === null || !live}
            onClick={() => session && onKill(session.sessionId)}
          >
            Kill
          </button>
          <button
            type="button"
            className="send"
            aria-label="send this turn"
            disabled={!live || text.trim() === ""}
            onClick={send}
          >
            ↑
          </button>
        </div>
      </div>

      {session !== null ? (
        <div className="dock-usage">
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
