/**
 * Projects, their sessions nested underneath, and the selection that drives
 * `set_visible_projects`.
 *
 * This is `docs/vision.md` §9's sketch, built rather than approximated:
 *
 *   - **Projects collapse.** A caret owns the expand/collapse; the rest of the row selects. The
 *     two are sibling buttons inside one pill, because a button inside a button is invalid HTML
 *     and because collapsing a project you are not looking at must not steal the selection.
 *   - **A collapsed project still carries a run marker.** §9 calls this the load-bearing
 *     behaviour: work in a project you are not looking at is never invisible. The marker is a
 *     `role="img"` with an accessible name, so it is assertable without touching a class name.
 *   - **A collapsed project shows its session count** — §9's "finished projects collapse to one
 *     line with a count".
 *   - **A collapsed project that holds the session on screen says so**, with a marker that is
 *     deliberately not the run marker. §9 makes "work you are not looking at is never invisible"
 *     load-bearing for *running* work; the thread you are actually reading deserves the same, and
 *     a sidebar that disowns what fills the main panel is disorienting. "Something is running in
 *     here" and "the thing you are reading is in here" are different facts, so they get different
 *     shapes: a round green dot and a straight accent rail.
 *   - **Default openness is derived, never forced.** Open when the project is selected or has a
 *     live session; closed otherwise. An explicit caret click overrides that for the rest of the
 *     window's life. Nothing ever collapses under the user's hands.
 *
 * **Sessions are labelled by branch, never by path** (`docs/plans/ipc-contract.md`: "Rendered
 * instead of the path"). The branch is `brigadier/<8 hex>`, so the shared prefix is drawn muted
 * and the eight hex digits carry the row's weight — the part that differs is the part that reads.
 * A project that is not a git repo has no branch and falls back to the session id's tail. The
 * path, the status and the accumulated cost all live in the row's `title`; **no dollar figure is
 * drawn**, because `docs/vision.md` §6 settles that windows are the gauge and a per-row
 * `$0.0000` is a number the user is never billed.
 *
 * Per-row memoization is Jan's `NavCowork.tsx:51` pattern (`docs/research/jan.md` §6): each row
 * is its own memoized component rather than inlined in a `.map`, so one busy session's tick does
 * not re-render the whole list. `feedStore.patch` replaces a `SessionRuntime` rather than
 * mutating it, so object identity is exactly the right memo key.
 *
 * Icons are inline SVG. No icon library: W4-C permits no new dependency, and three geometric
 * primitives are not worth 40 kB.
 *
 * "Add project" takes a path string. A native folder picker needs `tauri-plugin-dialog`, which
 * is not a dependency this phase, so it is out of scope and deliberately not faked.
 *
 * **The window gauge from §9 is deliberately absent.** `rate_limit_event` decodes in
 * `crates/claude-wire/src/message.rs` but nothing carries `unifiedWindows` to the webview — it
 * appears nowhere in `src/wire.ts`, `src/bridge.ts` or `src-tauri/src/views.rs`. Plumbing it is
 * W2-C's. A bar drawn from no reading would be invented progress, so there is no bar, no zero
 * and no placeholder dash.
 */
