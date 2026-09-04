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
 *
 * `cleanup_worktree` refuses in six distinguishable ways and this dock is where the operator
 * reads them, so each one gets its own sentence and its own buttons: see `refusalNote` below.
 */
import { useEffect, useState } from "react";

import { ModelIcon, PathIcon, ProjectIcon, SendIcon } from "./icons";
import { runIsLive } from "../wire";
import type { SessionRuntime } from "../feedStore";
import type { PlanId, RunView, SessionId, WorktreeCleanup } from "../wire";

/* ------------------------------------------------------------------ the run
 *
 * Handing the harness a goal and walking away is the whole product (`docs/vision.md` §9), so the
 * control for it sits **where the owner already types** — on the dock, above the composer — and
 * not behind a modal or a menu.
 *
 * It has exactly two states, and the second is the contract's:
 *
 *   - no live run: one field for the goal in plain English, and Start.
 *   - a live run: no field at all, and Stop. `start_run` refuses a second run on the same project
 *     with `run_already_live`, so offering the field again would be offering a button whose only
 *     outcome is an error.
 *
 * **Stop stops dispatching; it does not kill** (`docs/plans/ipc-contract.md` §"The run"). A worker
 * killed mid-order leaves a worktree whose `work_order` intent reconciles to `unknown`, which
 * blocks its phase permanently — so the label says what actually happens rather than promising a
 * halt the harness deliberately will not perform.
 */
export interface RunControlProps {
  /** Named in the placeholder, so the field says which repository it is about to point at. */
  projectName: string | null;
  /** False when there is no project selected, or the `claude` probe failed. */
  canStart: boolean;
  /** The newest plan for the selected project, live or finished, or null. */
  run: RunView | null;
  /** An IPC call started here is in flight. */
  busy: boolean;
  onStart: (goal: string) => void;
  onStop: (planId: PlanId) => void;
}

