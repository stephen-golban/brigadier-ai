import { useState } from "react";
import { ChatCircleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import { working } from "../attention";
import { desktopApi, notify } from "../desktopApi";
import { errorMessage } from "../workspaceApi";
import { ConfirmDialog } from "./ConfirmDialog";
export function ProjectHistory({
  projectName,
  sessions,
  titles,
  attention,
  onSelect,
  onNew,
}: {
  projectName: string;
  sessions: SessionRuntime[];
  titles: Record<string, string>;
  attention: Record<string, boolean>;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <section className="project-history">
      <header>
        <ChatCircleIcon size={28} />
        <h1>{projectName}</h1>
        <button className="act" onClick={onNew}>
          <PlusIcon />
          New session
        </button>
      </header>
      <input
        aria-label="Search session history"
        placeholder="Search past sessions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="history-list">
        {sessions
          .filter((s) =>
            (titles[s.sessionId] ?? s.sessionId)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))
          .map((s) => (
            <div key={s.sessionId}>
              <button onClick={() => onSelect(s.sessionId)}>
                <ChatCircleIcon />
                <span>
                  {titles[s.sessionId] ?? `Session ${s.sessionId.slice(-6)}`}
                  <small>
                    {s.startedAtMs
                      ? new Date(s.startedAtMs).toLocaleString()
                      : "Saved session"}{" "}
                    ·{" "}
                    {working(s)
                      ? "Working"
                      : s.status === "failed"
                        ? "Interrupted — resume when ready"
                        : "Saved"}
                  </small>
                </span>
                {working(s) && <i className="status-spinner" />}
                {attention[s.sessionId] && <i className="attention-dot" />}
              </button>
              <button
                className="icon-button"
                aria-label={`Delete session ${s.sessionId}`}
                onClick={() => setDeleting(s.sessionId)}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
      </div>
      {!sessions.length && (
        <p className="history-empty">Your past sessions will appear here.</p>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete session?"
          body="Stop this session and its workhorses, then delete their history and owned worktrees."
          confirmLabel="Delete session"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            void desktopApi
              .discard([id])
              .catch((e) => notify(errorMessage(e), true));
          }}
        />
      )}
    </section>
  );
}