import { memo, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { SessionRuntime } from "../feedStore";
import type {
  AppError,
  AppInfo,
  ClaudeStatus,
  ProjectId,
  ProjectView,
  SessionId,
  SessionStatus,
} from "../wire";

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

/** `starting` and `running` are both "something is happening in here". */
const LIVE: Record<SessionStatus, boolean> = {
  starting: true,
  running: true,
  exited: false,
  failed: false,
};

const STATUS_WORD: Record<SessionStatus, string> = {
  starting: "starting",
  running: "running",
  exited: "ended",
  failed: "failed",
};

/**
 * What a row announces. A running session with an open turn says "working", not "running" — the
 * same fact the dot's pulse carries, in the one channel a pulse has none: a colour that breathes
 * is invisible to a screen reader and to anyone who has asked for reduced motion, and the CSS
 * animation itself is not something a test can observe.
 */
function statusWord(status: SessionStatus, busy: boolean): string {
  return busy && status === "running" ? "working" : STATUS_WORD[status];
}

/** Session ids are UUIDs (`driver.rs:149`); the tail is what the feed shows too. */
function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

/** Branches are `brigadier/<8 hex>` (`docs/plans/ipc-contract.md` §Worktrees). */
const BRANCH_PREFIX = "brigadier/";

/* ------------------------------------------------------------------ icons */

/** The disclosure chevron. Rotated 90° by CSS when the group is open. */
function CaretIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
      <path
        d="M3.75 1.75 7 5 3.75 8.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M7 2.5v9M2.5 7h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Approvals: the one thing in this app that stops and waits for a person. */
function AskIcon() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 4.2v3.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="9.6" r="0.75" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------------------------------------- session row */

interface SessionRowProps {
  session: SessionRuntime;
  selected: boolean;
  onSelect: (id: SessionId) => void;
}

/**
 * One session. Memoized on the `SessionRuntime` reference, which `feedStore` replaces only when
 * that session actually changed — so a project with ten live sessions re-renders one row per
 * tick, not ten.
 */
const SessionRow = memo(function SessionRow({ session, selected, onSelect }: SessionRowProps) {
  const branch = session.branch;
  const prefix = branch !== null && branch.startsWith(BRANCH_PREFIX) ? BRANCH_PREFIX : null;
  const name =
    branch === null ? shortId(session.sessionId) : prefix === null ? branch : branch.slice(prefix.length);

  const detail = [
    session.sessionId,
    statusWord(session.status, session.busy),
    session.model ?? undefined,
    session.worktreePath ?? session.cwd ?? undefined,
    session.worktreeRemoved ? "worktree removed" : undefined,
    session.costUsd > 0 ? `$${session.costUsd.toFixed(4)}` : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(" · ");

  return (
    <button
      type="button"
      className={selected ? "side-session selected" : "side-session"}
      title={detail}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(session.sessionId)}
    >
      <span
        className={`dot ${session.status}${session.busy ? " busy" : ""}`}
        aria-hidden="true"
      />
      <span className="side-branch">
        {prefix !== null ? <span className="prefix">{prefix}</span> : null}
        <span className="ref">{name}</span>
      </span>
      <span className="sr-only">{statusWord(session.status, session.busy)}</span>
      {session.status === "failed" ? <span className="side-flag" aria-hidden="true">failed</span> : null}
    </button>
  );
});

/* ----------------------------------------------------------------- sidebar */

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
  /** Explicit caret clicks only. An id absent here uses the derived default below. */
  const [openOverride, setOpenOverride] = useState<Record<ProjectId, boolean>>({});

  /** Sessions per project, in the store's own newest-first order, computed once per commit. */
  const byProject = useMemo(() => {
    const map = new Map<ProjectId, SessionId[]>();
    for (const id of order) {
      const projectId = sessions[id]?.projectId;
      if (projectId == null) continue;
      const list = map.get(projectId);
      if (list === undefined) map.set(projectId, [id]);
      else list.push(id);
    }
    return map;
  }, [order, sessions]);

  const submit = () => {
    const trimmed = path.trim();
    if (trimmed === "") return;
    onAddProject(trimmed);
    setPath("");
    setAdding(false);
  };

  // Stable across renders so `SessionRow`'s memo is not defeated by a fresh closure per commit.
  const selectSession = useCallback(
    (id: SessionId) => {
      onSelectSession(id);
    },
    [onSelectSession],
  );

  const toggle = useCallback((id: ProjectId, next: boolean) => {
    setOpenOverride((prev) => ({ ...prev, [id]: next }));
  }, []);

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
    <nav className="sidebar" aria-label="Projects and sessions">
      <div className="sidebar-brand">
        <h1>brigadier</h1>
      </div>

      <div className="sidebar-scroll">
        <button type="button" className="side-new" onClick={() => onSelectSession(null)}>
          <PlusIcon />
          <span className="side-label">New session</span>
        </button>

        <div className={pendingTotal > 0 ? "side-nav waiting" : "side-nav"} aria-live="polite">
          <AskIcon />
          <span className="side-label">Approvals</span>
          {pendingTotal > 0 ? <span className="chip">{pendingTotal} waiting</span> : null}
        </div>

        <div className="side-section">
          <span className="grow">Projects</span>
          <button
            type="button"
            className="side-section-add"
            title="add a project by path"
            aria-label="add a project by path"
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
          >
            <PlusIcon />
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
              aria-label="project path"
              onChange={(e) => setPath(e.target.value)}
            />
            <button type="submit">Add</button>
          </form>
        ) : null}

        {projects.map((p) => {
          const own = byProject.get(p.id) ?? [];
          const selected = p.id === selectedProjectId;
          const pending = pendingApprovals?.[p.id] ?? 0;
          const running = own.reduce((n, id) => {
            const s = sessions[id];
            return s !== undefined && LIVE[s.status] ? n + 1 : n;
          }, 0);
          // Derived default, overridden only by an explicit caret click: open while this project
          // is selected or has something live in it, closed once it is neither. §9's "finished
          // projects collapse to one line with a count", without ever folding a group the user
          // is reading.
          const open = openOverride[p.id] ?? (selected || running > 0);
          const listId = `sessions-${p.id}`;
          // The thread on screen lives in here, and the group is folded, so nothing else in the
          // sidebar says so. Distinct from the run marker on purpose: "something is running in
          // here" and "the thing you are reading is in here" are different facts and must not
          // collapse into one indicator.
          const holds =
            !open && selectedSessionId !== null && own.includes(selectedSessionId);
          const rowClass = [
            "side-project",
            selected && selectedSessionId === null ? "selected" : null,
            holds ? "holds" : null,
          ]
            .filter((c) => c !== null)
            .join(" ");

          return (
            <div key={p.id} className="side-group">
              <div className={rowClass}>
                <button
                  type="button"
                  className="side-caret"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-label={`${open ? "collapse" : "expand"} ${p.name}`}
                  onClick={() => toggle(p.id, !open)}
                >
                  <CaretIcon />
                </button>
                <button
                  type="button"
                  className="side-project-btn"
                  title={p.root_path}
                  onClick={() => {
                    onSelectProject(p.id);
                    onSelectSession(null);
                    toggle(p.id, true);
                  }}
                >
                  <span className="side-label">{p.name}</span>
                  <span className="side-meta">
                    {pending > 0 ? <span className="chip">{pending}</span> : null}
                    {running > 0 ? (
                      <span
                        className="dot running"
                        role="img"
                        aria-label={`${running} running`}
                        title={`${running} running`}
                      />
                    ) : null}
                    {holds ? (
                      <span
                        className="side-holds"
                        role="img"
                        aria-label="holds the open session"
                        title="holds the open session"
                      />
                    ) : null}
                    {!open && own.length > 0 ? (
                      <span className="side-count">{own.length}</span>
                    ) : null}
                  </span>
                </button>
              </div>

              {open ? (
                <div className="side-sessions" id={listId}>
                  {own.map((id) => {
                    const s = sessions[id];
                    if (s === undefined) return null;
                    return (
                      <SessionRow
                        key={id}
                        session={s}
                        selected={id === selectedSessionId}
                        onSelect={selectSession}
                      />
                    );
                  })}
                  {own.length === 0 ? <p className="side-empty">No sessions yet</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}

        {projects.length === 0 ? (
          <p className="side-empty first">Add a repository path to begin.</p>
        ) : null}
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
