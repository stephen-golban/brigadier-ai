/**
 * Projects, their sessions, and the selection that drives `set_visible_projects`.
 *
 * "Add project" takes a path string. A native folder picker needs `tauri-plugin-dialog`, which
 * is not a dependency this phase, so it is out of scope and deliberately not faked.
 */
import { useState } from "react";

import type { SessionRuntime } from "../feedStore";
import type { ProjectId, ProjectView, SessionId, SessionStatus } from "../wire";

export interface SidebarProps {
  projects: ProjectView[];
  sessions: Record<SessionId, SessionRuntime>;
  order: SessionId[];
  selectedProjectId: ProjectId | null;
  selectedSessionId: SessionId | null;
  /**
   * Pending approvals per project. The approvals panel shows every project's prompts at once,
   * so this badge is what says *where* one is waiting.
   */
  pendingApprovals?: Record<ProjectId, number>;
  onSelectProject: (id: ProjectId) => void;
  onSelectSession: (id: SessionId | null) => void;
  onAddProject: (path: string) => void;
}

const STATUS_TITLE: Record<SessionStatus, string> = {
  starting: "starting",
  running: "running",
  exited: "exited",
  failed: "failed",
};

export function Sidebar({
  projects,
  sessions,
  order,
  selectedProjectId,
  selectedSessionId,
  pendingApprovals,
  onSelectProject,
  onSelectSession,
  onAddProject,
}: SidebarProps) {
  const [path, setPath] = useState("");

  const submit = () => {
    const trimmed = path.trim();
    if (trimmed === "") return;
    onAddProject(trimmed);
    setPath("");
  };

  return (
    <nav className="sidebar">
      <header className="pane-head">
        <span>projects</span>
        <span className="dim">{projects.length}</span>
      </header>

      <div className="sidebar-body">
        {projects.map((p) => {
          const own = order.filter((id) => sessions[id]?.projectId === p.id);
          const selected = p.id === selectedProjectId;
          const pending = pendingApprovals?.[p.id] ?? 0;
          return (
            <div key={p.id} className={selected ? "project selected" : "project"}>
              <button
                type="button"
                className="project-head"
                onClick={() => {
                  onSelectProject(p.id);
                  onSelectSession(null);
                }}
              >
                <span className="project-name">{p.name}</span>
                <span style={{ display: "inline-flex", gap: 6 }}>
                  {pending > 0 ? (
                    <span className="badge">{pending} pending</span>
                  ) : null}
                  <span className="dim">{own.length}</span>
                </span>
              </button>
              <div className="project-path dim">{p.root_path}</div>
              {selected ? (
                <ul className="sessions">
                  <li>
                    <button
                      type="button"
                      className={selectedSessionId === null ? "session selected" : "session"}
                      onClick={() => onSelectSession(null)}
                    >
                      <span className="dot all" />
                      <span className="session-id">all sessions</span>
                    </button>
                  </li>
                  {own.map((id) => {
                    const s = sessions[id];
                    if (s === undefined) return null;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          className={id === selectedSessionId ? "session selected" : "session"}
                          onClick={() => onSelectSession(id)}
                        >
                          <span
                            className={`dot ${s.status}${s.busy ? " busy" : ""}`}
                            title={STATUS_TITLE[s.status]}
                          />
                          <span className="session-id">{id}</span>
                          <span className="cost dim">${s.costUsd.toFixed(4)}</span>
                        </button>
                      </li>
                    );
                  })}
                  {own.length === 0 ? <li className="empty">no sessions</li> : null}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>

      <form
        className="add-project"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={path}
          placeholder="/absolute/path/to/repo"
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit">add</button>
      </form>
    </nav>
  );
}
