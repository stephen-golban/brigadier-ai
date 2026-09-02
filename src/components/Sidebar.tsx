/**
 * Projects, their sessions, and the selection that drives `set_visible_projects`.
 *
 * Laid out as the ChatGPT macOS app lays out its own sidebar: a title row, a short action list,
 * a "Projects" section label, then one row per project with its chats nested underneath, and an
 * account row pinned to the bottom. Ours carries the claude probe and the run id in that bottom
 * row instead of an account.
 *
 * Every session row leaves a trailing slot (`.side-meta`) and an unused second line
 * (`.side-sub`) so a branch chip can be added without moving anything else.
 *
 * "Add project" takes a path string. A native folder picker needs `tauri-plugin-dialog`, which
 * is not a dependency this phase, so it is out of scope and deliberately not faked.
 */
import { useState } from "react";
import type { ReactNode } from "react";

import type { SessionRuntime } from "../feedStore";
import type { AppInfo, ClaudeStatus, AppError, ProjectId, ProjectView, SessionId, SessionStatus } from "../wire";

export interface SidebarProps {
  projects: ProjectView[];
  sessions: Record<SessionId, SessionRuntime>;
  order: SessionId[];
  selectedProjectId: ProjectId | null;
  selectedSessionId: SessionId | null;
  /**
   * Pending approvals per project. The approvals dock shows every project's prompts at once,
   * so this badge is what says *where* one is waiting.
   */
  pendingApprovals?: Record<ProjectId, number>;
  /** Total pending, for the "Approvals" action row. */
  pendingTotal: number;
  appInfo: AppInfo | null;
  claude: ClaudeStatus | null;
  claudeError: AppError | null;
  isMock: boolean;
  /** Dev-only burn panel; rendered inside the sidebar so the feed keeps its full height. */
  dev?: ReactNode;
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

/** Session ids are UUIDs (`driver.rs:149`); the sidebar shows the tail, as the feed does. */
function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

/**
 * Branches are `brigadier/<8 hex>` (`docs/plans/ipc-contract.md` §Worktrees). The prefix is the
 * same on every row, so the chip carries only the part that differs; the full branch and the
 * worktree path are in the chip's `title`.
 */
const BRANCH_PREFIX = "brigadier/";

function shortBranch(branch: string): string {
  return branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch;
}

export function Sidebar({
  projects,
  sessions,
  order,
  selectedProjectId,
  selectedSessionId,
  pendingApprovals,
  pendingTotal,
  appInfo,
  claude,
  claudeError,
  isMock,
  dev,
  onSelectProject,
  onSelectSession,
  onAddProject,
}: SidebarProps) {
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);

  const submit = () => {
    const trimmed = path.trim();
    if (trimmed === "") return;
    onAddProject(trimmed);
    setPath("");
    setAdding(false);
  };

  const claudeLabel =
    claudeError !== null
      ? claudeError.code === "claude_not_installed" || claudeError.code === "claude_too_old"
        ? "Claude Code not found"
        : `probe_claude failed (${claudeError.code})`
      : claude === null
        ? "probing claude"
        : `claude ${claude.version}`;

  const claudeDetail =
    claudeError !== null
      ? claudeError.message
      : claude === null
        ? "checking your install"
        : claude.binary;

  return (
    <nav className="sidebar">
      <div className="sidebar-title">
        <h1>brigadier</h1>
      </div>

      <div className="sidebar-scroll">
        <button type="button" className="side-row" onClick={() => onSelectSession(null)}>
          <span className="glyph" aria-hidden="true">
            ✎
          </span>
          <span className="side-label">New session</span>
        </button>

        <div className="side-row static" aria-live="polite">
          <span className="glyph" aria-hidden="true">
            ◈
          </span>
          <span className="side-label">Approvals</span>
          <span className="side-meta">
            {pendingTotal > 0 ? (
              <span className="chip">{pendingTotal} pending</span>
            ) : (
              <span>none</span>
            )}
          </span>
        </div>

        <div className="side-section">
          <span className="grow">Projects</span>
          <button
            type="button"
            title="add a project by path"
            aria-label="add a project by path"
            onClick={() => setAdding((v) => !v)}
          >
            +
          </button>
        </div>

        {adding ? (
          <form
            className="side-add"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              value={path}
              autoFocus
              placeholder="/absolute/path/to/repo"
              onChange={(e) => setPath(e.target.value)}
            />
            <button type="submit">Add</button>
          </form>
        ) : null}

        {projects.map((p) => {
          const own = order.filter((id) => sessions[id]?.projectId === p.id);
          const selected = p.id === selectedProjectId;
          const pending = pendingApprovals?.[p.id] ?? 0;
          return (
            <div key={p.id} className="side-group">
              <button
                type="button"
                className={selected && selectedSessionId === null ? "side-row selected" : "side-row"}
                title={p.root_path}
                onClick={() => {
                  onSelectProject(p.id);
                  onSelectSession(null);
                }}
              >
                <span className="glyph" aria-hidden="true">
                  ▤
                </span>
                <span className="side-label">{p.name}</span>
                <span className="side-meta">
                  {pending > 0 ? <span className="chip">{pending}</span> : null}
                  <span>{own.length}</span>
                </span>
              </button>

              {selected
                ? own.map((id) => {
                    const s = sessions[id];
                    if (s === undefined) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={
                          id === selectedSessionId ? "side-row nested selected" : "side-row nested"
                        }
                        title={`${id} · ${STATUS_TITLE[s.status]}`}
                        onClick={() => onSelectSession(id)}
                      >
                        <span
                          className={`dot ${s.status}${s.busy ? " busy" : ""}`}
                          aria-hidden="true"
                        />
                        <span className="side-label">{shortId(id)}</span>
                        {/* Trailing slot: the branch chip, then the cost. No branch, no chip —
                            a project that is not a git repo runs in its own root. */}
                        <span className="side-meta">
                          {s.branch !== null ? (
                            <span
                              className="chip plain branch"
                              title={
                                s.worktreePath !== null
                                  ? `${s.branch} · ${s.worktreePath}${s.worktreeRemoved ? " (removed)" : ""}`
                                  : s.branch
                              }
                            >
                              {shortBranch(s.branch)}
                            </span>
                          ) : null}
                          <span>${s.costUsd.toFixed(4)}</span>
                        </span>
                      </button>
                    );
                  })
                : null}

              {selected && own.length === 0 ? <p className="side-empty">No sessions yet</p> : null}
            </div>
          );
        })}

        {projects.length === 0 ? <p className="side-empty">No projects yet</p> : null}
      </div>

      {dev !== undefined ? <div className="side-dev">{dev}</div> : null}

      <div className="side-status">
        <span className={claudeError !== null ? "avatar bad" : "avatar"} aria-hidden="true">
          {claudeError !== null ? "!" : "cc"}
        </span>
        <span className="who">
          <strong title={claudeDetail}>{claudeLabel}</strong>
          <span>
            {appInfo === null ? "starting" : `run ${appInfo.run_id} · v${appInfo.version}`}
            {isMock ? " · mock bridge" : ""}
          </span>
        </span>
      </div>
    </nav>
  );
}
