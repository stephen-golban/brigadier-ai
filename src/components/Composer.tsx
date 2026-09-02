/**
 * Send a turn to the selected session, and the three ways to stop one.
 *
 * Shaped like the ChatGPT macOS composer: a context strip naming the project, the working
 * directory and the model, sitting on a darker rail above a rounded box that holds the text
 * area and one action row. The action row reads left to right as the reference's does: a status
 * chip on the left, then a gap, then the controls and one solid circular send button.
 *
 * `.dock-actions .grow` is that gap; Resume and Clean up worktree sit to the left of it, beside
 * the status chip, and the stop controls stay on the right.
 *
 * Interrupt is graceful and the session survives; End asks the child to exit; Kill takes the
 * process group down and leaves no provider terminal frame behind.
 *
 * Two rules from `docs/plans/ipc-contract.md` are load-bearing here:
 *   - a **resumed** session sits in `starting` until the operator sends the first turn, because
 *     the CLI announces itself once per turn — so `starting` is "ready for input", not "coming
 *     up", and the text area stays enabled for it;
 *   - `resume_session` does **not** restore the permission mode, so a resumed session says so.
 */
import { useEffect, useState } from "react";

import type { SessionRuntime } from "../feedStore";
import type { SessionId, WorktreeCleanup } from "../wire";

export interface ComposerProps {
  session: SessionRuntime | null;
  /** The project the session belongs to, for the context strip. */
  projectName: string | null;
  /** An IPC call started by this dock is in flight; both secondary actions go inert. */
  busy: boolean;
  onSend: (sessionId: SessionId, text: string) => void;
  onInterrupt: (sessionId: SessionId) => void;
  onEnd: (sessionId: SessionId) => void;
  onKill: (sessionId: SessionId) => void;
  onResume: (sessionId: SessionId) => void;
  /** Resolves to the command's answer, or to null when it failed (the caller showed the error). */
  onCleanup: (sessionId: SessionId, force: boolean) => Promise<WorktreeCleanup | null>;
}

/** Last path segment, so a long cwd does not crowd the strip out. Full path stays in `title`. */
function basename(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length === 0 ? path : parts[parts.length - 1]!;
}

export function Composer({
  session,
  projectName,
  busy,
  onSend,
  onInterrupt,
  onEnd,
  onKill,
  onResume,
  onCleanup,
}: ComposerProps) {
  const [text, setText] = useState("");
  /** A `force: false` cleanup came back refusing to discard this many files. */
  const [dirty, setDirty] = useState<WorktreeCleanup | null>(null);
  /** The last successful removal, so the dock can say the checkout is gone and resume is over. */
  const [removed, setRemoved] = useState<WorktreeCleanup | null>(null);

  const sessionId = session?.sessionId ?? null;
  // Both are about one session; switching sessions must not carry either over.
  useEffect(() => {
    setDirty(null);
    setRemoved(null);
  }, [sessionId]);

  const live = session !== null && (session.status === "running" || session.status === "starting");
  const settled = session !== null && (session.status === "exited" || session.status === "failed");

  /** Contract §resume_session: a stored token (the front end sees `provider_session_id`) and a
   *  settled session. A removed worktree takes the `cwd` away, so Resume goes with it. */
  const canResume =
    session !== null &&
    settled &&
    session.providerSessionId !== null &&
    !session.worktreeRemoved &&
    removed === null;

  /** Contract §Worktrees: only a session that is not live and actually has a worktree. */
  const canCleanup =
    session !== null && settled && session.branch !== null && !session.worktreeRemoved && removed === null;

  const runCleanup = async (force: boolean) => {
    if (session === null) return;
    const result = await onCleanup(session.sessionId, force);
    if (result === null) return;
    if (result.removed) {
      setDirty(null);
      setRemoved(result);
    } else {
      setDirty(result);
    }
  };

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

          {/* Secondary action slot, beside the status chip. */}
          {canResume ? (
            <button
              type="button"
              className="act"
              disabled={busy}
              title="continue this conversation in the same session, with a new child process"
              onClick={() => session && onResume(session.sessionId)}
            >
              Resume
            </button>
          ) : null}
          {canCleanup ? (
            <button
              type="button"
              className="act"
              disabled={busy}
              title={session?.worktreePath ?? undefined}
              onClick={() => void runCleanup(false)}
            >
              Clean up worktree
            </button>
          ) : null}

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

      {session !== null && session.resumed && removed === null ? (
        <p className="dock-note">
          Resumed in default permission mode — the mode this session ran in before is not stored
          anywhere and was not restored.
        </p>
      ) : null}

      {dirty !== null ? (
        <p className="dock-note warn">
          {dirty.dirty_files} uncommitted{" "}
          {dirty.dirty_files === 1 ? "change" : "changes"} in{" "}
          <code>{dirty.branch}</code>; nothing was removed. Removing discards them. The branch
          itself survives, but this session can no longer be resumed afterwards.{" "}
          <button type="button" className="act danger" disabled={busy} onClick={() => void runCleanup(true)}>
            Discard {dirty.dirty_files} uncommitted{" "}
            {dirty.dirty_files === 1 ? "change" : "changes"} and remove
          </button>{" "}
          <button type="button" className="act" disabled={busy} onClick={() => setDirty(null)}>
            Keep it
          </button>
        </p>
      ) : null}

      {removed !== null ? (
        <p className="dock-note">
          Worktree removed. The branch <code>{removed.branch}</code> is untouched; this session
          can no longer be resumed.
        </p>
      ) : null}

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