export function RunControl({ projectName, canStart, run, busy, onStart, onStop }: RunControlProps) {
  const [goal, setGoal] = useState("");
  const live = runIsLive(run);

  const submit = () => {
    if (!canStart || busy || goal.trim() === "") return;
    onStart(goal.trim());
    setGoal("");
  };

  if (live && run !== null) {
    return (
      <section className="run-dock" aria-label="the live run">
        <span className="run-dock-status">Run live</span>
        <span className="run-dock-goal" title={run.goal}>
          {run.goal}
        </span>
        <button
          type="button"
          className="act danger"
          disabled={busy}
          title="stop dispatching new orders; in-flight orders finish and are collected"
          onClick={() => onStop(run.plan_id)}
        >
          Stop run
        </button>
      </section>
    );
  }

  return (
    <section className="run-dock" aria-label="start a run">
      <input
        className="run-dock-input"
        value={goal}
        aria-label="the goal, in plain English"
        placeholder={
          projectName === null
            ? "Select a project to hand it a goal"
            : `Hand ${projectName} a goal in plain English, and walk away`
        }
        disabled={!canStart || busy}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <button
        type="button"
        className="send wide"
        disabled={!canStart || busy || goal.trim() === ""}
        onClick={submit}
      >
        Start run
      </button>
    </section>
  );
}

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
  /** A cleanup came back `removed: false`: nothing was touched, and `blocked` says why. */
  const [refusal, setRefusal] = useState<WorktreeCleanup | null>(null);
  /** The last successful removal, so the dock can say the checkout is gone and resume is over. */
  const [removed, setRemoved] = useState<WorktreeCleanup | null>(null);
  /** `branch_moved` only: the operator acknowledged that the checkout is not what we recorded, so
   *  the force button exists. Forcing past a branch we did not expect is not a one-click action. */
  const [armed, setArmed] = useState(false);

  const sessionId = session?.sessionId ?? null;
  // All three are about one session; switching sessions must not carry any of them over.
  useEffect(() => {
    setRefusal(null);
    setRemoved(null);
    setArmed(false);
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
    setArmed(false);
    if (result.removed) {
      setRefusal(null);
      setRemoved(result);
    } else {
      setRefusal(result);
    }
  };

  const send = () => {
    if (session === null || !live || text.trim() === "") return;
    onSend(session.sessionId, text.trim());
    setText("");
  };

  /* --------------------------------------------------------- the refusal note
   *
   * `cleanup_worktree` refuses six different ways and they are not interchangeable. Three are
   * answered by the same call with `force: true` (`dirty`, `commits`, `branch_moved` — the
   * `!force` guard at `crates/supervisor/src/worktree.rs:483-513`); the other three are refusals
   * `force` does not reach, and offering a force button for one of them is a button that refuses
   * again. Each reason gets its own sentence: a wrong-but-reassuring one over a blocked action is
   * worse than the block.
   */

  const worktreePath = session?.worktreePath ?? null;

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  const verb = (n: number, singular: string, many: string) => (n === 1 ? singular : many);

  const dismissButton = (label: string) => (
    <button type="button" className="act" disabled={busy} onClick={() => setRefusal(null)}>
      {label}
    </button>
  );

  const forceButton = (label: string) => (
    <button
      type="button"
      className="act danger"
      disabled={busy}
      onClick={() => void runCleanup(true)}
    >
      {label}
    </button>
  );

  /** Named wherever the remedy is the operator going and looking at the directory. */
  const atPath =
    worktreePath === null ? null : (
      <>
        {" "}
        It is at <code>{worktreePath}</code>.
      </>
    );

  /** A reason this build has no sentence for. Adding a `CleanupBlocked` variant without adding a
   *  case below is a type error on this call, not a blank line in the dock. */
  const unhandledReason = (blocked: never): string =>
    `Cleanup was refused (${String(blocked)}) and this build has no explanation for that reason.`;

  const refusalNote = (r: WorktreeCleanup) => {
    if (r.blocked === null) {
      // Not a shape the Rust produces today: every `removed: false` carries a reason.
      return <>Nothing was removed, and no reason was reported.</>;
    }
    switch (r.blocked) {
      case "dirty":
        return (
          <>
            Removing deletes {plural(r.dirty_files, "file")} in <code>{r.branch}</code> — the count
            includes ignored files, so <code>.env</code>, build output and{" "}
            <code>node_modules/</code> go with them. Nothing was removed.
            {r.commits > 0 ? (
              <>
                {" "}
                The {plural(r.commits, "commit")} no other ref keeps{" "}
                {verb(r.commits, "stays", "stay")} on the branch.
              </>
            ) : null}{" "}
            The branch <code>{r.branch}</code> survives either way; this session can no longer be
            resumed once the checkout is gone.{" "}
            {forceButton(`Delete ${plural(r.dirty_files, "file")} and remove`)}{" "}
            {dismissButton("Keep it")}
          </>
        );
      case "commits":
        return (
          <>
            Nothing uncommitted, but this worktree holds {plural(r.commits, "commit")} that no other
            branch, tag or remote keeps. Removing the checkout leaves them reachable only from{" "}
            <code>{r.branch}</code>, which survives — delete that branch afterwards and they are
            gone for good. Nothing was removed.{" "}
            {forceButton("Remove the checkout, keep the branch")} {dismissButton("Keep it")}
          </>
        );
      case "branch_moved":
        return (
          <>
            {r.live_branch === null ? (
              <>
                This worktree has a detached <code>HEAD</code>; the session recorded{" "}
                <code>{r.branch}</code>.
              </>
            ) : (
              <>
                <code>{r.live_branch}</code> is checked out here, not the <code>{r.branch}</code>{" "}
                this session recorded.
              </>
            )}{" "}
            Something moved it — the agent switched branches, or the operator did — so what a
            removal would take is not what this session put there. Nothing was removed. Going ahead
            removes the checkout whatever is on it
            {r.dirty_files > 0 ? `, discarding ${plural(r.dirty_files, "file")}` : ""}.
            {r.commits > 0 ? (
              r.live_branch === null ? (
                <>
                  {" "}
                  {plural(r.commits, "commit")} here {verb(r.commits, "is", "are")} kept by no ref
                  at all: remove this and nothing points at {verb(r.commits, "it", "them")} any
                  more.
                </>
              ) : (
                <>
                  {" "}
                  The {plural(r.commits, "commit")} here {verb(r.commits, "stays", "stay")} on{" "}
                  <code>{r.live_branch}</code>, which survives.
                </>
              )
            ) : null}
            {atPath}{" "}
            {armed
              ? forceButton(
                  r.live_branch === null
                    ? "Remove it with a detached HEAD"
                    : `Remove it with ${r.live_branch} checked out`,
                )
              : (
                  <button
                    type="button"
                    className="act"
                    disabled={busy}
                    onClick={() => setArmed(true)}
                  >
                    I have looked at the worktree
                  </button>
                )}{" "}
            {dismissButton("Keep it")}
          </>
        );
      case "locked":
        return (
          <>
            A <code>git worktree lock</code> is held on this worktree — another process's claim on
            it. git refuses to remove a locked worktree and only <code>remove -f -f</code> clears a
            lock, which is not brigadier's to give, so forcing from here would refuse again.
            {atPath} Run <code>git worktree unlock</code> on it yourself once you know nothing is
            using it. Nothing was removed. {dismissButton("Dismiss")}
          </>
        );
      case "unregistered":
        return (
          <>
            git does not register this directory as a worktree of the repository — a hand-deleted
            admin directory, or a prune that ran before a repair. git can neither describe it nor
            remove it in that state, and brigadier does not <code>rm -rf</code> a directory it
            cannot describe, so forcing does not reach this.{atPath} Look at it and delete it
            yourself once you are sure. Nothing was removed. {dismissButton("Dismiss")}
          </>
        );
      case "left_on_disk":
        return (
          <>
            git reported the worktree removed and the directory is still there — the state a
            renamed project folder produces. The registry entry may be gone; the files are not, so
            nothing is being called removed.{atPath} Check it and delete it yourself. There is
            nothing here for force to do. {dismissButton("Dismiss")}
          </>
        );
      default:
        return <>{unhandledReason(r.blocked)}</>;
    }
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
          <span className="glyph">
            <ProjectIcon />
          </span>
          {projectName ?? "no project"}
        </span>
        {session?.cwd != null ? (
          <span title={session.cwd}>
            <span className="glyph">
              <PathIcon />
            </span>
            {basename(session.cwd)}
          </span>
        ) : null}
        {session?.model != null ? (
          <span title={session.model}>
            <span className="glyph">
              <ModelIcon />
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
            <SendIcon />
          </button>
        </div>
      </div>

      {session !== null && session.resumed && removed === null ? (
        <p className="dock-note">
          Resumed in default permission mode — the mode this session ran in before is not stored
          anywhere and was not restored.
        </p>
      ) : null}

      {refusal !== null ? <p className="dock-note warn">{refusalNote(refusal)}</p> : null}

      {removed !== null ? (
        <p className="dock-note">
          Worktree removed. The branch <code>{removed.branch}</code> is untouched; this session
          can no longer be resumed.
        </p>
      ) : null}

      {/*
        No dollar figure. `docs/vision.md` §6 and `CLAUDE.md` §2 both settle this: brigadier runs
        on the user's own subscription, so a per-turn cost in dollars is a number they are never
        billed — a lie in their own favour, and precise to four decimal places about it.
        `session.costUsd` still arrives on the wire and is still stored; it is simply not a thing
        this window tells anyone. What replaces it is the usage-window gauge, which is W2-C's and
        has no data until `rate_limit_event` reaches the front end, so the token counts stay for
        now as the only measure of what a turn spent.
      */}
      {session !== null ? (
        <div className="dock-usage">
          {session.usage.input_tokens} in / {session.usage.output_tokens} out · cache{" "}
          {session.usage.cache_read_tokens} read /{" "}
          {session.usage.cache_creation_tokens} write · rows {session.rowsTotal}
          {session.rowsDropped > 0 ? ` (${session.rowsDropped} dropped)` : ""}
          {session.lastMessage !== null ? ` · ${session.lastMessage}` : ""}
        </div>
      ) : null}
    </section>
  );
}
