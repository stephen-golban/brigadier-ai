import { readActivity, type AgentActivity } from "../sessionApi";
import { RewindHistory } from "./RewindHistory";
import { useEffect, useRef, useState } from "react";
import {
  FolderIcon,
  GitBranchIcon,
  GitDiffIcon,
  SlidersHorizontalIcon,
  UsersThreeIcon,
  ArrowSquareOutIcon,
  GearSixIcon,
} from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import type { PeerData } from "../peerApi";
import { useSessionChanges } from "../desktopApi";
import { working } from "../attention";
export function SessionCard({
  session,
  sessions,
  peers,
  onSelect,
  onChanges,
  onSettings,
}: {
  session: SessionRuntime;
  sessions: Record<string, SessionRuntime>;
  peers: PeerData;
  onSelect: (id: string) => void;
  onChanges: () => void;
  onSettings: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [savedHistory, setSavedHistory] = useState(false);
  const [native, setNative] = useState<AgentActivity | null>(null);
  useEffect(() => {
    setNative(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await readActivity(session.sessionId);
        if (live) setNative(next);
      } catch {
      } finally {
        if (live) timer = setTimeout(read, 3000);
      }
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session.sessionId]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const click = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", click);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", click);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  const changes = useSessionChanges(session.sessionId);
  const ids = new Set([session.sessionId]);
  let previous = 0;
  while (previous !== ids.size) {
    previous = ids.size;
    for (const [id, parent] of Object.entries(peers.origins))
      if (ids.has(parent)) ids.add(id);
  }
  ids.delete(session.sessionId);
  const agents = [...ids].map((id) => sessions[id]).filter(Boolean);
  const added = changes.files.reduce((n, f) => n + f.added, 0),
    deleted = changes.files.reduce((n, f) => n + f.deleted, 0);
  return (
    <div ref={host} className={`session-environment ${open ? "is-open" : ""}`}>
      <button
        className="icon-button environment-trigger"
        aria-label="Environment and agents"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <SlidersHorizontalIcon size={19} />
      </button>
      <aside className="session-card" aria-label="Session environment">
        <h3>Environment</h3>
        <button onClick={onChanges}>
          <GitDiffIcon />
          <span>Changes</span>
          <span className="change-count">
            <i className="added">+{added.toLocaleString()}</i>{" "}
            <i className="removed">−{deleted.toLocaleString()}</i>
          </span>
        </button>
        <div title={session.cwd ?? undefined}>
          <FolderIcon />
          <span>{session.worktreePath ? "Worktree" : "Project folder"}</span>
        </div>
        <div title={session.branch ?? undefined}>
          <GitBranchIcon />
          <span>{session.branch ?? "No Git branch"}</span>
        </div>
        <button onClick={onSettings}>
          <GearSixIcon />
          <span>Session settings</span>
        </button>
        <button onClick={() => setSavedHistory(true)}>
          <ArrowSquareOutIcon />
          <span>Saved history</span>
        </button>
        <section>
          <h3>Agents</h3>
          {native?.agents.map((agent) => (
            <details key={agent.id}>
              <summary>
                {agent.description || agent.id}
                <small>{agent.status}</small>
              </summary>
              <p>{agent.action || "No action reported"}</p>
              {agent.model && <small>{agent.model}</small>}
            </details>
          ))}
          {agents.length
            ? agents.map((agent) => (
                <button
                  key={agent.sessionId}
                  onClick={() => onSelect(agent.sessionId)}
                >
                  <UsersThreeIcon />
                  <span>
                    {peers.titles[agent.sessionId] ??
                      `Session ${agent.sessionId.slice(-6)}`}
                  </span>
                  {working(agent) ? (
                    <i className="status-spinner" aria-label="Working" />
                  ) : (
                    <small>
                      {agent.status === "failed" ? "Interrupted" : "Done"}
                    </small>
                  )}
                </button>
              ))
            : !native?.agents.length && <p>No workhorses yet</p>}
        </section>
        <section>
          <h3>Sources</h3>
          <div title={session.cwd ?? undefined}>
            <FolderIcon />
            <span>{session.cwd?.split("/").pop() ?? "Project files"}</span>
          </div>
          {peers.origins[session.sessionId] && (
            <button onClick={() => onSelect(peers.origins[session.sessionId]!)}>
              <ArrowSquareOutIcon />
              <span>Source session</span>
            </button>
          )}
        </section>
      </aside>
      {savedHistory && (
        <RewindHistory
          sessionId={session.sessionId}
          onClose={() => setSavedHistory(false)}
        />
      )}
    </div>
  );
}
