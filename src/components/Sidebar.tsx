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
 *     shapes: a round green dot and a straight accent bar, side by side in the same trailing slot
 *     as the count. One element draws each fact, once.
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
 * **"Add project" opens a native directory picker** (`tauri-plugin-dialog`, added 2026-09-04;
 * `docs/research/tauri-dialog.md`). The typed-path field it replaces is still here and still
 * works, but it is now the *fallback*, reached in exactly two situations: a browser, where there
 * is no Tauri window and therefore no picker (`onPickProject` is undefined and the button toggles
 * the field instead), and a picker that errored, where the field is opened automatically so the
 * owner is never left with no way to add a project at all.
 *
 * `add_project` in Rust is the only validator — non-directory and non-repository-root are its
 * refusals — so nothing here checks the path. What this file does do is **draw the refusal beside
 * the control that caused it**: a path typed into a field and rejected by a banner at the other
 * end of the window is a puzzle, not a message.
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
  /**
   * Add a project by typed path — the fallback. Resolves to the `AppError` `add_project` refused
   * with, or `null` on success, so the refusal can be drawn beside the field. `void` is accepted
   * so a caller that reports errors some other way is still a valid one.
   */
  onAddProject: (path: string) => void | Promise<AppError | null>;
  /**
   * Open the native directory picker and add whatever comes back — the primary path.
   * **Undefined means there is no picker in this runtime** (a browser), and the "+" falls back to
   * revealing the typed-path field. Resolves `null` both on success and on a *cancelled* picker;
   * a cancel is not an error (`docs/research/tauri-dialog.md` §2).
   */
  onPickProject?: () => Promise<AppError | null>;
  /**
   * Reveal a path in Finder. Undefined outside a Tauri window, and the reveal controls are then
   * not drawn at all rather than drawn dead.
   */
  onReveal?: (path: string) => void;
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

/** Reveal in Finder: an arrow leaving an open corner. House style — square viewBox, `fill="none"`,
 *  `currentColor`, `aria-hidden` because the button beside it carries the accessible name. */
function RevealIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M6.6 2.2h3.2v3.2M9.8 2.2 5.9 6.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.2 7.4v1.9a.9.9 0 0 1-.9.9H2.9a.9.9 0 0 1-.9-.9V4.7a.9.9 0 0 1 .9-.9h1.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------- session row */

interface SessionRowProps {
  session: SessionRuntime;
  selected: boolean;
  onSelect: (id: SessionId) => void;
  /** Undefined outside a Tauri window; see `SidebarProps.onReveal`. */
  onReveal?: (path: string) => void;
}

/**
 * One session. Memoized on the `SessionRuntime` reference, which `feedStore` replaces only when
 * that session actually changed — so a project with ten live sessions re-renders one row per
 * tick, not ten.
 */
const SessionRow = memo(function SessionRow({
  session,
  selected,
  onSelect,
  onReveal,
}: SessionRowProps) {
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

  // Null whenever the project is not a git repository (contract §Worktrees). There is then
  // nothing to reveal, so the control is **absent** rather than present-and-inert: a disabled
  // button still says "there is a folder here, you just cannot have it", which would be a lie.
  const worktree = session.worktreePath;

  return (
    <div className={selected ? "side-session selected" : "side-session"}>
      <button
        type="button"
        className="side-session-btn"
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
      {onReveal !== undefined && worktree !== null ? (
        <button
          type="button"
          className="side-reveal"
          title={`reveal ${worktree} in Finder`}
          aria-label={`reveal ${name} worktree in Finder`}
          onClick={() => onReveal(worktree)}
        >
          <RevealIcon />
        </button>
      ) : null}
    </div>
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
  onPickProject,
  onReveal,
}: SidebarProps) {
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);
  /** `add_project`'s own refusal, drawn under the control that produced it. */
  const [addError, setAddError] = useState<string | null>(null);
  /** A picker is open. The button goes inert so a second click cannot stack two dialogs. */
  const [picking, setPicking] = useState(false);
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

  /**
   * The typed-path fallback. On a refusal the field keeps both the text and the focus and the
   * message appears under it — retyping an absolute path because a banner ate it is the exact
   * friction this order exists to remove.
   */
  const submit = async () => {
    const trimmed = path.trim();
    if (trimmed === "") return;
    const err = await onAddProject(trimmed);
    if (err != null) {
      setAddError(`${err.code}: ${err.message}`);
      return;
    }
    setAddError(null);
    setPath("");
    setAdding(false);
  };

  /**
   * The native picker. Three outcomes, and they are deliberately not collapsed:
   *
   *   - a path was chosen and accepted — nothing to draw, the project is in the list;
   *   - **the picker was cancelled** — `onPickProject` resolves `null`, identical to success from
   *     here, and nothing is added, said or opened. A cancel is not an error;
   *   - it failed, or `add_project` refused the folder — the message appears *and* the typed
   *     field opens, so a permission the capability is missing does not leave the owner with no
   *     route to adding a project.
   */
  const pick = async () => {
    if (onPickProject === undefined) return;
    setPicking(true);
    let err: AppError | null;
    try {
      err = await onPickProject();
    } finally {
      setPicking(false);
    }
    if (err !== null) {
      setAddError(`${err.code}: ${err.message}`);
      setAdding(true);
      return;
    }
    setAddError(null);
  };

  /** One button, three jobs, in this order: close an open field; open the picker when there is
   *  one; otherwise reveal the field. */
  const addClick = () => {
    if (adding) {
      setAdding(false);
      setAddError(null);
      return;
    }
    if (onPickProject !== undefined) {
      void pick();
      return;
    }
    setAdding(true);
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
            title={onPickProject !== undefined ? "add a project" : "add a project by path"}
            aria-label={onPickProject !== undefined ? "add a project" : "add a project by path"}
            aria-expanded={adding}
            disabled={picking}
            onClick={addClick}
          >
            <PlusIcon />
          </button>
        </div>

        {adding ? (
          <form
            className="side-add"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
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

        {/* `role="alert"` because this appears in response to an action and says why it failed;
            it is the only thing in the sidebar that must be heard rather than found. */}
        {addError !== null ? (
          <p className="side-add-error" role="alert">
            {addError}
          </p>
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
          // Exactly one element draws this, and it is the `.side-holds` bar in the trailing meta
          // slot below. W4-C2 shipped that bar *and* an accent rail on the row, which is one fact
          // drawn twice, 230px apart; the rail is gone (`src/index.css`, `.side-holds`).
          const holds =
            !open && selectedSessionId !== null && own.includes(selectedSessionId);

          return (
            <div key={p.id} className="side-group">
              <div
                className={
                  selected && selectedSessionId === null ? "side-project selected" : "side-project"
                }
              >
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
                {onReveal !== undefined ? (
                  <button
                    type="button"
                    className="side-reveal"
                    title={`reveal ${p.root_path} in Finder`}
                    aria-label={`reveal ${p.name} in Finder`}
                    onClick={() => onReveal(p.root_path)}
                  >
                    <RevealIcon />
                  </button>
                ) : null}
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
                        onReveal={onReveal}
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
